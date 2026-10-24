/**
 * Looks for ownership changes at the brands on the map: news articles (GDELT) and
 * SEC filings that name a brand next to an acquisition, investment or IPO. New
 * finds go to the admin Alerts page for review; nothing on a listing changes.
 *
 *   npm run db:watch:ownership -- --dry-run --limit 5     try a few, save nothing
 *   npm run db:watch:ownership -- --brand "Blank Street Coffee" --dry-run
 *   npm run db:watch:ownership                            local database
 *   npm run db:watch:ownership -- --yes                   required when DATABASE_URL is not local
 *
 * OWNERSHIP_WATCH_CONTACT (an email) is required: the SEC asks every automated
 * client to name a contact. Brands checked in the last 6 days are skipped
 * (--recheck to redo them), so runs can be stopped and resumed. GDELT allows one
 * request every 5 seconds, so expect about 6 seconds per brand.
 */
import { Pool } from "pg";
import { assert_write_allowed, describe_database_target, load_local_env } from "@/lib/import/cli";
import {
  fetch_brands_to_watch,
  fetch_filing_alerts,
  fetch_news_alerts,
  save_watch_results,
  type AlertCandidate,
} from "@/lib/import/ownership-watch";

const RECHECK_AFTER_DAYS = 6;

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
  const limit_text = option_value(argv, "--limit");
  const limit = limit_text ? Number(limit_text) : null;
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) throw new Error("--limit must be a positive whole number.");
  const brand_name = option_value(argv, "--brand");
  const use_news = !flags.has("--filings-only");
  const use_filings = !flags.has("--news-only");

  load_local_env();
  const contact = process.env.OWNERSHIP_WATCH_CONTACT?.trim();
  if (!contact || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(contact)) {
    throw new Error("Set OWNERSHIP_WATCH_CONTACT to a contact email (the SEC requires one for automated requests).");
  }
  const user_agent = `TrueOwn ownership watch (${contact})`;
  const target = describe_database_target(process.env.DATABASE_URL);
  assert_write_allowed(target, dry_run, flags.has("--yes"));

  console.log(`Target database: ${target.description}${dry_run ? " (dry run, nothing will be saved)" : ""}`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, ssl: target.is_local ? undefined : { rejectUnauthorized: false } });
  try {
    const brands = await fetch_brands_to_watch(pool, {
      recheck_after_days: flags.has("--recheck") ? 0 : RECHECK_AFTER_DAYS,
      limit,
      name: brand_name,
    });
    if (brand_name && brands.length === 0) throw new Error(`No brand on the map is named '${brand_name}'.`);
    console.log(`Checking ${brands.length} brands${use_news ? " in the news (GDELT)" : ""}${use_news && use_filings ? " and" : ""}${use_filings ? " in SEC filings" : ""}…`);

    const totals = { checked: 0, found: 0, saved: 0, lookups: 0, errors: 0 };
    for (const brand of brands) {
      const alerts: AlertCandidate[] = [];
      let failed = false;
      for (const [enabled, label, run] of [
        [use_news, "news", fetch_news_alerts],
        [use_filings, "filings", fetch_filing_alerts],
      ] as const) {
        if (!enabled) continue;
        totals.lookups += 1;
        try {
          alerts.push(...(await run(brand, { user_agent })));
        } catch (caught_error) {
          failed = true;
          totals.errors += 1;
          console.error(`  ${brand.name} (${label}): ${caught_error instanceof Error ? caught_error.message : caught_error}`);
        }
      }
      totals.checked += 1;
      totals.found += alerts.length;
      if (dry_run) {
        for (const alert of alerts) console.log(`  ${brand.name}: [${alert.signal}, ${alert.score}] ${alert.title}\n      ${alert.url}`);
      } else if (!failed) {
        // A failed source is retried next run: the brand is not marked as checked.
        totals.saved += await save_watch_results(pool, brand.id, alerts);
      } else if (alerts.length > 0) {
        totals.saved += await save_watch_results(pool, brand.id, alerts, new Date(0));
      }
      if (totals.checked % 25 === 0) console.log(`  …${totals.checked}/${brands.length}`);
    }

    console.log(
      `Checked ${totals.checked} brands: ${totals.found} possible ownership changes found` +
        (dry_run ? "." : `, ${totals.saved} new for review.`) +
        (totals.errors > 0 ? ` ${totals.errors} lookups failed and will be retried next run.` : ""),
    );
    // A few failed lookups are normal (GDELT is often busy) and are retried next run;
    // only fail the run when nothing worked, which points at a setup or network problem.
    if (totals.lookups > 0 && totals.errors === totals.lookups) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

main().catch((caught_error: unknown) => {
  console.error(caught_error instanceof Error ? caught_error.message : caught_error);
  process.exitCode = 1;
});
