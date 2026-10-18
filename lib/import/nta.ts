import { createHash } from "crypto";
import type { Pool, PoolClient } from "pg";

/** NYC Open Data: 2020 Neighborhood Tabulation Areas (NTAs), GeoJSON endpoint. */
export const NTA_2020_SOURCE_ID = "nyc_nta_2020";
export const NTA_2020_DOWNLOAD_URL =
  "https://data.cityofnewyork.us/resource/9nt8-h7nd.geojson?$limit=500";
export const NTA_CITY = "New York";
/** NYC has 262 NTAs in the 2020 set; anything far below that is a truncated file. */
export const MIN_EXPECTED_NTA_FEATURES = 250;
const COORDINATE_DECIMALS = 6;
const DOWNLOAD_TIMEOUT_MS = 60_000;

export interface BoundaryRecord {
  source_code: string;
  name: string;
  borough: string | null;
  area_type: string | null;
  /** Polygon or MultiPolygon GeoJSON geometry, serialized for ST_GeomFromGeoJSON. */
  geometry_json: string;
}

export interface ParseOutcome {
  records: BoundaryRecord[];
  errors: string[];
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clean_text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Recursively rounds coordinates; ~0.1m precision is far below geocoder accuracy. */
function round_coordinates(node: unknown): unknown {
  if (typeof node === "number") {
    const factor = 10 ** COORDINATE_DECIMALS;
    return Math.round(node * factor) / factor;
  }
  return Array.isArray(node) ? node.map(round_coordinates) : node;
}

function coordinates_in_wgs84_range(node: unknown): boolean {
  if (typeof node === "number") return Number.isFinite(node);
  if (!Array.isArray(node)) return false;
  if (node.length === 2 && typeof node[0] === "number" && typeof node[1] === "number") {
    return Math.abs(node[0]) <= 180 && Math.abs(node[1]) <= 90;
  }
  return node.length > 0 && node.every(coordinates_in_wgs84_range);
}

/**
 * Validates every feature of an NTA FeatureCollection. Nothing is skipped
 * silently: every malformed feature is reported so a bad file is never half-loaded.
 */
export function parse_nta_geojson(raw: unknown): ParseOutcome {
  const errors: string[] = [];
  const records: BoundaryRecord[] = [];

  if (!is_record(raw) || raw.type !== "FeatureCollection" || !Array.isArray(raw.features)) {
    return { records, errors: ["File is not a GeoJSON FeatureCollection."] };
  }

  const seen_codes = new Set<string>();
  raw.features.forEach((feature: unknown, index: number) => {
    const label = `Feature ${index + 1}`;
    if (!is_record(feature) || !is_record(feature.properties) || !is_record(feature.geometry)) {
      errors.push(`${label}: missing properties or geometry.`);
      return;
    }
    const properties = feature.properties;
    const geometry = feature.geometry;

    const source_code = clean_text(properties.nta2020);
    const name = clean_text(properties.ntaname);
    if (!source_code || !name) {
      errors.push(`${label}: nta2020 and ntaname are required.`);
      return;
    }
    if (seen_codes.has(source_code)) {
      errors.push(`${label} (${source_code}): duplicate NTA code.`);
      return;
    }
    seen_codes.add(source_code);

    if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") {
      errors.push(`${label} (${source_code}): geometry must be Polygon or MultiPolygon.`);
      return;
    }
    if (!coordinates_in_wgs84_range(geometry.coordinates)) {
      errors.push(`${label} (${source_code}): coordinates are missing or outside WGS84 range.`);
      return;
    }

    records.push({
      source_code,
      name,
      borough: clean_text(properties.boroname),
      area_type: clean_text(properties.ntatype),
      geometry_json: JSON.stringify({ type: geometry.type, coordinates: geometry.coordinates }),
    });
  });

  if (errors.length === 0 && records.length < MIN_EXPECTED_NTA_FEATURES) {
    errors.push(
      `Only ${records.length} features found; expected at least ${MIN_EXPECTED_NTA_FEATURES}. The file looks truncated.`,
    );
  }
  return { records, errors };
}

/** Slim, rounded copy of the official file: keeps only the properties we load. */
export function normalize_nta_geojson(raw: unknown): unknown {
  if (!is_record(raw) || !Array.isArray(raw.features)) return raw;
  return {
    type: "FeatureCollection",
    features: raw.features.map((feature: unknown) => {
      if (!is_record(feature) || !is_record(feature.properties) || !is_record(feature.geometry)) {
        return feature;
      }
      const { nta2020, ntaname, boroname, ntatype } = feature.properties;
      return {
        type: "Feature",
        properties: { nta2020, ntaname, boroname, ntatype },
        geometry: {
          type: feature.geometry.type,
          coordinates: round_coordinates(feature.geometry.coordinates),
        },
      };
    }),
  };
}

export async function download_nta_geojson(
  fetch_impl: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetch_impl(NTA_2020_DOWNLOAD_URL, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`NYC Open Data responded with HTTP ${response.status}.`);
  }
  return response.json();
}

export function sha256_of(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface BoundaryImportSummary {
  inserted: number;
  updated: number;
  total: number;
}

type Queryable = Pick<Pool | PoolClient, "query">;

/**
 * Upserts every record in one statement batch inside the caller's transaction.
 * ST_MakeValid + ST_CollectionExtract guarantee a valid MultiPolygon even if
 * coordinate rounding pinched a ring.
 */
export async function upsert_boundaries(
  client: Queryable,
  records: BoundaryRecord[],
  city: string = NTA_CITY,
  source: string = NTA_2020_SOURCE_ID,
): Promise<BoundaryImportSummary> {
  let inserted = 0;
  let updated = 0;
  for (const record of records) {
    const result = await client.query<{ inserted: boolean }>(
      `INSERT INTO neighborhood_boundaries (city, source, source_code, name, borough, area_type, geometry)
       VALUES ($1, $2, $3, $4, $5, $6,
               ST_Multi(ST_CollectionExtract(
                 ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($7), 4326)), 3)))
       ON CONFLICT (source, source_code) DO UPDATE
         SET name = EXCLUDED.name,
             borough = EXCLUDED.borough,
             area_type = EXCLUDED.area_type,
             geometry = EXCLUDED.geometry,
             city = EXCLUDED.city
       RETURNING (xmax = 0) AS inserted`,
      [city, source, record.source_code, record.name, record.borough, record.area_type, record.geometry_json],
    );
    if (result.rows[0]?.inserted) inserted += 1;
    else updated += 1;
  }
  return { inserted, updated, total: records.length };
}

/** Transactional import: all polygons load, or none do. */
export async function import_boundaries(
  pool: Pool,
  records: BoundaryRecord[],
  options: { dry_run?: boolean } = {},
): Promise<BoundaryImportSummary> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const summary = await upsert_boundaries(client, records);
    await client.query(options.dry_run ? "ROLLBACK" : "COMMIT");
    return summary;
  } catch (caught_error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw caught_error;
  } finally {
    client.release();
  }
}
