import type { Pool as PgPool } from "pg";
import { get_database_pool } from "@/lib/db/pool";
import {
  CORPORATE_LOCATION_COLUMNS,
  attach_independent_alternatives,
  map_to_alternative,
  to_corporate_record,
  type AlternativeRow,
  type CorporateLocationRow,
} from "@/lib/db/proximity";
import type {
  AlternativeRecommendation,
  BrandSuggestion,
  CollectionOrigin,
  CorporateTier,
  IndustryVertical,
  NearbyCorporateResult,
  OwnerSuggestion,
} from "@/lib/types";

type Pool = Pick<PgPool, "query">;

export const MAX_BRAND_SUGGESTIONS = 5;
export const MAX_OWNER_SUGGESTIONS = 3;
/** A brand or owner view shows at most this many locations (nearest first). */
export const MAX_COLLECTION_LOCATIONS = 10;
/** Shorter terms only match from the start of a word (no typo matching). */
export const MIN_FUZZY_TERM_LENGTH = 3;
/**
 * pg_trgm strict word similarity needed for a typo match. 0.55 keeps "blank stret",
 * "blackstne" and "dunkins" while rejecting look-alikes such as "qx roast" → "Mighty Oak Roasters".
 */
const FUZZY_THRESHOLD = 0.55;

export interface SearchPoint {
  latitude: number;
  longitude: number;
}

/*
 * Matching. Everything is compared lowercased with plain string functions, so
 * wildcard characters in the input match nothing special. When pg_trgm is
 * installed (migration 11) a typo-tolerant match is added; without it, search
 * still works on exact fragments.
 */
let trigram_check: Promise<boolean> | null = null;

async function has_trigram_matching(pool: Pool): Promise<boolean> {
  if (!trigram_check) {
    trigram_check = pool
      .query<{ available: boolean }>(`SELECT to_regprocedure('strict_word_similarity(text, text)') IS NOT NULL AS available`)
      .then((result) => result.rows[0]?.available === true)
      .catch(() => {
        trigram_check = null;
        return false;
      });
  }
  return trigram_check;
}

/** For tests: forget whether pg_trgm was found. */
export function reset_trigram_check(): void {
  trigram_check = null;
}

/** 3 = starts with the term, 2 = a later word starts with it, 1 = contains it, 0 = typo match only. */
function rank_sql(column: string): string {
  return `CASE WHEN starts_with(lower(${column}), $1) THEN 3
               WHEN strpos(lower(${column}), ' ' || $1) > 0 THEN 2
               WHEN strpos(lower(${column}), $1) > 0 THEN 1
               ELSE 0 END`;
}

function match_sql(column: string, fuzzy: boolean): string {
  const exact = `strpos(lower(${column}), $1) > 0`;
  if (!fuzzy) return exact;
  return `(${exact} OR (length($1) >= ${MIN_FUZZY_TERM_LENGTH} AND strict_word_similarity($1, lower(${column})) >= ${FUZZY_THRESHOLD}))`;
}

function similarity_sql(column: string, fuzzy: boolean): string {
  return fuzzy ? `strict_word_similarity($1, lower(${column}))` : "0::float8";
}

