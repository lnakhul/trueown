/**
 * Bulk-loads vetted brands and storefronts from a CSV (template: data/templates/venues_template.csv).
 *
 *   npm run db:import:venues -- path/to/venues.csv --dry-run   validate everything, save nothing
 *   npm run db:import:venues -- path/to/venues.csv             import (local database)
 *   npm run db:import:venues -- path/to/venues.csv --yes       required when DATABASE_URL is not local
 *
 * The import is all-or-nothing: any validation or database problem aborts it.
 */
import { readFileSync } from "fs";
import { Pool } from "pg";
import { import_venues, parse_venue_csv } from "@/lib/import/venues";
import { assert_write_allowed, describe_database_target, load_local_env } from "@/lib/import/cli";

function print_problems(label: string, problems: string[]): void {
  if (problems.length === 0) return;
  console.error(`${label} (${problems.length}):`);
  problems.slice(0, 50).forEach((message) => console.error(`  - ${message}`));
  if (problems.length > 50) console.error(`  ...and ${problems.length - 50} more.`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((argument) => argument.startsWith("--")));
  const file_path = argv.find((argument) => !argument.startsWith("--"));
  const dry_run = flags.has("--dry-run");

  if (!file_path) {
    throw new Error("Usage: npm run db:import:venues -- <file.csv> [--dry-run] [--yes]");
  }

  load_local_env();
  const target = describe_database_target(process.env.DATABASE_URL);
  assert_write_allowed(target, dry_run, flags.has("--yes"));

  const parsed = parse_venue_csv(readFileSync(file_path, "utf8"));
  if (parsed.errors.length > 0) {
    print_problems("Validation failed; nothing was imported", parsed.errors);
    process.exitCode = 1;
    return;
  }

  console.log(`Target database: ${target.description}${dry_run ? " (dry run, nothing will be saved)" : ""}`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const summary = await import_venues(pool, parsed.rows, { dry_run });
    print_problems("Warnings", summary.warnings);
    if (summary.errors.length > 0) {
      print_problems("Import aborted and rolled back", summary.errors);
      process.exitCode = 1;
      return;
    }
    console.log(
      `${dry_run ? "Would import" : "Imported"} ${parsed.rows.length} rows: ` +
        `${summary.brands_created} brands created, ${summary.brands_updated} updated; ` +
        `${summary.locations_created} storefronts created, ${summary.locations_skipped} already present.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((caught_error: unknown) => {
  console.error(caught_error instanceof Error ? caught_error.message : caught_error);
  process.exitCode = 1;
});
