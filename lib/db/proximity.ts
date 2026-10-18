import type { Pool as PgPool } from "pg";
import { get_database_pool } from "@/lib/db/pool";
import type {
  AlternativeRecommendation,
  CorporateTarget,
  CorporateTier,
  IndustryVertical,
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
/** Standard average walking pace (~4.8 km/h) used for the display estimate only. */
const WALKING_METERS_PER_MINUTE = 80;

/** A Tier 1/2 storefront resolved from the database. */
export interface CorporateLocationRecord {
  location_id: string;
  brand_name: string;
  corporate_tier: 1 | 2;
  parent_entity: string;
  industry_vertical: IndustryVertical;
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
  industry_vertical: IndustryVertical;
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
  b.industry_vertical,
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
    industry_vertical: row.industry_vertical,
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
    walking_minutes: Math.max(1, Math.ceil(distance_meters / WALKING_METERS_PER_MINUTE)),
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

/** Resolves the Tier 1/2 storefront nearest to a point (within tolerance). */
export async function fetch_corporate_location_at_point(
  latitude: number,
  longitude: number,
  pool: Pool = get_database_pool(),
): Promise<CorporateLocationRecord | null> {
  const result = await pool.query<CorporateLocationRow>(
    `SELECT ${CORPORATE_LOCATION_COLUMNS}
       FROM locations l
       JOIN brands b ON b.id = l.brand_id
      WHERE b.corporate_tier IN (1, 2)
        AND ST_DWithin(
              l.coordinates::geography,
              ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
              $3)
      ORDER BY ST_Distance(
              l.coordinates::geography,
              ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography)
      LIMIT 1`,
    [latitude, longitude, TARGET_MATCH_TOLERANCE_METERS],
  );
  const row = result.rows[0];
  return row ? to_corporate_record(row) : null;
}

/**
 * Core proximity query: Tier 3 locations in the same industry vertical within
 * 1500m of the point, strictly closest first. Distances are geodesic
 * (ST_Distance on geography, meters), not routed street distance.
 */
export async function fetch_nearby_independent_alternatives(
  latitude: number,
  longitude: number,
  industry_vertical: IndustryVertical,
  pool: Pool = get_database_pool(),
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
        AND b.industry_vertical = $3
        AND ST_DWithin(
              l.coordinates::geography,
              ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
              $4)
      ORDER BY distance_meters ASC
      LIMIT $5`,
    [latitude, longitude, industry_vertical, SEARCH_RADIUS_METERS, MAX_RECOMMENDATIONS],
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
): Promise<NearbyCorporateResult[]> {
  const result = await pool.query<CorporateLocationRow & { distance_meters: number }>(
    `SELECT ${CORPORATE_LOCATION_COLUMNS},
            ST_Distance(
              l.coordinates::geography,
              ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) AS distance_meters
       FROM locations l
       JOIN brands b ON b.id = l.brand_id
      WHERE b.corporate_tier IN (1, 2)
        AND ST_DWithin(
              l.coordinates::geography,
              ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
              $3)
      ORDER BY distance_meters ASC
      LIMIT $4`,
    [latitude, longitude, NEARBY_CORPORATE_RADIUS_METERS, MAX_NEARBY_CORPORATE_RESULTS],
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
        AND ${neighborhood_filter}
      ORDER BY b.name, l.address
      LIMIT $2`,
    [spatial ? boundary_ids : neighborhood, MAX_NEARBY_CORPORATE_RESULTS],
  );
  return attach_independent_alternatives(
    result.rows.map((row) => ({ record: to_corporate_record(row), distance_meters: null })),
    pool,
  );
}

/** Distinct neighborhoods with at least one tracked storefront, for the fallback menu. */
export async function fetch_neighborhoods(pool: Pool = get_database_pool()): Promise<string[]> {
  const result = await pool.query<{ neighborhood: string }>(
    `SELECT DISTINCT neighborhood
       FROM locations
      WHERE neighborhood IS NOT NULL
      ORDER BY neighborhood`,
  );
  return result.rows.map((row) => row.neighborhood);
}

/** Neighborhood search has no brand context, so it defaults to the launch vertical. */
export const DEFAULT_INDUSTRY_VERTICAL: IndustryVertical = "coffee_bakery";
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
     )
     SELECT boundary_ids,
            display_name,
            ST_Y(ST_Centroid(geom)) AS latitude,
            ST_X(ST_Centroid(geom)) AS longitude,
            CASE WHEN match_rank = 1 THEN 0 ELSE
              ST_Distance(
                ST_SetSRID(ST_MakePoint(ST_XMin(geom), ST_YMin(geom)), 4326)::geography,
                ST_SetSRID(ST_MakePoint(ST_XMax(geom), ST_YMax(geom)), 4326)::geography)
            END AS span_meters
       FROM combined
      WHERE boundary_ids IS NOT NULL`,
    [neighborhood, MIN_PARTIAL_NEIGHBORHOOD_TERM_LENGTH],
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
): Promise<NeighborhoodCentroid | null> {
  const from_boundary = await fetch_boundary_centroid(neighborhood, pool);
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
      WHERE lower(l.neighborhood) = lower($1)`,
    [neighborhood],
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
): Promise<NeighborhoodDiscovery | null> {
  const centroid = await fetch_neighborhood_centroid(neighborhood, pool);
  if (!centroid) return null;

  const origin_alternatives = await fetch_nearby_independent_alternatives(
    centroid.latitude,
    centroid.longitude,
    DEFAULT_INDUSTRY_VERTICAL,
    pool,
  );
  const results = await fetch_neighborhood_corporate_discovery(
    centroid.neighborhood,
    pool,
    centroid.boundary_ids,
  );
  return { centroid, results, origin_alternatives };
}

/**
 * Lookahead over neighborhood names: tracked storefront labels first, then
 * official boundary names (matched at the start of the name or of a later word).
 * Plain string functions are used, so wildcard characters in input match nothing.
 */
export async function fetch_neighborhood_suggestions(
  prefix: string,
  pool: Pick<PgPool, "query"> = get_database_pool(),
): Promise<string[]> {
  const term = prefix.trim().toLowerCase();
  if (term.length === 0) return [];

  const result = await pool.query<{ name: string }>(
    `SELECT name
       FROM (
         SELECT neighborhood AS name, 0 AS priority
           FROM locations
          WHERE neighborhood IS NOT NULL AND starts_with(lower(neighborhood), $1)
         UNION ALL
         SELECT name, 1
           FROM neighborhood_boundaries
          WHERE starts_with(lower(name), $1)
             OR (length($1) >= $3
                 AND (strpos(lower(name), ' ' || $1) > 0 OR strpos(lower(name), '-' || $1) > 0))
       ) matches
      GROUP BY name
      ORDER BY min(priority), name
      LIMIT $2`,
    [term, MAX_NEIGHBORHOOD_SUGGESTIONS, MIN_PARTIAL_NEIGHBORHOOD_TERM_LENGTH],
  );
  return result.rows.map((row) => row.name);
}