function normalize_term(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Locations that the public map shows: in an active market, and in the city when one is chosen. */
const VISIBLE_LOCATION = `JOIN markets m ON m.id = l.market_id AND m.status = 'active'`;

/** Published brands whose name matches, closest (or largest) first. Only brands with visible locations. */
export async function fetch_brand_suggestions(
  text: string,
  pool: Pool = get_database_pool(),
  options: { city?: string | null; near?: SearchPoint | null } = {},
): Promise<BrandSuggestion[]> {
  const term = normalize_term(text);
  if (!term) return [];
  const fuzzy = await has_trigram_matching(pool);
  const near = options.near ?? null;
  const result = await pool.query<{
    brand_id: string;
    slug: string;
    name: string;
    corporate_tier: number;
    industry_vertical: IndustryVertical;
    location_count: number;
    nearest_distance_meters: number | null;
  }>(
    `SELECT b.id AS brand_id, b.slug, b.name, b.corporate_tier, b.industry_vertical,
            count(l.id)::int AS location_count,
            CASE WHEN $3::float8 IS NULL THEN NULL
                 ELSE min(ST_Distance(l.coordinates::geography,
                                      ST_SetSRID(ST_MakePoint($4::float8, $3::float8), 4326)::geography))
            END AS nearest_distance_meters
       FROM brands b
       JOIN locations l ON l.brand_id = b.id
       ${VISIBLE_LOCATION}
      WHERE ($5::text IS NULL OR l.city = $5)
        AND ${match_sql("b.name", fuzzy)}
      GROUP BY b.id
      ORDER BY ${rank_sql("b.name")} DESC, ${similarity_sql("b.name", fuzzy)} DESC,
               nearest_distance_meters ASC NULLS LAST, location_count DESC, b.name
      LIMIT $2`,
    [term, MAX_BRAND_SUGGESTIONS, near?.latitude ?? null, near?.longitude ?? null, options.city ?? null],
  );
  return result.rows.map((row) => ({
    brand_id: row.brand_id,
    slug: row.slug,
    name: row.name,
    corporate_tier: row.corporate_tier as CorporateTier,
    industry_vertical: row.industry_vertical,
    location_count: Number(row.location_count),
    nearest_distance_meters: row.nearest_distance_meters === null ? null : Math.round(Number(row.nearest_distance_meters)),
  }));
}

/**
 * Parent companies and named backers whose name matches. One owner can stand
 * behind several brands ("Blackstone" → every brand it owns or funds).
 */
export async function fetch_owner_suggestions(
  text: string,
  pool: Pool = get_database_pool(),
  options: { city?: string | null } = {},
): Promise<OwnerSuggestion[]> {
  const term = normalize_term(text);
  if (!term) return [];
  const fuzzy = await has_trigram_matching(pool);
  const result = await pool.query<{ name: string; brand_names: string[] }>(
    `WITH owners AS (
       SELECT btrim(o.name) AS name, b.name AS brand_name
         FROM brands b
        CROSS JOIN LATERAL unnest(array_prepend(b.parent_entity, b.financial_backers)) AS o(name)
        WHERE b.corporate_tier IN (1, 2)
          AND o.name IS NOT NULL AND btrim(o.name) <> ''
          AND EXISTS (SELECT 1 FROM locations l ${VISIBLE_LOCATION}
                       WHERE l.brand_id = b.id AND ($3::text IS NULL OR l.city = $3))
     )
     SELECT min(name) AS name, array_agg(DISTINCT brand_name ORDER BY brand_name) AS brand_names
       FROM owners
      WHERE ${match_sql("name", fuzzy)}
      GROUP BY lower(name)
      ORDER BY max(${rank_sql("name")}) DESC, max(${similarity_sql("name", fuzzy)}) DESC,
               count(DISTINCT brand_name) DESC, min(name)
      LIMIT $2`,
    [term, MAX_OWNER_SUGGESTIONS, options.city ?? null],
  );
  return result.rows.map((row) => ({ name: row.name, brand_names: row.brand_names }));
}

/**
 * A parent of a single brand adds nothing when that brand is already listed
 * (e.g. "Blank Street Inc." next to "Blank Street Coffee"). Owners of several
 * brands stay: they open every brand at once.
 */
export function drop_redundant_owners(owners: OwnerSuggestion[], brands: BrandSuggestion[]): OwnerSuggestion[] {
  const listed = new Set(brands.map((brand) => brand.name.toLowerCase()));
  return owners.filter((owner) => owner.brand_names.length > 1 || !listed.has(owner.brand_names[0]?.toLowerCase() ?? ""));
}

/* -------------------------------------------------------------------------- */
/* Brand and owner views                                                       */
/* -------------------------------------------------------------------------- */

export interface CollectionDiscovery<T> {
  subject: T;
  origin: CollectionOrigin;
  results: NearbyCorporateResult[];
  /** Locations of an independent brand (empty for corporate-backed brands and owners). */
  independent_locations: AlternativeRecommendation[];
}

function distance_sql(near: SearchPoint | null): string {
  return near
    ? `ST_Distance(l.coordinates::geography, ST_SetSRID(ST_MakePoint(${near.longitude}, ${near.latitude}), 4326)::geography)`
    : "NULL::float8";
}

function to_origin(near: SearchPoint | null, first: { latitude: number; longitude: number } | undefined, total: number): CollectionOrigin {
  return {
    anchor: near ? "user" : "none",
    latitude: near?.latitude ?? first?.latitude ?? 0,
    longitude: near?.longitude ?? first?.longitude ?? 0,
    total_locations: total,
  };
}

function assert_point(near: SearchPoint | null): void {
  if (near && (!Number.isFinite(near.latitude) || !Number.isFinite(near.longitude))) {
    throw new Error("Invalid search point.");
  }
}

/** Every visible location of one brand, nearest first; null when the brand has none. */
export async function fetch_brand_discovery(
  brand_id: string,
  pool: Pool = get_database_pool(),
  options: { city?: string | null; near?: SearchPoint | null } = {},
): Promise<CollectionDiscovery<BrandSuggestion> | null> {
  const near = options.near ?? null;
  assert_point(near);
  const city = options.city ?? null;
  const summary = await pool.query<{
    name: string;
    slug: string;
    corporate_tier: number;
    industry_vertical: IndustryVertical;
    total: number;
    nearest: number | null;
  }>(
    `SELECT b.name, b.slug, b.corporate_tier, b.industry_vertical, count(l.id)::int AS total,
            min(${distance_sql(near)}) AS nearest
       FROM brands b
       JOIN locations l ON l.brand_id = b.id
       ${VISIBLE_LOCATION}
      WHERE b.id = $1::uuid AND ($2::text IS NULL OR l.city = $2)
      GROUP BY b.id`,
    [brand_id, city],
  );
  const row = summary.rows[0];
  if (!row) return null;
  const subject: BrandSuggestion = {
    brand_id,
    slug: row.slug,
    name: row.name,
    corporate_tier: row.corporate_tier as CorporateTier,
    industry_vertical: row.industry_vertical,
    location_count: Number(row.total),
    nearest_distance_meters: row.nearest === null ? null : Math.round(Number(row.nearest)),
  };
  const order = near ? "distance_meters ASC, l.address" : "l.neighborhood NULLS LAST, l.address";

  if (subject.corporate_tier === 3) {
    const locations = await pool.query<AlternativeRow>(
      `SELECT l.id AS location_id, b.name AS brand_name, b.slug AS brand_slug, l.address, l.neighborhood,
              b.unique_selling_proposition,
              COALESCE(${distance_sql(near)}, 0) AS distance_meters,
              ST_Y(l.coordinates) AS latitude, ST_X(l.coordinates) AS longitude
         FROM locations l
         JOIN brands b ON b.id = l.brand_id
         ${VISIBLE_LOCATION}
        WHERE b.id = $1::uuid AND ($2::text IS NULL OR l.city = $2)
        ORDER BY ${order}
        LIMIT $3`,
      [brand_id, city, MAX_COLLECTION_LOCATIONS],
    );
    const independent_locations = locations.rows.map(map_to_alternative);
    return { subject, origin: to_origin(near, independent_locations[0], subject.location_count), results: [], independent_locations };
  }

  const locations = await pool.query<CorporateLocationRow & { distance_meters: number | null }>(
    `SELECT ${CORPORATE_LOCATION_COLUMNS}, ${distance_sql(near)} AS distance_meters
       FROM locations l
       JOIN brands b ON b.id = l.brand_id
       ${VISIBLE_LOCATION}
      WHERE b.id = $1::uuid AND ($2::text IS NULL OR l.city = $2)
      ORDER BY ${order}
      LIMIT $3`,
    [brand_id, city, MAX_COLLECTION_LOCATIONS],
  );
  const results = await attach_independent_alternatives(
    locations.rows.map((location) => ({
      record: to_corporate_record(location),
      distance_meters: location.distance_meters === null ? null : Math.round(Number(location.distance_meters)),
    })),
    pool,
  );
  return { subject, origin: to_origin(near, results[0]?.target, subject.location_count), results, independent_locations: [] };
}

/**
 * Every visible location of the corporate-backed brands an owner (parent or named
 * backer) stands behind, nearest first; null when it backs nothing on the map.
 */
export async function fetch_owner_discovery(
  owner_name: string,
  pool: Pool = get_database_pool(),
  options: { city?: string | null; near?: SearchPoint | null } = {},
): Promise<CollectionDiscovery<OwnerSuggestion> | null> {
  const near = options.near ?? null;
  assert_point(near);
  const city = options.city ?? null;
  const owner = owner_name.replace(/\s+/g, " ").trim();
  if (!owner) return null;
  const owned = `b.corporate_tier IN (1, 2)
        AND (lower(btrim(b.parent_entity)) = lower($1)
             OR EXISTS (SELECT 1 FROM unnest(b.financial_backers) AS backer WHERE lower(btrim(backer)) = lower($1)))
        AND ($2::text IS NULL OR l.city = $2)`;

  const summary = await pool.query<{ name: string | null; brand_names: string[] | null; total: number }>(
    `SELECT (SELECT min(btrim(o.name))
               FROM brands b2
               CROSS JOIN LATERAL unnest(array_prepend(b2.parent_entity, b2.financial_backers)) AS o(name)
              WHERE lower(btrim(o.name)) = lower($1)) AS name,
            array_agg(DISTINCT b.name ORDER BY b.name) AS brand_names,
            count(l.id)::int AS total
       FROM brands b
       JOIN locations l ON l.brand_id = b.id
       ${VISIBLE_LOCATION}
      WHERE ${owned}`,
    [owner, city],
  );
  const row = summary.rows[0];
  if (!row || Number(row.total) === 0 || !row.brand_names) return null;
  const subject: OwnerSuggestion = { name: row.name ?? owner, brand_names: row.brand_names };

  const locations = await pool.query<CorporateLocationRow & { distance_meters: number | null }>(
    `SELECT ${CORPORATE_LOCATION_COLUMNS}, ${distance_sql(near)} AS distance_meters
       FROM locations l
       JOIN brands b ON b.id = l.brand_id
       ${VISIBLE_LOCATION}
      WHERE ${owned}
      ORDER BY ${near ? "distance_meters ASC, l.address" : "b.name, l.address"}
      LIMIT $3`,
    [owner, city, MAX_COLLECTION_LOCATIONS],
  );
  const results = await attach_independent_alternatives(
    locations.rows.map((location) => ({
      record: to_corporate_record(location),
      distance_meters: location.distance_meters === null ? null : Math.round(Number(location.distance_meters)),
    })),
    pool,
  );
  return { subject, origin: to_origin(near, results[0]?.target, Number(row.total)), results, independent_locations: [] };
}
