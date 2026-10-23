/**
 * Pulls every NYC coffee, bakery, donut and bagel establishment (plus every
 * establishment named like a brand we track) from NYC Open Data into the admin
 * review queue. Nothing is published: admins approve storefronts at /admin/storefronts.
 *
 *   npm run db:import:storefronts -- --dry-run     fetch, match and count; save nothing
 *   npm run db:import:storefronts                  local database
 *   npm run db:import:storefronts -- --yes         required when DATABASE_URL is not local
 *
 * Source: NYC DOHMH Restaurant Inspection Results (dataset 43nn-pn8j), updated daily.
 * Re-running is safe and keeps every review decision. Set NYC_OPEN_DATA_APP_TOKEN
 * (free) to avoid NYC Open Data's anonymous rate limits.
 */
import { Pool } from "pg";
import { assert_write_allowed, describe_database_target, load_local_env } from "@/lib/import/cli";
import { fetch_market_id } from "@/lib/import/boundaries";
import {
  NYC_DOHMH_ATTRIBUTION,
  build_candidates,
  fetch_dohmh_establishments,
  fetch_matchable_brands,
  upsert_storefront_candidates,
} from "@/lib/import/storefronts";

async function main(): Promise<void> {
  const flags = new Set(process.argv.slice(2));
  const dry_run = flags.has("--dry-run");

  load_local_env();
  const target = describe_database_target(process.env.DATABASE_URL);
  assert_write_allowed(target, dry_run, flags.has("--yes"));

  console.log(`Target database: ${target.description}${dry_run ? " (dry run, nothing will be saved)" : ""}`);
  const ssl = target.is_local ? undefined : { rejectUnauthorized: false };
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, ssl });
  try {
    const market_id = await fetch_market_id(pool, "nyc");
    const brands = await fetch_matchable_brands(pool, market_id);
    console.log(`Matching against ${brands.length} brands. Fetching ${NYC_DOHMH_ATTRIBUTION}…`);

    const establishments = await fetch_dohmh_establishments(brands, {
      app_token: process.env.NYC_OPEN_DATA_APP_TOKEN?.trim() || null,
    });
    const candidates = build_candidates(establishments, brands);
    const summary = await upsert_storefront_candidates(pool, market_id, candidates, establishments.length, { dry_run });

    console.log(
      [
        `${establishments.length} establishments fetched; ${summary.candidates} in scope ` +
          `(${summary.inserted} new, ${summary.updated} refreshed).`,
        `  ${summary.exact} match a tracked brand, ${summary.possible} are possible matches to confirm, ` +
          `${summary.unmatched} are possible independents.`,
        `  ${summary.already_listed} are already on the map; ${summary.missing_coordinates} have no coordinates yet.`,
        `${dry_run ? "Would leave" : "Review queue now has"} ${summary.pending_total} pending storefronts: /admin/storefronts`,
      ].join("\n"),
    );
  } finally {
    await pool.end();
  }
}

main().catch((caught_error: unknown) => {
  console.error(caught_error instanceof Error ? caught_error.message : caught_error);
  process.exitCode = 1;
});
