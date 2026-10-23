import type { Pool as PgPool } from "pg";
import { get_database_pool } from "@/lib/db/pool";
import { estimate_walking_minutes } from "@/lib/proximity-format";
import type {
  AlternativeRecommendation,
  CatalogResponse,
  CorporateTarget,
  CorporateTier,
  IndustryVertical,
  MarketStatus,
  MarketSummary,
  NearbyCorporateResult,
} from "@/lib/types";

/** Anything that can run a query: a Pool, or a PoolClient (e.g. inside a role-scoped transaction). */
type Pool = Pick<PgPool, "query">;

/** How far from the user we look for the closest corporate storefronts. */
export const NEARBY_CORPORATE_RADIUS_METERS = 5000;
export const MAX_NEARBY_CORPORATE_RESULTS = 5;

/** Alternatives are only returned within this radius (meters). */
export const SEARCH_RADIUS_METERS = 1500;
/** Max gap between a queried point and a known storefront to count as the same place. */
export const TARGET_MATCH_TOLERANCE_METERS = 50;
export const MAX_RECOMMENDATIONS = 25;
/** A market covers every point within 50 miles of its geographic center. */
export const MARKET_RADIUS_METERS = 80_467;

/**
 * Optional scope for discovery queries. null means "no restriction": a neighborhood
 * search has no brand context, so it spans every vertical unless the user narrows it.
 */
export interface DiscoveryFilters {
  industry_vertical: IndustryVertical | null;
  city: string | null;
  /** Restricts results to one regional market (null = no restriction). */
  market_id: string | null;
}

export const NO_DISCOVERY_FILTERS: DiscoveryFilters = { industry_vertical: null, city: null, market_id: null };

/** A Tier 1/2 storefront resolved from the database. */
export interface CorporateLocationRecord {
  location_id: string;
  brand_name: string;
  corporate_tier: 1 | 2;
  parent_entity: string;
  financial_backers: string[];
  industry_vertical: IndustryVertical;
  market_id: string;
  address: string;
  neighborhood: string | null;
  latitude: number;
  longitude: number;
}

/** Independent alternative enriched with a walking-time estimate for the slider. */
export interface MappedAlternative extends AlternativeRecommendation {
  walking_minutes: number;
  distance_label: string;
}

interface CorporateLocationRow {
  location_id: string;
  brand_name: string;
  corporate_tier: number;
  parent_entity: string;
  financial_backers: string[] | null;
  industry_vertical: IndustryVertical;
  market_id: string;
  address: string;
  neighborhood: string | null;
  latitude: number;
  longitude: number;
}

interface AlternativeRow {
  location_id: string;
  brand_name: string;
  address: string;
  neighborhood: string | null;
  unique_selling_proposition: string | null;
  distance_meters: number;
  latitude: number;
  longitude: number;
}

const CORPORATE_LOCATION_COLUMNS = `
  l.id AS location_id,
  b.name AS brand_name,
  b.corporate_tier,
  b.parent_entity,
  b.financial_backers,
  b.industry_vertical,
  l.market_id,
  l.address,
  l.neighborhood,
  ST_Y(l.coordinates) AS latitude,
  ST_X(l.coordinates) AS longitude`;

function to_corporate_record(row: CorporateLocationRow): CorporateLocationRecord {
  return {
    location_id: row.location_id,
    brand_name: row.brand_name,
    corporate_tier: row.corporate_tier as CorporateTier as 1 | 2,
    parent_entity: row.parent_entity,
    financial_backers: row.financial_backers ?? [],
    industry_vertical: row.industry_vertical,
    market_id: row.market_id,
    address: row.address,
    neighborhood: row.neighborhood,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
  };
}

/** Maps a raw PostGIS row to the shape the frontend slider renders. */
export function map_to_alternative(row: AlternativeRow): MappedAlternative {
  const distance_meters = Math.round(Number(row.distance_meters));
  return {
    location_id: row.location_id,
    brand_name: row.brand_name,
    address: row.address,
    neighborhood: row.neighborhood,
    unique_selling_proposition: row.unique_selling_proposition,
    distance_meters,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    walking_minutes: estimate_walking_minutes(distance_meters),
    distance_label: `${distance_meters}m away`,
  };
}

