import type { Pool } from "pg";
import {
  download_boundary_geojson,
  import_market_boundaries,
  normalize_boundary_geojson,
  parse_boundary_geojson,
  type BoundaryImportSummary,
  type BoundaryParseSpec,
  type BoundaryRecord,
  type ParseOutcome,
} from "@/lib/import/boundaries";

/**
 * NYC 2020 Neighborhood Tabulation Areas: the launch market's boundary set.
 * A thin wrapper over the generic importer; values mirror data/markets/nyc/market.json.
 */
export type { BoundaryImportSummary, BoundaryRecord, ParseOutcome };
export { sha256_of, upsert_boundaries } from "@/lib/import/boundaries";

export const NTA_MARKET_SLUG = "nyc";
export const NTA_2020_SOURCE_ID = "nyc_nta_2020";
export const NTA_2020_DOWNLOAD_URL =
  "https://data.cityofnewyork.us/resource/9nt8-h7nd.geojson?$limit=500";
export const NTA_CITY = "New York";
/** NYC has 262 NTAs in the 2020 set; anything far below that is a truncated file. */
export const MIN_EXPECTED_NTA_FEATURES = 250;

export const NTA_PARSE_SPEC: BoundaryParseSpec = {
  properties: { code: "nta2020", name: "ntaname", borough: "boroname", area_type: "ntatype" },
  name_case: "as_is",
  min_expected_features: MIN_EXPECTED_NTA_FEATURES,
};

export function parse_nta_geojson(raw: unknown): ParseOutcome {
  return parse_boundary_geojson(raw, NTA_PARSE_SPEC);
}

export function normalize_nta_geojson(raw: unknown): unknown {
  return normalize_boundary_geojson(raw, NTA_PARSE_SPEC);
}

export function download_nta_geojson(fetch_impl: typeof fetch = fetch): Promise<unknown> {
  return download_boundary_geojson(NTA_2020_DOWNLOAD_URL, fetch_impl);
}

/** Transactional NYC import: all polygons load, or none do. */
export function import_boundaries(
  pool: Pool,
  records: BoundaryRecord[],
  options: { dry_run?: boolean } = {},
): Promise<BoundaryImportSummary> {
  return import_market_boundaries(
    pool,
    { slug: NTA_MARKET_SLUG, boundaries: { source_id: NTA_2020_SOURCE_ID } },
    records,
    options,
  );
}
