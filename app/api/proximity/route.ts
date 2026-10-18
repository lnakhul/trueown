import { NextRequest, NextResponse } from "next/server";
import {
  SEARCH_RADIUS_METERS,
  fetch_corporate_location_at_point,
  fetch_nearby_independent_alternatives,
} from "@/lib/db/proximity";
import type { ApiErrorResponse, ProximityResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

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
 * GET /api/proximity?lat=<number>&lng=<number>
 * Resolves the storefront at the given point; if it is Tier 1/2, returns Tier 3
 * independents of the same industry vertical within 1500m, closest first.
 */
export async function GET(
  request: NextRequest,
): Promise<NextResponse<ProximityResponse | ApiErrorResponse>> {
  const { searchParams } = request.nextUrl;
  const latitude = parse_coordinate(searchParams.get("lat"), -90, 90);
  const longitude = parse_coordinate(searchParams.get("lng"), -180, 180);

  if (latitude === null || longitude === null) {
    return error_response("Query parameters 'lat' and 'lng' must be valid coordinates.", 400);
  }

  try {
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