/**
 * Resolves a Tier 1/2 storefront by a case-insensitive address fragment,
 * e.g. "186 W 4th St". Returns null when nothing (or only Tier 3) matches.
 * Wildcards in the user-supplied fragment are escaped.
 */
export async function fetch_corporate_location_by_address(
  address_fragment: string,
  pool: Pool = get_database_pool(),
): Promise<CorporateLocationRecord | null> {
  const trimmed_fragment = address_fragment.trim();
  if (trimmed_fragment.length === 0) return null;
  const escaped_fragment = trimmed_fragment.replace(/[\\%_]/g, "\\$&");

  const result = await pool.query<CorporateLocationRow>(
    `SELECT ${CORPORATE_LOCATION_COLUMNS}
       FROM locations l
       JOIN brands b ON b.id = l.brand_id
      WHERE b.corporate_tier IN (1, 2)
        AND l.address ILIKE $1
      ORDER BY l.address
      LIMIT 1`,
    [`%${escaped_fragment}%`],
  );
  const row = result.rows[0];
  return row ? to_corporate_record(row) : null;
}

/**
 * Resolves the Tier 1/2 storefront nearest to a point (within tolerance). An optional
 * vertical picks between co-located storefronts of different industries.
 */
export async function fetch_corporate_location_at_point(
  latitude: number,
  longitude: number,
  pool: Pool = get_database_pool(),
  industry_vertical: IndustryVertical | null = null,
): Promise<CorporateLocationRecord | null> {
  const result = await pool.query<CorporateLocationRow>(
    `SELECT ${CORPORATE_LOCATION_COLUMNS}
       FROM locations l
       JOIN brands b ON b.id = l.brand_id
      WHERE b.corporate_tier IN (1, 2)
        AND ($4::industry_vertical IS NULL OR b.industry_vertical = $4::industry_vertical)
        AND ST_DWithin(
              l.coordinates::geography,
              ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
              $3)
      ORDER BY ST_Distance(
              l.coordinates::geography,
              ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography)
      LIMIT 1`,
    [latitude, longitude, TARGET_MATCH_TOLERANCE_METERS, industry_vertical],
  );
  const row = result.rows[0];
  return row ? to_corporate_record(row) : null;
}

/**
 * Core proximity query: Tier 3 locations in the same industry vertical within
 * 1500m of the point, strictly closest first (null vertical = every vertical). Distances are geodesic
 * (ST_Distance on geography, meters), not routed street distance.
 */
export async function fetch_nearby_independent_alternatives(
  latitude: number,
  longitude: number,
  industry_vertical: IndustryVertical | null,
  pool: Pool = get_database_pool(),
  market_id: string | null = null,
): Promise<MappedAlternative[]> {
  const result = await pool.query<AlternativeRow>(
    `SELECT l.id AS location_id,
            b.name AS brand_name,
            l.address,
            l.neighborhood,
            b.unique_selling_proposition,
            ST_Distance(
              l.coordinates::geography,
              ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) AS distance_meters,
            ST_Y(l.coordinates) AS latitude,
            ST_X(l.coordinates) AS longitude
       FROM locations l
       JOIN brands b ON b.id = l.brand_id
      WHERE b.corporate_tier = 3
        AND ($3::industry_vertical IS NULL OR b.industry_vertical = $3::industry_vertical)
        AND ($6::uuid IS NULL OR l.market_id = $6::uuid)
        AND ST_DWithin(
              l.coordinates::geography,
              ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
              $4)
      ORDER BY distance_meters ASC
      LIMIT $5`,
    [latitude, longitude, industry_vertical, SEARCH_RADIUS_METERS, MAX_RECOMMENDATIONS, market_id],
  );
  return result.rows.map(map_to_alternative);
}

/**
 * One-call convenience for the UI flow: user selects a corporate storefront
 * by address -> returns the storefront plus its nearest independents.
 */
export async function fetch_alternatives_for_corporate_address(
  address_fragment: string,
  pool: Pool = get_database_pool(),
): Promise<{ target: CorporateLocationRecord; alternatives: MappedAlternative[] } | null> {
  const target = await fetch_corporate_location_by_address(address_fragment, pool);
  if (!target) return null;
  const alternatives = await fetch_nearby_independent_alternatives(
    target.latitude,
    target.longitude,
    target.industry_vertical,
    pool,
  );
  return { target, alternatives };
}

