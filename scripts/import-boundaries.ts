/**
 * Loads a market's official neighborhood polygons into neighborhood_boundaries.
 * The source and property mapping come from data/markets/<slug>/market.json.
 *
 *   npm run db:import:boundaries                              NYC, from the committed file
 *   npm run db:import:boundaries -- --market chicago --download   fetch, save a normalized copy, import
 *   npm run db:import:boundaries -- --market austin --file f.geojson
 *   npm run db:import:boundaries -- --dry-run                 validate + load inside a rolled-back transaction
 *   npm run db:import:boundaries -- --yes                     required when DATABASE_URL is not a local database
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { Pool } from "pg";
import {
  download_boundary_geojson,
  import_market_boundaries,
  normalize_boundary_geojson,
  parse_boundary_geojson,
  sha256_of,
} from "@/lib/import/boundaries";
import { assert_write_allowed, describe_database_target, load_local_env } from "@/lib/import/cli";
import { find_market_config } from "@/lib/markets/config";

function option_value(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value.`);
  return value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((argument) => argument.startsWith("--")));
  const dry_run = flags.has("--dry-run");
  const slug = option_value(argv, "--market") ?? "nyc";
  const explicit_file = option_value(argv, "--file");

  load_local_env();
  const target = describe_database_target(process.env.DATABASE_URL);
  assert_write_allowed(target, dry_run, flags.has("--yes"));

  const market = find_market_config(slug);
  const source = market.boundaries;
  if (!source) throw new Error(`Market "${slug}" has no boundary source configured.`);

  // Committed copy if the config names one, otherwise the market's own folder.
  const saved_path = resolve(source.committed_file ?? `data/markets/${slug}/boundaries.geojson`);
  const provenance_path = saved_path.replace(/\.geojson$/, ".provenance.json");

  if (flags.has("--download")) {
    console.log(`Downloading ${source.download_url}`);
    const normalized = JSON.stringify(normalize_boundary_geojson(await download_boundary_geojson(source.download_url), source));
    const check = parse_boundary_geojson(JSON.parse(normalized), source);
    if (check.errors.length > 0) throw new Error(`Downloaded file is invalid:\n  ${check.errors.join("\n  ")}`);
    mkdirSync(dirname(saved_path), { recursive: true });
    writeFileSync(saved_path, normalized);
    writeFileSync(
      provenance_path,
      `${JSON.stringify(
        {
          dataset: source.dataset,
          publisher: source.publisher,
          source_url: source.download_url,
          retrieved_at: new Date().toISOString(),
          feature_count: check.records.length,
          sha256: sha256_of(normalized),
          normalization: `properties trimmed to ${Object.values(source.properties).filter(Boolean).join("/")}; coordinates rounded to 6 decimals`,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`Saved ${check.records.length} features to ${saved_path}`);
  }

  const file_path = explicit_file ? resolve(explicit_file) : saved_path;
  if (!existsSync(file_path)) {
    throw new Error(`No boundary file for "${slug}" at ${file_path}. Re-run with --download or --file <path>.`);
  }
  const parsed = parse_boundary_geojson(JSON.parse(readFileSync(file_path, "utf8")), source);
  if (parsed.errors.length > 0) {
    console.error(`Invalid boundary file (${parsed.errors.length} problems):`);
    parsed.errors.slice(0, 20).forEach((message) => console.error(`  - ${message}`));
    process.exitCode = 1;
    return;
  }

  console.log(`Target database: ${target.description}${dry_run ? " (dry run, nothing will be saved)" : ""}`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const summary = await import_market_boundaries(pool, market as typeof market & { boundaries: NonNullable<typeof source> }, parsed.records, { dry_run });
    console.log(
      `${dry_run ? "Would load" : "Loaded"} ${summary.total} ${market.city_name} boundaries (${summary.inserted} new, ${summary.updated} updated).`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((caught_error: unknown) => {
  console.error(caught_error instanceof Error ? caught_error.message : caught_error);
  process.exitCode = 1;
});
