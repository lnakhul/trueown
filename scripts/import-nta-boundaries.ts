/**
 * Loads NYC 2020 Neighborhood Tabulation Areas into neighborhood_boundaries.
 *
 *   npm run db:import:boundaries -- --download     fetch from NYC Open Data, refresh the committed file, import
 *   npm run db:import:boundaries                   import the committed file (data/nyc/nta_2020.geojson)
 *   npm run db:import:boundaries -- --dry-run      validate + load inside a rolled-back transaction
 *   npm run db:import:boundaries -- --yes          required when DATABASE_URL is not a local database
 */
import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { Pool } from "pg";
import {
  NTA_2020_DOWNLOAD_URL,
  download_nta_geojson,
  import_boundaries,
  normalize_nta_geojson,
  parse_nta_geojson,
  sha256_of,
} from "@/lib/import/nta";
import { NTA_GEOJSON_PATH, NTA_PROVENANCE_PATH, read_committed_nta_records } from "@/lib/import/nta-file";
import { assert_write_allowed, describe_database_target, load_local_env } from "@/lib/import/cli";

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const dry_run = args.has("--dry-run");

  load_local_env();
  const target = describe_database_target(process.env.DATABASE_URL);
  assert_write_allowed(target, dry_run, args.has("--yes"));

  if (args.has("--download")) {
    console.log(`Downloading ${NTA_2020_DOWNLOAD_URL}`);
    const normalized = JSON.stringify(normalize_nta_geojson(await download_nta_geojson()));
    const check = parse_nta_geojson(JSON.parse(normalized));
    if (check.errors.length > 0) throw new Error(`Downloaded file is invalid:\n  ${check.errors.join("\n  ")}`);
    mkdirSync(dirname(NTA_GEOJSON_PATH), { recursive: true });
    writeFileSync(NTA_GEOJSON_PATH, normalized);
    writeFileSync(
      NTA_PROVENANCE_PATH,
      `${JSON.stringify(
        {
          dataset: "2020 Neighborhood Tabulation Areas (NTAs)",
          publisher: "Department of City Planning (DCP) via NYC Open Data",
          dataset_id: "9nt8-h7nd",
          source_url: NTA_2020_DOWNLOAD_URL,
          retrieved_at: new Date().toISOString(),
          feature_count: check.records.length,
          sha256: sha256_of(normalized),
          normalization: "properties trimmed to nta2020/ntaname/boroname/ntatype; coordinates rounded to 6 decimals",
        },
        null,
        2,
      )}\n`,
    );
    console.log(`Saved ${check.records.length} features to ${NTA_GEOJSON_PATH}`);
  }

  const parsed = read_committed_nta_records();
  if (parsed.errors.length > 0) {
    console.error(`Invalid boundary file (${parsed.errors.length} problems):`);
    parsed.errors.slice(0, 20).forEach((message) => console.error(`  - ${message}`));
    process.exitCode = 1;
    return;
  }

  console.log(`Target database: ${target.description}${dry_run ? " (dry run, nothing will be saved)" : ""}`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const summary = await import_boundaries(pool, parsed.records, { dry_run });
    console.log(
      `${dry_run ? "Would load" : "Loaded"} ${summary.total} boundaries (${summary.inserted} new, ${summary.updated} updated).`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((caught_error: unknown) => {
  console.error(caught_error instanceof Error ? caught_error.message : caught_error);
  process.exitCode = 1;
});