interface CorporateCandidate {
  record: CorporateLocationRecord;
  distance_meters: number | null;
}

function to_corporate_target(candidate: CorporateCandidate): CorporateTarget {
  const { record } = candidate;
  return {
    location_id: record.location_id,
    brand_name: record.brand_name,
    corporate_tier: record.corporate_tier,
    parent_entity: record.parent_entity,
    financial_backers: record.financial_backers,
    address: record.address,
    neighborhood: record.neighborhood,
    latitude: record.latitude,
    longitude: record.longitude,
    distance_meters: candidate.distance_meters,
  };
}

/** Pairs each corporate storefront with its own independents (each <= 1500m away). */
async function attach_independent_alternatives(
  candidates: CorporateCandidate[],
  pool: Pool,
): Promise<NearbyCorporateResult[]> {
  const results: NearbyCorporateResult[] = [];
  // Sequential: callers may pass a single PoolClient, which cannot run queries concurrently.
  for (const candidate of candidates) {
    results.push({
      target: to_corporate_target(candidate),
      alternatives: await fetch_nearby_independent_alternatives(
        candidate.record.latitude,
        candidate.record.longitude,
        candidate.record.industry_vertical,
        pool,
        candidate.record.market_id,
      ),
    });
  }
  return results;
}

/**
 * Closest Tier 1/2 storefronts to the user's physical position (nearest first),
 * each with its Tier 3 alternatives.
 */
export async function fetch_nearest_corporate_discovery(
  latitude: number,
  longitude: number,
  pool: Pool = get_database_pool(),
  filters: DiscoveryFilters = NO_DISCOVERY_FILTERS,
): Promise<NearbyCorporateResult[]> {
  const result = await pool.query<CorporateLocationRow & { distance_meters: number }>(
    `SELECT ${CORPORATE_LOCATION_COLUMNS},
            ST_Distance(
              l.coordinates::geography,
              ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) AS distance_meters
       FROM locations l
       JOIN brands b ON b.id = l.brand_id
      WHERE b.corporate_tier IN (1, 2)
        AND ($5::industry_vertical IS NULL OR b.industry_vertical = $5::industry_vertical)
        AND ($6::text IS NULL OR l.city = $6)
        AND ($7::uuid IS NULL OR l.market_id = $7::uuid)
        AND ST_DWithin(
              l.coordinates::geography,
              ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
              $3)
      ORDER BY distance_meters ASC
      LIMIT $4`,
    [
      latitude,
      longitude,
      NEARBY_CORPORATE_RADIUS_METERS,
      MAX_NEARBY_CORPORATE_RESULTS,
      filters.industry_vertical,
      filters.city,
      filters.market_id,
    ],
  );
  return attach_independent_alternatives(
    result.rows.map((row) => ({
      record: to_corporate_record(row),
      distance_meters: Math.round(Number(row.distance_meters)),
    })),
    pool,
  );
}

/**
 * Tier 1/2 storefronts in a neighborhood. With boundary ids the match is spatial
 * (storefront point inside the polygons); without them it falls back to the
 * case-insensitive neighborhood label stored on each location.
 */
export async function fetch_neighborhood_corporate_discovery(
  neighborhood: string,
  pool: Pick<PgPool, "query"> = get_database_pool(),
  boundary_ids: string[] = [],
  filters: DiscoveryFilters = NO_DISCOVERY_FILTERS,
): Promise<NearbyCorporateResult[]> {
  const spatial = boundary_ids.length > 0;
  const neighborhood_filter = spatial
    ? `EXISTS (SELECT 1 FROM neighborhood_boundaries nb
                WHERE nb.id = ANY($1::uuid[]) AND ST_Covers(nb.geometry, l.coordinates))`
    : "lower(l.neighborhood) = lower($1)";
  const result = await pool.query<CorporateLocationRow>(
    `SELECT ${CORPORATE_LOCATION_COLUMNS}
       FROM locations l
       JOIN brands b ON b.id = l.brand_id
      WHERE b.corporate_tier IN (1, 2)
        AND ($3::industry_vertical IS NULL OR b.industry_vertical = $3::industry_vertical)
        AND ($4::text IS NULL OR l.city = $4)
        AND ($5::uuid IS NULL OR l.market_id = $5::uuid)
        AND ${neighborhood_filter}
      ORDER BY b.name, l.address
      LIMIT $2`,
    [spatial ? boundary_ids : neighborhood, MAX_NEARBY_CORPORATE_RESULTS, filters.industry_vertical, filters.city, filters.market_id],
  );
  return attach_independent_alternatives(
    result.rows.map((row) => ({ record: to_corporate_record(row), distance_meters: null })),
    pool,
  );
}

