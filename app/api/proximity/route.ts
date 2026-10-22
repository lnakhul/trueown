import { report_error } from "@/lib/monitoring";
import { NextRequest, NextResponse } from "next/server";
import {
  NEARBY_CORPORATE_RADIUS_METERS,
  SEARCH_RADIUS_METERS,
  type DiscoveryFilters,
  fetch_corporate_location_at_point,
  fetch_market_for_point,
  fetch_nearby_independent_alternatives,
  fetch_nearest_corporate_discovery,
  fetch_neighborhood_discovery,
  fetch_neighborhood_suggestions,
} from "@/lib/db/proximity";
import { parse_city, parse_vertical } from "@/lib/catalog";
import type {
  ApiErrorResponse,
  NearbyResponse,
  NeighborhoodSuggestionsResponse,
  OutsideMarketResponse,
  ProximityResponse,
} from "@/lib/types";

export const dynamic = "force-dynamic";

const MAX_TEXT_QUERY_LENGTH = 100;

type ProximityApiResponse =
  | ProximityResponse
  | NearbyResponse
  | NeighborhoodSuggestionsResponse
  | OutsideMarketResponse
  | ApiErrorResponse;

/** Strictly parses a finite coordinate within [min, max]; returns null otherwise. */
function parse_coordinate(raw_value: string | null, min: number, max: number): number | null {
  if (raw_value === null || raw_value.trim() === "") return null;
  const parsed_value = Number(raw_value);
  if (!Number.isFinite(parsed_value) || parsed_value < min || parsed_value > max) return null;
  return parsed_value;
}

/** Trims and bounds a free-text query parameter; null means invalid. */
function parse_text_query(raw_value: string): string | null {
  const trimmed_value = raw_value.trim();
  if (trimmed_value.length === 0 || trimmed_value.length > MAX_TEXT_QUERY_LENGTH) return null;
  return trimmed_value;
}

/**
 * Reads the optional `vertical` and `city` scope. A parameter that is present but
 * malformed is a client error (never silently widened to "everything").
 */
function parse_filters(search_params: URLSearchParams): DiscoveryFilters | NextResponse<ApiErrorResponse> {
  const raw_vertical = search_params.get("vertical");
  const industry_vertical = parse_vertical(raw_vertical);
  if (raw_vertical !== null && industry_vertical === null) {
    return error_response("Query parameter 'vertical' is not a known industry vertical.", 400);
  }
  const raw_city = search_params.get("city");
  const city = parse_city(raw_city);
  if (raw_city !== null && city === null) {
    return error_response("Query parameter 'city' is invalid.", 400);
  }
  return { industry_vertical, city, market_id: null };
}

/**
 * Discovery modes that start from a location (not a known brand) must name the
 * industry vertical, so a search near a gym or bar can never return bakeries.
 */
function require_vertical(filters: DiscoveryFilters): NextResponse<ApiErrorResponse> | null {
  if (filters.industry_vertical !== null) return null;
  return error_response(
    "Query parameter 'vertical' is required and must be a known industry vertical.",
    400,
  );
}

function error_response(message: string, status: number): NextResponse<ApiErrorResponse> {
  return NextResponse.json({ error: message }, { status });
}

/**
 * GET /api/proximity
 * &vertical=<enum> is REQUIRED for scope=nearest and neighborhood= lookups; &city=<name> is optional.
 * Coordinate modes first resolve the nearest active market; outside 50 miles of every active
 * market the response is { status: "outside_active_market", closest_active_market, message }.
 *   ?suggest=<prefix>         neighborhood lookahead suggestions
 *   ?neighborhood=<name>      text fallback: resolve the neighborhood centroid, then run the
 *                             standard 1500m Tier 3 search from it (plus its corporate brands)
 *   ?lat&lng&scope=nearest    closest Tier 1/2 storefronts to the user + alternatives
 *   ?lat&lng                  exact storefront at the point -> its Tier 3 alternatives
 * Alternatives are always Tier 3, same industry vertical, <= 1500m, closest first.
 */
export async function GET(
  request: NextRequest,
): Promise<NextResponse<ProximityApiResponse>> {
  const { searchParams } = request.nextUrl;
  const filters = parse_filters(searchParams);
  if (filters instanceof NextResponse) return filters;

  const raw_suggest = searchParams.get("suggest");
  if (raw_suggest !== null) {
    const prefix = parse_text_query(raw_suggest);
    if (prefix === null) {
      return error_response("Query parameter 'suggest' is invalid.", 400);
    }
    try {
      const suggestions = await fetch_neighborhood_suggestions(prefix, undefined, filters.city);
      return NextResponse.json({ suggestions });
    } catch (caught_error) {
      report_error("[proximity] suggestion lookup failed", caught_error);
      return error_response("Unable to complete proximity lookup.", 500);
    }
  }

  const raw_neighborhood = searchParams.get("neighborhood");
  if (raw_neighborhood !== null) {
    const neighborhood = parse_text_query(raw_neighborhood);
    if (neighborhood === null) {
      return error_response("Query parameter 'neighborhood' is invalid.", 400);
    }
    const missing_vertical = require_vertical(filters);
    if (missing_vertical) return missing_vertical;
    try {
      const discovery = await fetch_neighborhood_discovery(neighborhood, undefined, filters);
      if (!discovery) {
        return error_response(`No tracked neighborhood matches '${neighborhood}'.`, 404);
      }
      return NextResponse.json({
        origin: {
          kind: "neighborhood",
          neighborhood: discovery.centroid.neighborhood,
          latitude: discovery.centroid.latitude,
          longitude: discovery.centroid.longitude,
        },
        radius_meters: SEARCH_RADIUS_METERS,
        results: discovery.results,
        origin_alternatives: discovery.origin_alternatives,
      });
    } catch (caught_error) {
      report_error("[proximity] neighborhood lookup failed", caught_error);
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

  if (scope === "nearest") {
    const missing_vertical = require_vertical(filters);
    if (missing_vertical) return missing_vertical;
  }

  try {
    // Resolve the regional market first: every search below is isolated to it.
    const market_resolution = await fetch_market_for_point(latitude, longitude);
    const market = market_resolution.closest_active_market;
    if (!market || !market_resolution.within_market) {
      return NextResponse.json({
        status: "outside_active_market",
        message: market
          ? `TrueOwn is not active within 50 miles of this location yet. The closest active market is ${market.city_name}.`
          : "TrueOwn has no active markets yet.",
        closest_active_market: market,
      });
    }
    const market_filters: DiscoveryFilters = { ...filters, market_id: market.id };

    if (scope === "nearest") {
      const results = await fetch_nearest_corporate_discovery(latitude, longitude, undefined, market_filters);
      return NextResponse.json({
        origin: { kind: "coordinates", latitude, longitude },
        radius_meters: NEARBY_CORPORATE_RADIUS_METERS,
        results,
        origin_alternatives: [],
      });
    }

    const target = await fetch_corporate_location_at_point(
      latitude,
      longitude,
      undefined,
      filters.industry_vertical,
    );
    if (!target) {
      return error_response("No Tier 1 or Tier 2 brand location found at these coordinates.", 404);
    }

    const alternatives = await fetch_nearby_independent_alternatives(
      latitude,
      longitude,
      target.industry_vertical,
      undefined,
      target.market_id,
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
    report_error("[proximity] lookup failed", caught_error);
    return error_response("Unable to complete proximity lookup.", 500);
  }
}
