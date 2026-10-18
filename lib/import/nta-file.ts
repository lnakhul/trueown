import { readFileSync } from "fs";
import { resolve } from "path";
import type { Pool } from "pg";
import { import_boundaries, parse_nta_geojson } from "@/lib/import/nta";

/** Committed copy of the official file (see data/nyc/nta_2020.provenance.json). */
export const NTA_GEOJSON_PATH = resolve("data/nyc/nta_2020.geojson");
export const NTA_PROVENANCE_PATH = resolve("data/nyc/nta_2020.provenance.json");

export function read_committed_nta_records(): ReturnType<typeof parse_nta_geojson> {
  return parse_nta_geojson(JSON.parse(readFileSync(NTA_GEOJSON_PATH, "utf8")));
}

/**
 * Loads the committed NTA file when the table is empty (fresh database, CI, tests).
 * Idempotent and offline. Returns the number of boundaries now present.
 */
export async function ensure_boundaries_loaded(pool: Pool): Promise<number> {
  const existing = await pool.query<{ total: number }>(
    "SELECT count(*)::int AS total FROM neighborhood_boundaries",
  );
  const total = existing.rows[0]?.total ?? 0;
  if (total > 0) return total;

  const parsed = read_committed_nta_records();
  if (parsed.errors.length > 0) {
    throw new Error(`Committed boundary file is invalid: ${parsed.errors.join("; ")}`);
  }
  const summary = await import_boundaries(pool, parsed.records);
  return summary.total;
}