interface MarketRow {
  id: string;
  city_name: string;
  status: MarketStatus;
  latitude: number;
  longitude: number;
  distance_meters: number;
}

export interface MarketResolution {
  /** The closest active market (null only when no market is active). */
  closest_active_market: MarketSummary | null;
  /** True when the point is within MARKET_RADIUS_METERS (50 miles) of that market. */
  within_market: boolean;
}

/**
 * Finds the closest ACTIVE market to a point and whether the point lies inside its
 * 50-mile radius. Run before any local proximity search.
 */
export async function fetch_market_for_point(
  latitude: number,
  longitude: number,
  pool: Pool = get_database_pool(),
): Promise<MarketResolution> {
  const result = await pool.query<MarketRow>(
    `SELECT id, city_name, status,
            ST_Y(geographic_center) AS latitude,
            ST_X(geographic_center) AS longitude,
            ST_Distance(
              geographic_center::geography,
              ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) AS distance_meters
       FROM markets
      WHERE status = 'active'
      ORDER BY distance_meters ASC
      LIMIT 1`,
    [latitude, longitude],
  );
  const row = result.rows[0];
  if (!row) return { closest_active_market: null, within_market: false };
  const closest_active_market: MarketSummary = {
    id: row.id,
    city_name: row.city_name,
    status: row.status,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    distance_meters: Math.round(Number(row.distance_meters)),
  };
  return {
    closest_active_market,
    within_market: closest_active_market.distance_meters <= MARKET_RADIUS_METERS,
  };
}

/** Cities and verticals that have at least one tracked storefront (drives the UI selectors). */
export async function fetch_catalog(pool: Pool = get_database_pool()): Promise<CatalogResponse> {
  const [cities, verticals] = await Promise.all([
    pool.query<{ city: string }>("SELECT DISTINCT city FROM locations ORDER BY city"),
    pool.query<{ industry_vertical: IndustryVertical }>(
      `SELECT DISTINCT b.industry_vertical
         FROM brands b
         JOIN locations l ON l.brand_id = b.id
        ORDER BY b.industry_vertical`,
    ),
  ]);
  return {
    cities: cities.rows.map((row) => row.city),
    verticals: verticals.rows.map((row) => row.industry_vertical),
  };
}

/** Distinct neighborhoods with at least one tracked storefront, for the fallback menu. */
export async function fetch_neighborhoods(
  pool: Pool = get_database_pool(),
  city: string | null = null,
): Promise<string[]> {
  const result = await pool.query<{ neighborhood: string }>(
    `SELECT DISTINCT neighborhood
       FROM locations
      WHERE neighborhood IS NOT NULL
        AND ($1::text IS NULL OR city = $1)
      ORDER BY neighborhood`,
    [city],
  );
  return result.rows.map((row) => row.neighborhood);
}

export const MAX_NEIGHBORHOOD_SUGGESTIONS = 8;

export interface NeighborhoodCentroid {
  neighborhood: string;
  latitude: number;
  longitude: number;
  /** 'boundary' = ST_Centroid of official polygons; 'locations' = fallback for cities without boundaries. */
  source: "boundary" | "locations";
  boundary_ids: string[];
}

export interface NeighborhoodDiscovery {
  centroid: NeighborhoodCentroid;
  results: NearbyCorporateResult[];
  origin_alternatives: MappedAlternative[];
}

/** Terms shorter than this only ever match a full neighborhood name. */
export const MIN_PARTIAL_NEIGHBORHOOD_TERM_LENGTH = 3;
/**
 * Partial matches spanning more than this are ambiguous (e.g. "park"): better to
 * return "unknown" than a meaningless point of origin in the middle of nowhere.
 */
export const MAX_NEIGHBORHOOD_SPAN_METERS = 8000;

interface BoundaryCentroidRow {
  boundary_ids: string[];
  display_name: string;
  latitude: number;
  longitude: number;
  span_meters: number;
}

