import { report_error } from "@/lib/monitoring";
import { NextRequest, NextResponse } from "next/server";
import {
  NEARBY_CORPORATE_RADIUS_METERS,
  SEARCH_RADIUS_METERS,
  type DiscoveryFilters,
  fetch_corporate_location_at_point,
  fetch_discovery_for_centroid,
  fetch_discovery_for_point,
  fetch_market_for_point,
  fetch_neighborhood_centroid,
  type MarketResolution,
  fetch_nearby_independent_alternatives,
  fetch_nearest_corporate_discovery,
  fetch_neighborhood_suggestions,
} from "@/lib/db/proximity";
import { parse_city, parse_vertical } from "@/lib/catalog";
import { GeocoderUnavailableError, geocode_text, looks_like_street_address, type GeocodedPoint } from "@/lib/geocoding";
import { record_proximity_search, type ProximitySearchType } from "@/lib/telemetry";
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

/** Telemetry must never affect the response: the recorder is non-blocking and this guards the call itself. */
function track_search(market_id: string, filters: DiscoveryFilters, search_type: ProximitySearchType): void {
  if (filters.industry_vertical === null) return;
  try {
    record_proximity_search({ market_id, industry_vertical: filters.industry_vertical, search_type });
  } catch {
    // Intentionally ignored.
  }
}

function outside_market_response(market_resolution: MarketResolution): NextResponse<OutsideMarketResponse> {
  const market = market_resolution.closest_active_market;
  return NextResponse.json({
    status: "outside_active_market",
    message: market
      ? `TrueOwn is not active within 50 miles of this location yet. The closest active market is ${market.city_name}.`
      : "TrueOwn has no active markets yet.",
    closest_active_market: market,
  });
}

/**
 * Free-text search. A street address is geocoded; anything else is matched against the
 * official neighborhood boundaries first and geocoded only when that finds nothing.
 * Every resolved point is checked against the active markets before any search runs.
 */
async function handle_text_search(
  search_text: string,
  filters: DiscoveryFilters,
): Promise<NextResponse<ProximityApiResponse>> {
  try {
    if (!looks_like_street_address(search_text)) {
      const centroid = await fetch_neighborhood_centroid(search_text, undefined, filters.city);
      if (centroid) {
        const market_resolution = await fetch_market_for_point(centroid.latitude, centroid.longitude);
        const market = market_resolution.closest_active_market;
        if (!market || !market_resolution.within_market) return outside_market_response(market_resolution);

        const discovery = await fetch_discovery_for_centroid(centroid, undefined, { ...filters, market_id: market.id });
        track_search(market.id, filters, "text_fallback");
        return NextResponse.json({
          origin: {
            kind: "neighborhood",
            neighborhood: centroid.neighborhood,
            latitude: centroid.latitude,
            longitude: centroid.longitude,
          },
          radius_meters: SEARCH_RADIUS_METERS,
          results: discovery.results,
          origin_alternatives: discovery.origin_alternatives,
        });
      }
    }

    let point: GeocodedPoint | null;
    try {
      point = await geocode_text(search_text);
    } catch (caught_error) {
      if (caught_error instanceof GeocoderUnavailableError) {
        console.warn("[proximity] geocoder unavailable:", caught_error.message);
        return error_response("Address lookup is temporarily unavailable. Try a neighborhood name instead.", 503);
      }
      throw caught_error;
    }
    if (!point) {
      return error_response(`No tracked neighborhood or address matches '${search_text}'.`, 404);
    }

    const market_resolution = await fetch_market_for_point(point.latitude, point.longitude);
    const market = market_resolution.closest_active_market;
    if (!market || !market_resolution.within_market) return outside_market_response(market_resolution);

    const discovery = await fetch_discovery_for_point(point.latitude, point.longitude, undefined, {
      ...filters,
      market_id: market.id,
    });
    track_search(market.id, filters, "text_fallback");
    return NextResponse.json({
      origin: { kind: "address", label: search_text, latitude: point.latitude, longitude: point.longitude },
      radius_meters: SEARCH_RADIUS_METERS,
      results: discovery.results,
      origin_alternatives: discovery.origin_alternatives,
    });
  } catch (caught_error) {
    report_error("[proximity] text lookup failed", caught_error);
    return error_response("Unable to complete proximity lookup.", 500);
  }
}

/**
 * GET /api/proximity
 * &vertical=<enum> is REQUIRED for scope=nearest and neighborhood= lookups; &city=<name> is optional.
 * Coordinate modes first resolve the nearest active market; outside 50 miles of every active
 * market the response is { status: "outside_active_market", closest_active_market, message }.
 *   ?suggest=<prefix>         neighborhood lookahead suggestions
 *   ?neighborhood=<text>      text search: a neighborhood name resolves to its polygon centroid; a
 *                             street address (or an unknown name) is geocoded server-side (cached 30
 *                             days). Then the standard 1500m Tier 3 search runs from that point.
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
    const search_text = parse_text_query(raw_neighborhood);
    if (search_text === null) {
      return error_response("Query parameter 'neighborhood' is invalid.", 400);
    }
    const missing_vertical = require_vertical(filters);
    if (missing_vertical) return missing_vertical;
    return handle_text_search(search_text, filters);
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
    if (!market || !market_resolution.within_market) return outside_market_response(market_resolution);
    const market_filters: DiscoveryFilters = { ...filters, market_id: market.id };

    if (scope === "nearest") {
      const results = await fetch_nearest_corporate_discovery(latitude, longitude, undefined, market_filters);
      track_search(market.id, filters, "nearest");
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
