/**
 * Loads brand-level rows (no storefronts) from a CSV.
 *
 *   npm run db:import:brands -- your_brands.csv --dry-run
 *   npm run db:import:brands -- your_brands.csv          (local database)
 *   npm run db:import:brands -- your_brands.csv --yes    (non-local database)
 */
import { readFileSync } from "fs";
import { Pool } from "pg";
import { import_brands, parse_brand_csv } from "@/lib/import/brands";
import { assert_write_allowed, describe_database_target, load_local_env } from "@/lib/import/cli";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((argument) => argument.startsWith("--")));
  const file_path = argv.find((argument) => !argument.startsWith("--"));
  const dry_run = flags.has("--dry-run");
  if (!file_path) throw new Error("Usage: npm run db:import:brands -- <file.csv> [--dry-run] [--yes]");

  load_local_env();
  const target = describe_database_target(process.env.DATABASE_URL);
  assert_write_allowed(target, dry_run, flags.has("--yes"));

  const parsed = parse_brand_csv(readFileSync(file_path, "utf8"));
  parsed.warnings.forEach((message) => console.warn(`Warning: ${message}`));
  if (parsed.errors.length > 0) {
    console.error("Validation failed; nothing was imported:");
    parsed.errors.forEach((message) => console.error(`  - ${message}`));
    process.exitCode = 1;
    return;
  }

  console.log(`Target database: ${target.description}${dry_run ? " (dry run, nothing will be saved)" : ""}`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const summary = await import_brands(pool, parsed.rows, { dry_run });
    if (summary.errors.length > 0) {
      console.error("Import aborted and rolled back:");
      summary.errors.forEach((message) => console.error(`  - ${message}`));
      process.exitCode = 1;
      return;
    }
    console.log(
      `${dry_run ? "Would import" : "Imported"} ${parsed.rows.length} brands: ` +
        `${summary.brands_created} created, ${summary.brands_updated} updated. No storefronts were added.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Import failed");
  process.exitCode = 1;
});
