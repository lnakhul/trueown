import type { Pool, PoolClient } from "pg";
import { to_title_case } from "@/lib/import/boundaries";
import type { IndustryVertical } from "@/lib/types";

/**
 * Storefront discovery from public datasets. Establishments are matched to brands
 * we already track and written to the admin review queue (storefront_candidates);
 * nothing is published until an admin approves it.
 */

/* ------------------------------------------------------------------------- */
/* Name matching                                                               */
/* ------------------------------------------------------------------------- */

/** "Joe & The Juice (Oculus)" -> "JOE AND THE JUICE OCULUS"; "DUNKIN'" -> "DUNKIN". */
export function normalize_business_name(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/['’`]/g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function edit_distance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j]!;
      previous[j] = Math.min(previous[j]! + 1, previous[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[b.length]!;
}

export interface MatchableBrand {
  id: string;
  name: string;
  industry_vertical: IndustryVertical;
}

export type MatchKind = "exact" | "possible" | "none";

export interface BrandMatch {
  brand: MatchableBrand | null;
  kind: MatchKind;
}

/** Brand names shorter than this only match exactly (too generic for prefixes or typos). */
const MIN_PREFIX_ALIAS_LENGTH = 4;
const MIN_FUZZY_ALIAS_LENGTH = 6;

/**
 * Exact = the establishment name IS the brand name or starts with it as whole words
 * ("BLANK STREET COFFEE" for "Blank Street Coffee"? yes; "PETITE MAMAN" for "Maman"? no).
 * Possible = the leading words are one or two typos away ("MAGNOLIA BAGERY"), or the
 * brand name runs straight into more characters ("DUNKIN99").
 * The longest matching brand name wins, so a specific brand beats a generic one.
 */
export function match_brand(establishment_name: string, brands: MatchableBrand[]): BrandMatch {
  const name = normalize_business_name(establishment_name);
  if (!name) return { brand: null, kind: "none" };

  let exact: { brand: MatchableBrand; length: number } | null = null;
  let possible: { brand: MatchableBrand; distance: number; length: number } | null = null;

  for (const brand of brands) {
    const alias = normalize_business_name(brand.name);
    if (!alias) continue;
    const is_exact =
      name === alias || (alias.length >= MIN_PREFIX_ALIAS_LENGTH && name.startsWith(`${alias} `));
    if (is_exact) {
      if (!exact || alias.length > exact.length) exact = { brand, length: alias.length };
      continue;
    }
    if (alias.length < MIN_FUZZY_ALIAS_LENGTH) continue;
    // Brand name glued to more characters ("DUNKIN99") is probably that brand: confirm by hand.
    if (name.startsWith(alias)) {
      if (!possible || possible.distance > 0 || alias.length > possible.length) possible = { brand, distance: 0, length: alias.length };
      continue;
    }
    // Compare against the same number of leading words, so "MAGNOLIA BAGERY NYC" lines up with "MAGNOLIA BAKERY".
    const leading = name.split(" ").slice(0, alias.split(" ").length).join(" ");
    const allowed = alias.length >= 12 ? 2 : 1;
    const distance = edit_distance(leading, alias);
    if (distance > 0 && distance <= allowed && (!possible || distance < possible.distance || (distance === possible.distance && alias.length > possible.length))) {
      possible = { brand, distance, length: alias.length };
    }
  }

  if (exact) return { brand: exact.brand, kind: "exact" };
  if (possible) return { brand: possible.brand, kind: "possible" };
  return { brand: null, kind: "none" };
}

/* ------------------------------------------------------------------------- */
/* NYC restaurant inspections (DOHMH) via the NYC Open Data SODA API            */
/* ------------------------------------------------------------------------- */

export const NYC_DOHMH_SOURCE = "nyc_dohmh";
export const NYC_DOHMH_DATASET_URL = "https://data.cityofnewyork.us/resource/43nn-pn8j.json";
export const NYC_DOHMH_ATTRIBUTION =
  "NYC Department of Health and Mental Hygiene, Restaurant Inspection Results (NYC Open Data)";

/** Categories whose unmatched establishments are offered as possible independents. */
export const NYC_INDEPENDENT_CATEGORIES = [
  "Coffee/Tea",
  "Bakery Products/Desserts",
  "Donuts",
  "Bagels/Pretzels",
] as const;

const PAGE_SIZE = 20_000;
const REQUEST_TIMEOUT_MS = 60_000;

export interface DohmhEstablishment {
  camis: string;
  dba: string;
  boro: string;
  building: string;
  street: string;
  zipcode: string;
  latitude: number | null;
  longitude: number | null;
  cuisine_description: string | null;
  /** YYYY-MM-DD of the most recent inspection record (1900-01-01 = not yet inspected). */
  last_inspection_on: string | null;
}

interface DohmhRow {
  camis?: string;
  dba?: string;
  boro?: string;
  building?: string;
  street?: string;
  zipcode?: string;
  latitude?: string;
  longitude?: string;
  cuisine_description?: string;
  last_inspection?: string;
}

function soql_string(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * One SoQL filter: every establishment in the independent categories, plus every
 * establishment whose name starts like a tracked brand in any category (Pret is
 * filed under "Sandwiches", Maman under "French"). Precise matching happens later.
 */
export function build_dohmh_where(brands: MatchableBrand[]): string {
  const categories = NYC_INDEPENDENT_CATEGORIES.map(soql_string).join(", ");
  const prefixes = [
    ...new Set(
      brands
        .map((brand) => normalize_business_name(brand.name).split(" ")[0] ?? "")
        .filter((word) => word.length >= 3),
    ),
  ].sort();
  const name_filters = prefixes.map((prefix) => `upper(dba) like ${soql_string(`${prefix}%`)}`);
  return [`cuisine_description in (${categories})`, ...name_filters].join(" OR ");
}

function parse_coordinate(value: string | undefined, limit: number): number | null {
  const parsed = Number(value);
  // The dataset uses 0 for "not geocoded".
  return Number.isFinite(parsed) && parsed !== 0 && Math.abs(parsed) <= limit ? parsed : null;
}

export function parse_dohmh_rows(payload: unknown): DohmhEstablishment[] {
  if (!Array.isArray(payload)) throw new Error("NYC Open Data returned a malformed response.");
  return payload.flatMap((row: DohmhRow) => {
    if (!row.camis || !row.dba) return [];
    const latitude = parse_coordinate(row.latitude, 90);
    const longitude = parse_coordinate(row.longitude, 180);
    return [
      {
        camis: row.camis.trim(),
        dba: row.dba.trim(),
        boro: (row.boro ?? "").trim(),
        building: (row.building ?? "").trim(),
        street: (row.street ?? "").trim(),
        zipcode: (row.zipcode ?? "").trim(),
        latitude: latitude !== null && longitude !== null ? latitude : null,
        longitude: latitude !== null && longitude !== null ? longitude : null,
        cuisine_description: row.cuisine_description?.trim() || null,
        last_inspection_on: row.last_inspection ? row.last_inspection.slice(0, 10) : null,
      },
    ];
  });
}

/** The dataset has one row per violation; keep one record per establishment (the latest). */
export function dedupe_establishments(records: DohmhEstablishment[]): DohmhEstablishment[] {
  const by_id = new Map<string, DohmhEstablishment>();
  for (const record of records) {
    const current = by_id.get(record.camis);
    if (!current || (record.last_inspection_on ?? "") > (current.last_inspection_on ?? "")) {
      by_id.set(record.camis, record);
    }
  }
  return [...by_id.values()];
}

/** "186", "WEST 4 STREET", "Manhattan", "10014" -> "186 West 4 Street, Manhattan, NY 10014". */
export function format_dohmh_address(record: Pick<DohmhEstablishment, "building" | "street" | "boro" | "zipcode">): string {
  const street_line = [record.building, to_title_case(record.street.replace(/\s+/g, " "))].filter(Boolean).join(" ");
  const borough = record.boro && record.boro !== "0" ? record.boro : "";
  const tail = ["NY", record.zipcode].filter(Boolean).join(" ");
  return [street_line, borough, tail].filter(Boolean).join(", ");
}

export async function fetch_dohmh_establishments(
  brands: MatchableBrand[],
  options: { app_token?: string | null; fetch_impl?: typeof fetch; max_pages?: number } = {},
): Promise<DohmhEstablishment[]> {
  const fetch_impl = options.fetch_impl ?? fetch;
  const where = build_dohmh_where(brands);
  const group = "camis,dba,boro,building,street,zipcode,latitude,longitude,cuisine_description";
  const records: DohmhEstablishment[] = [];
  for (let page = 0; page < (options.max_pages ?? 50); page += 1) {
    const url = new URL(NYC_DOHMH_DATASET_URL);
    url.searchParams.set("$select", `${group},max(inspection_date) as last_inspection`);
    url.searchParams.set("$where", where);
    url.searchParams.set("$group", group);
    url.searchParams.set("$order", "camis");
    url.searchParams.set("$limit", String(PAGE_SIZE));
    url.searchParams.set("$offset", String(page * PAGE_SIZE));
    const response = await fetch_impl(url, {
      headers: { Accept: "application/json", ...(options.app_token ? { "X-App-Token": options.app_token } : {}) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`NYC Open Data responded with HTTP ${response.status}.`);
    const batch = parse_dohmh_rows(await response.json());
    records.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return dedupe_establishments(records);
}

/* ------------------------------------------------------------------------- */
/* Candidates                                                                  */
/* ------------------------------------------------------------------------- */

export interface StorefrontCandidateInput {
  source: string;
  source_record_id: string;
  name: string;
  address: string;
  borough: string | null;
  category: string | null;
  industry_vertical: IndustryVertical;
  latitude: number | null;
  longitude: number | null;
  matched_brand_id: string | null;
  match_kind: MatchKind;
  source_updated_on: string | null;
}

/** "BLANK STREET COFFEE" -> "Blank Street Coffee" (keeps "&" and digits). */
export function display_name(raw: string): string {
  return to_title_case(raw.replace(/\s+/g, " ").trim());
}

/**
 * Keeps establishments that match a tracked brand (any category) and unmatched
 * ones in the independent categories; everything else is out of scope.
 */
export function build_candidates(records: DohmhEstablishment[], brands: MatchableBrand[]): StorefrontCandidateInput[] {
  const independent_categories: readonly string[] = NYC_INDEPENDENT_CATEGORIES;
  return records.flatMap((record) => {
    const match = match_brand(record.dba, brands);
    const in_scope = match.kind !== "none" || independent_categories.includes(record.cuisine_description ?? "");
    if (!in_scope) return [];
    const address = format_dohmh_address(record);
    if (!address || !record.building || !record.street) return [];
    const inspection = record.last_inspection_on && record.last_inspection_on > "1901-01-01" ? record.last_inspection_on : null;
    return [
      {
        source: NYC_DOHMH_SOURCE,
        source_record_id: record.camis,
        name: display_name(record.dba).slice(0, 200),
        address: address.slice(0, 300),
        borough: record.boro || null,
        category: record.cuisine_description,
        industry_vertical: match.brand?.industry_vertical ?? "coffee_bakery",
        latitude: record.latitude,
        longitude: record.longitude,
        matched_brand_id: match.brand?.id ?? null,
        match_kind: match.kind,
        source_updated_on: inspection,
      },
    ];
  });
}

export interface StorefrontImportSummary {
  establishments: number;
  candidates: number;
  inserted: number;
  updated: number;
  exact: number;
  possible: number;
  unmatched: number;
  missing_coordinates: number;
  already_listed: number;
  pending_total: number;
}

/** Same-brand storefront within this distance = the same shop already on the map. */
export const ALREADY_LISTED_RADIUS_METERS = 40;

type Queryable = Pick<PoolClient, "query">;

/** Brands we can match in a market: national chains plus that market's independents. */
export async function fetch_matchable_brands(client: Queryable, market_id: string): Promise<MatchableBrand[]> {
  const result = await client.query<MatchableBrand>(
    `SELECT id, name, industry_vertical FROM brands
      WHERE home_market_id IS NULL OR home_market_id = $1
      ORDER BY name`,
    [market_id],
  );
  return result.rows;
}

/**
 * Upserts the candidates in one transaction. Review decisions survive re-imports:
 * an approved or rejected candidate only gets its "last seen" time refreshed, and
 * a pending one is re-matched against the current brand list.
 */
export async function upsert_storefront_candidates(
  pool: Pool,
  market_id: string,
  candidates: StorefrontCandidateInput[],
  establishments: number,
  options: { dry_run?: boolean } = {},
): Promise<StorefrontImportSummary> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let inserted = 0;
    let updated = 0;
    for (const candidate of candidates) {
      const result = await client.query<{ inserted: boolean }>(
        `INSERT INTO storefront_candidates
           (source, source_record_id, market_id, name, address, borough, category, industry_vertical,
            latitude, longitude, matched_brand_id, match_kind, source_updated_on)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::industry_vertical, $9, $10, $11, $12, $13)
         ON CONFLICT (source, source_record_id) DO UPDATE SET
           name = EXCLUDED.name,
           address = EXCLUDED.address,
           borough = EXCLUDED.borough,
           category = EXCLUDED.category,
           latitude = EXCLUDED.latitude,
           longitude = EXCLUDED.longitude,
           source_updated_on = EXCLUDED.source_updated_on,
           last_seen_at = now(),
           industry_vertical = CASE WHEN storefront_candidates.status = 'pending'
                                    THEN EXCLUDED.industry_vertical ELSE storefront_candidates.industry_vertical END,
           matched_brand_id = CASE WHEN storefront_candidates.status = 'pending'
                                   THEN EXCLUDED.matched_brand_id ELSE storefront_candidates.matched_brand_id END,
           match_kind = CASE WHEN storefront_candidates.status = 'pending'
                             THEN EXCLUDED.match_kind ELSE storefront_candidates.match_kind END
         RETURNING (xmax = 0) AS inserted`,
        [
          candidate.source,
          candidate.source_record_id,
          market_id,
          candidate.name,
          candidate.address,
          candidate.borough,
          candidate.category,
          candidate.industry_vertical,
          candidate.latitude,
          candidate.longitude,
          candidate.matched_brand_id,
          candidate.match_kind,
          candidate.source_updated_on,
        ],
      );
      if (result.rows[0]?.inserted) inserted += 1;
      else updated += 1;
    }

    // A matched establishment right next to the same brand's live storefront is that storefront.
    const listed = await client.query(
      `UPDATE storefront_candidates c
          SET status = 'already_listed', location_id = l.id
         FROM locations l
        WHERE c.market_id = $1
          AND c.status = 'pending'
          AND c.match_kind = 'exact'
          AND c.latitude IS NOT NULL
          AND l.brand_id = c.matched_brand_id
          AND ST_DWithin(l.coordinates::geography,
                         ST_SetSRID(ST_MakePoint(c.longitude, c.latitude), 4326)::geography, $2)`,
      [market_id, ALREADY_LISTED_RADIUS_METERS],
    );
    const pending = await client.query<{ total: number }>(
      "SELECT count(*)::int AS total FROM storefront_candidates WHERE market_id = $1 AND status = 'pending'",
      [market_id],
    );

    await client.query(options.dry_run ? "ROLLBACK" : "COMMIT");
    return {
      establishments,
      candidates: candidates.length,
      inserted,
      updated,
      exact: candidates.filter((candidate) => candidate.match_kind === "exact").length,
      possible: candidates.filter((candidate) => candidate.match_kind === "possible").length,
      unmatched: candidates.filter((candidate) => candidate.match_kind === "none").length,
      missing_coordinates: candidates.filter((candidate) => candidate.latitude === null).length,
      already_listed: listed.rowCount ?? 0,
      pending_total: pending.rows[0]?.total ?? 0,
    };
  } catch (caught_error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw caught_error;
  } finally {
    client.release();
  }
}
