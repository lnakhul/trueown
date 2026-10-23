import { createHash } from "crypto";
import type { Pool, PoolClient } from "pg";
import type { BoundarySourceConfig, MarketConfig } from "@/lib/markets/config";

/**
 * Generic neighborhood-boundary importer. Each market's config names which
 * GeoJSON properties hold the code / name / borough, so any city's open-data
 * polygons load through the same validated, all-or-nothing path.
 */
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

export type BoundaryParseSpec = Pick<BoundarySourceConfig, "properties" | "name_case" | "min_expected_features">;

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accepts strings and numbers (portals often publish codes as numbers). */
function clean_text(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim().length > 0 ? value.trim().replace(/\s+/g, " ") : null;
}

/** "ROGERS PARK" -> "Rogers Park", "O'HARE" -> "O'Hare", "NEAR-SOUTH SIDE" -> "Near-South Side". */
export function to_title_case(text: string): string {
  return text.toLowerCase().replace(/(^|[\s\-/'(])([a-z])/g, (_match, separator: string, letter: string) => separator + letter.toUpperCase());
}

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
 * Validates every feature of a boundary FeatureCollection. Nothing is skipped
 * silently: every malformed feature is reported so a bad file is never half-loaded.
 */
export function parse_boundary_geojson(raw: unknown, spec: BoundaryParseSpec): ParseOutcome {
  const errors: string[] = [];
  const records: BoundaryRecord[] = [];
  const { properties: property_map } = spec;

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

    const source_code = clean_text(properties[property_map.code]);
    const raw_name = clean_text(properties[property_map.name]);
    if (!source_code || !raw_name) {
      errors.push(`${label}: ${property_map.code} and ${property_map.name} are required.`);
      return;
    }
    if (seen_codes.has(source_code)) {
      errors.push(`${label} (${source_code}): duplicate boundary code.`);
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
      name: spec.name_case === "title" ? to_title_case(raw_name) : raw_name,
      borough: property_map.borough ? clean_text(properties[property_map.borough]) : null,
      area_type: property_map.area_type ? clean_text(properties[property_map.area_type]) : null,
      geometry_json: JSON.stringify({ type: geometry.type, coordinates: geometry.coordinates }),
    });
  });

  if (errors.length === 0 && records.length < spec.min_expected_features) {
    errors.push(
      `Only ${records.length} features found; expected at least ${spec.min_expected_features}. The file looks truncated.`,
    );
  }
  return { records, errors };
}

/** Slim, rounded copy of an official file: keeps only the mapped properties. */
export function normalize_boundary_geojson(raw: unknown, spec: BoundaryParseSpec): unknown {
  if (!is_record(raw) || !Array.isArray(raw.features)) return raw;
  const kept_keys = Object.values(spec.properties).filter((key): key is string => typeof key === "string");
  return {
    type: "FeatureCollection",
    features: raw.features.map((feature: unknown) => {
      if (!is_record(feature) || !is_record(feature.properties) || !is_record(feature.geometry)) {
        return feature;
      }
      const source_properties = feature.properties;
      return {
        type: "Feature",
        properties: Object.fromEntries(kept_keys.map((key) => [key, source_properties[key]])),
        geometry: {
          type: feature.geometry.type,
          coordinates: round_coordinates(feature.geometry.coordinates),
        },
      };
    }),
  };
}

export async function download_boundary_geojson(
  download_url: string,
  fetch_impl: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetch_impl(download_url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`${new URL(download_url).hostname} responded with HTTP ${response.status}.`);
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

/** The market row id for a slug; throws when the market has not been created yet. */
export async function fetch_market_id(client: Queryable, slug: string): Promise<string> {
  const result = await client.query<{ id: string }>("SELECT id FROM markets WHERE slug = $1", [slug]);
  const market_id = result.rows[0]?.id;
  if (!market_id) throw new Error(`Market "${slug}" does not exist; run npm run db:import:markets first.`);
  return market_id;
}

/**
 * Upserts every record inside the caller's transaction. The city label is set
 * by the database from the market. ST_MakeValid + ST_CollectionExtract
 * guarantee a valid MultiPolygon even if coordinate rounding pinched a ring.
 */
export async function upsert_boundaries(
  client: Queryable,
  records: BoundaryRecord[],
  market_id: string,
  source: string,
): Promise<BoundaryImportSummary> {
  let inserted = 0;
  let updated = 0;
  for (const record of records) {
    const result = await client.query<{ inserted: boolean }>(
      `INSERT INTO neighborhood_boundaries (market_id, source, source_code, name, borough, area_type, geometry)
       VALUES ($1, $2, $3, $4, $5, $6,
               ST_Multi(ST_CollectionExtract(
                 ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($7), 4326)), 3)))
       ON CONFLICT (source, source_code) DO UPDATE
         SET name = EXCLUDED.name,
             borough = EXCLUDED.borough,
             area_type = EXCLUDED.area_type,
             geometry = EXCLUDED.geometry,
             market_id = EXCLUDED.market_id
       RETURNING (xmax = 0) AS inserted`,
      [market_id, source, record.source_code, record.name, record.borough, record.area_type, record.geometry_json],
    );
    if (result.rows[0]?.inserted) inserted += 1;
    else updated += 1;
  }
  return { inserted, updated, total: records.length };
}

/** Transactional import for one market: all polygons load, or none do. */
export async function import_market_boundaries(
  pool: Pool,
  market: Pick<MarketConfig, "slug"> & { boundaries: Pick<BoundarySourceConfig, "source_id"> },
  records: BoundaryRecord[],
  options: { dry_run?: boolean } = {},
): Promise<BoundaryImportSummary> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const market_id = await fetch_market_id(client, market.slug);
    const summary = await upsert_boundaries(client, records, market_id, market.boundaries.source_id);
    await client.query(options.dry_run ? "ROLLBACK" : "COMMIT");
    return summary;
  } catch (caught_error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw caught_error;
  } finally {
    client.release();
  }
}
