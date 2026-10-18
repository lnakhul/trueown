import { NextRequest, NextResponse } from "next/server";
import {
  NEARBY_CORPORATE_RADIUS_METERS,
  SEARCH_RADIUS_METERS,
  fetch_corporate_location_at_point,
  fetch_nearby_independent_alternatives,
  fetch_nearest_corporate_discovery,
  fetch_neighborhood_corporate_discovery,
} from "@/lib/db/proximity";
import type { ApiErrorResponse, NearbyResponse, ProximityResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

const MAX_NEIGHBORHOOD_LENGTH = 100;

/** Strictly parses a finite coordinate within [min, max]; returns null otherwise. */
function parse_coordinate(raw_value: string | null, min: number, max: number): number | null {
  if (raw_value === null || raw_value.trim() === "") return null;
  const parsed_value = Number(raw_value);
  if (!Number.isFinite(parsed_value) || parsed_value < min || parsed_value > max) return null;
  return parsed_value;
}

function error_response(message: string, status: number): NextResponse<ApiErrorResponse> {
  return NextResponse.json({ error: message }, { status });
}

/**
 * GET /api/proximity
 *   ?lat&lng                  exact storefront at the point -> its Tier 3 alternatives
 *   ?lat&lng&scope=nearest    closest Tier 1/2 storefronts to the user + alternatives
 *   ?neighborhood=<name>      Tier 1/2 storefronts in a neighborhood + alternatives
 * Alternatives are always Tier 3, same industry vertical, <= 1500m, closest first.
 */
export async function GET(
  request: NextRequest,
): Promise<NextResponse<ProximityResponse | NearbyResponse | ApiErrorResponse>> {
  const { searchParams } = request.nextUrl;

  const raw_neighborhood = searchParams.get("neighborhood");
  if (raw_neighborhood !== null) {
    const neighborhood = raw_neighborhood.trim();
    if (neighborhood.length === 0 || neighborhood.length > MAX_NEIGHBORHOOD_LENGTH) {
      return error_response("Query parameter 'neighborhood' is invalid.", 400);
    }
    try {
      const results = await fetch_neighborhood_corporate_discovery(neighborhood);
      return NextResponse.json({
        origin: { kind: "neighborhood", neighborhood },
        radius_meters: SEARCH_RADIUS_METERS,
        results,
      });
    } catch (caught_error) {
      console.error("[proximity] neighborhood lookup failed:", caught_error);
      return error_response("Unable to complete proximity lookup.", 500);
    }
  }

  const latitude = parse_coordinate(searchParams.get("lat"), -90, 90);
  const longitude = parse_coordinate(searchParams.get("lng"), -180, 180);

  if (latitude === null || longitude === null) {
    return error_response("Query parameters 'lat' and 'lng' must be valid coordinates.", 400);
  }

  const scope = searchParams.get("scope");
  if (scope !== null && scope !== "nearest") {
    return error_response("Query parameter 'scope' must be 'nearest' when provided.", 400);
  }

  try {
    if (scope === "nearest") {
      const results = await fetch_nearest_corporate_discovery(latitude, longitude);
      return NextResponse.json({
        origin: { kind: "coordinates", latitude, longitude },
        radius_meters: NEARBY_CORPORATE_RADIUS_METERS,
        results,
      });
    }

    const target = await fetch_corporate_location_at_point(latitude, longitude);
    if (!target) {
      return error_response("No Tier 1 or Tier 2 brand location found at these coordinates.", 404);
    }

    const alternatives = await fetch_nearby_independent_alternatives(
      latitude,
      longitude,
      target.industry_vertical,
    );

    return NextResponse.json({
      target_brand_name: target.brand_name,
      target_corporate_tier: target.corporate_tier,
      industry_vertical: target.industry_vertical,
      radius_meters: SEARCH_RADIUS_METERS,
      alternatives,
    });
  } catch (caught_error) {
    // Log details server-side only; never leak internals to the client.
    console.error("[proximity] lookup failed:", caught_error);
    return error_response("Unable to complete proximity lookup.", 500);
  }
}