/**
 * Resolves a typed neighborhood to polygon geometry. NTA names are compound
 * ("Upper East Side-Carnegie Hill"), so matching runs in two tiers:
 *   1. exact name (case-insensitive);
 *   2. the term at the start of the name or of any word after a space or hyphen.
 * All polygons in the winning tier (limited to one city + borough) are combined
 * and ST_Centroid is computed over them on demand. No LIKE/regex is used, so user
 * input can never act as a wildcard.
 */
async function fetch_boundary_centroid(
  neighborhood: string,
  pool: Pick<PgPool, "query">,
  city: string | null,
): Promise<NeighborhoodCentroid | null> {
  const result = await pool.query<BoundaryCentroidRow>(
    `WITH term AS (SELECT lower(btrim($1)) AS t),
     positions AS (
       SELECT b.id, b.name, b.city, b.borough, b.geometry, term.t,
              CASE
                WHEN starts_with(lower(b.name), term.t) THEN 1
                WHEN strpos(lower(b.name), ' ' || term.t) > 0 THEN strpos(lower(b.name), ' ' || term.t) + 1
                WHEN strpos(lower(b.name), '-' || term.t) > 0 THEN strpos(lower(b.name), '-' || term.t) + 1
              END AS match_pos
         FROM neighborhood_boundaries b CROSS JOIN term
        WHERE ($3::text IS NULL OR b.city = $3)
     ),
     matched AS (
       SELECT p.*,
              CASE
                WHEN lower(p.name) = p.t THEN 1
                WHEN p.match_pos IS NOT NULL AND length(p.t) >= $2 THEN 2
              END AS match_rank
         FROM positions p
     ),
     best AS (SELECT min(match_rank) AS match_rank FROM matched),
     tier AS (SELECT m.* FROM matched m JOIN best USING (match_rank)),
     region AS (
       SELECT city, borough FROM tier
        GROUP BY city, borough ORDER BY count(*) DESC, city, borough LIMIT 1
     ),
     chosen AS (
       SELECT t.* FROM tier t
         JOIN region r ON t.city = r.city AND t.borough IS NOT DISTINCT FROM r.borough
     ),
     combined AS (
       SELECT array_agg(id ORDER BY name) AS boundary_ids,
              (array_agg(substr(name, match_pos, length(t)) ORDER BY name))[1] AS display_name,
              min(match_rank) AS match_rank,
              ST_Collect(geometry) AS geom
         FROM chosen
     ),
     labelled AS (
       -- A centroid can fall outside a concave or multi-part shape; use a point
       -- guaranteed to lie inside the polygons in that case.
       SELECT combined.*,
              CASE WHEN ST_Covers(geom, ST_Centroid(geom)) THEN ST_Centroid(geom)
                   ELSE ST_PointOnSurface(geom) END AS label_point
         FROM combined
     )
     SELECT boundary_ids,
            display_name,
            ST_Y(label_point) AS latitude,
            ST_X(label_point) AS longitude,
            CASE WHEN match_rank = 1 THEN 0 ELSE
              ST_Distance(
                ST_SetSRID(ST_MakePoint(ST_XMin(geom), ST_YMin(geom)), 4326)::geography,
                ST_SetSRID(ST_MakePoint(ST_XMax(geom), ST_YMax(geom)), 4326)::geography)
            END AS span_meters
       FROM labelled
      WHERE boundary_ids IS NOT NULL`,
    [neighborhood, MIN_PARTIAL_NEIGHBORHOOD_TERM_LENGTH, city],
  );
  const row = result.rows[0];
  if (!row || Number(row.span_meters) > MAX_NEIGHBORHOOD_SPAN_METERS) return null;
  return {
    neighborhood: row.display_name,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    source: "boundary",
    boundary_ids: row.boundary_ids,
  };
}

/**
 * Centroid of a typed neighborhood. Prefers the official boundary polygons;
 * for cities without boundaries loaded it falls back to the centroid of the
 * tracked storefronts carrying that neighborhood label. Null when unknown.
 */
