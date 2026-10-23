/**
 * Creates or refreshes rows in the `markets` table from data/markets/<slug>/market.json.
 *
 *   npm run db:import:markets -- --dry-run         show what would change
 *   npm run db:import:markets                      upsert (local database)
 *   npm run db:import:markets -- --apply-status    also apply each file's status to existing markets
 *   npm run db:import:markets -- --yes             required when DATABASE_URL is not local
 *
 * New markets take the status in their file. Existing markets keep their live
 * status unless --apply-status is passed, so a re-run never silently switches a
 * market on or off.
 */
import { Pool } from "pg";
import { assert_write_allowed, describe_database_target, load_local_env } from "@/lib/import/cli";
import { upsert_markets } from "@/lib/import/markets";
import { load_market_configs } from "@/lib/markets/config";

async function main(): Promise<void> {
  const flags = new Set(process.argv.slice(2));
  const dry_run = flags.has("--dry-run");

  load_local_env();
  const target = describe_database_target(process.env.DATABASE_URL);
  assert_write_allowed(target, dry_run, flags.has("--yes"));

  const configs = load_market_configs();
  if (configs.length === 0) throw new Error("No market configs found in data/markets/.");

  console.log(`Target database: ${target.description}${dry_run ? " (dry run, nothing will be saved)" : ""}`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const outcomes = await upsert_markets(pool, configs, { dry_run, apply_status: flags.has("--apply-status") });
    outcomes.forEach((outcome) => {
      const status_note =
        outcome.status_kept_from !== null ? ` (kept live status '${outcome.status}'; file says '${outcome.status_kept_from}')` : "";
      console.log(`  ${outcome.action.padEnd(9)} ${outcome.slug.padEnd(10)} ${outcome.status}${status_note}`);
    });
  } finally {
    await pool.end();
  }
}

main().catch((caught_error: unknown) => {
  console.error(caught_error instanceof Error ? caught_error.message : caught_error);
  process.exitCode = 1;
});