export async function fetch_neighborhood_centroid(
  neighborhood: string,
  pool: Pick<PgPool, "query"> = get_database_pool(),
  city: string | null = null,
): Promise<NeighborhoodCentroid | null> {
  const from_boundary = await fetch_boundary_centroid(neighborhood, pool, city);
  if (from_boundary) return from_boundary;

  const result = await pool.query<{
    neighborhood: string;
    latitude: number | null;
    longitude: number | null;
  }>(
    `SELECT min(l.neighborhood) AS neighborhood,
            ST_Y(ST_Centroid(ST_Collect(l.coordinates))) AS latitude,
            ST_X(ST_Centroid(ST_Collect(l.coordinates))) AS longitude
       FROM locations l
      WHERE lower(l.neighborhood) = lower($1)
        AND ($2::text IS NULL OR l.city = $2)`,
    [neighborhood, city],
  );
  const row = result.rows[0];
  if (!row || row.latitude === null || row.longitude === null) return null;
  return {
    neighborhood: row.neighborhood,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    source: "locations",
    boundary_ids: [],
  };
}

/**
 * Text-search entry point: resolve the neighborhood's centroid, then run the
 * standard 1500m Tier 3 proximity query from that point of origin.
 */
export async function fetch_neighborhood_discovery(
  neighborhood: string,
  pool: Pool = get_database_pool(),
  filters: DiscoveryFilters = NO_DISCOVERY_FILTERS,
): Promise<NeighborhoodDiscovery | null> {
  const centroid = await fetch_neighborhood_centroid(neighborhood, pool, filters.city);
  if (!centroid) return null;
  return fetch_discovery_for_centroid(centroid, pool, filters);
}

/** Runs the standard 1500m search plus the neighborhood's corporate brands from a resolved centroid. */
export async function fetch_discovery_for_centroid(
  centroid: NeighborhoodCentroid,
  pool: Pool = get_database_pool(),
  filters: DiscoveryFilters = NO_DISCOVERY_FILTERS,
): Promise<NeighborhoodDiscovery> {
  const origin_alternatives = await fetch_nearby_independent_alternatives(
    centroid.latitude,
    centroid.longitude,
    filters.industry_vertical,
    pool,
    filters.market_id,
  );
  const results = await fetch_neighborhood_corporate_discovery(
    centroid.neighborhood,
    pool,
    centroid.boundary_ids,
    filters,
  );
  return { centroid, results, origin_alternatives };
}

/**
 * Free-text address search: the nearest corporate storefronts and the independents around
 * an arbitrary (geocoded) point, both isolated to the market and vertical in `filters`.
 */
export async function fetch_discovery_for_point(
  latitude: number,
  longitude: number,
  pool: Pool = get_database_pool(),
  filters: DiscoveryFilters = NO_DISCOVERY_FILTERS,
): Promise<Pick<NeighborhoodDiscovery, "results" | "origin_alternatives">> {
  const origin_alternatives = await fetch_nearby_independent_alternatives(
    latitude,
    longitude,
    filters.industry_vertical,
    pool,
    filters.market_id,
  );
  const results = await fetch_nearest_corporate_discovery(latitude, longitude, pool, filters);
  return { results, origin_alternatives };
}

/**
 * Lookahead over neighborhood names: tracked storefront labels first, then
 * official boundary names (matched at the start of the name or of a later word).
 * Plain string functions are used, so wildcard characters in input match nothing.
 */
export async function fetch_neighborhood_suggestions(
  prefix: string,
  pool: Pick<PgPool, "query"> = get_database_pool(),
  city: string | null = null,
): Promise<string[]> {
  const term = prefix.trim().toLowerCase();
  if (term.length === 0) return [];

  const result = await pool.query<{ name: string }>(
    `SELECT name
       FROM (
         SELECT neighborhood AS name, 0 AS priority
           FROM locations
          WHERE neighborhood IS NOT NULL AND starts_with(lower(neighborhood), $1)
            AND ($4::text IS NULL OR city = $4)
         UNION ALL
         SELECT name, 1
           FROM neighborhood_boundaries
          WHERE ($4::text IS NULL OR city = $4)
            AND (starts_with(lower(name), $1)
                 OR (length($1) >= $3
                     AND (strpos(lower(name), ' ' || $1) > 0 OR strpos(lower(name), '-' || $1) > 0)))
       ) matches
      GROUP BY name
      ORDER BY min(priority), name
      LIMIT $2`,
    [term, MAX_NEIGHBORHOOD_SUGGESTIONS, MIN_PARTIAL_NEIGHBORHOOD_TERM_LENGTH, city],
  );
  return result.rows.map((row) => row.name);
}
