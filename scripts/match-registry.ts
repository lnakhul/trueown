/**
 * Finds New York State registered entities that may own each possible independent
 * in the NYC storefront queue, so admins can add independents with a registry
 * record as evidence in one click. Suggestions are leads, not evidence by themselves.
 *
 *   npm run db:match:registry -- --limit 50 --dry-run   try a few, save nothing
 *   npm run db:match:registry                           local database
 *   npm run db:match:registry -- --yes                  required when DATABASE_URL is not local
 *
 * Re-running skips shops checked in the last 30 days (--recheck to redo them), so it
 * can be stopped and resumed. About two registry lookups per shop; a free Socrata app
 * token (SOCRATA_APP_TOKEN, or NYC_OPEN_DATA_APP_TOKEN) avoids anonymous rate limits.
 */
import { Pool } from "pg";
import { assert_write_allowed, describe_database_target, load_local_env } from "@/lib/import/cli";
import {
  NYS_REGISTRY_ATTRIBUTION,
  fetch_candidates_to_check,
  save_registry_suggestions,
  suggest_registry_entities,
} from "@/lib/import/registry";

const CONCURRENCY = 4;

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

  load_local_env();
  const target = describe_database_target(process.env.DATABASE_URL);
  assert_write_allowed(target, dry_run, flags.has("--yes"));
  const app_token = process.env.SOCRATA_APP_TOKEN?.trim() || process.env.NYC_OPEN_DATA_APP_TOKEN?.trim() || null;

  console.log(`Target database: ${target.description}${dry_run ? " (dry run, nothing will be saved)" : ""}`);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: CONCURRENCY + 1, ssl: target.is_local ? undefined : { rejectUnauthorized: false } });
  try {
    const candidates = await fetch_candidates_to_check(pool, "nyc", { recheck_after_days: flags.has("--recheck") ? 0 : 30, limit });
    console.log(`Checking ${candidates.length} possible independents against ${NYS_REGISTRY_ATTRIBUTION}…`);

    const totals = { checked: 0, strong: 0, likely: 0, name_only: 0, none: 0, errors: 0 };
    let next = 0;
    async function worker(): Promise<void> {
      while (next < candidates.length) {
        const candidate = candidates[next]!;
        next += 1;
        try {
          const suggestions = await suggest_registry_entities(candidate, { app_token });
          const best = suggestions[0]?.match_reason;
          if (best === "name_at_address") totals.strong += 1;
          else if (best === "business_at_address") totals.likely += 1;
          else if (best === "name_elsewhere") totals.name_only += 1;
          else totals.none += 1;
          if (!dry_run) await save_registry_suggestions(pool, candidate.id, suggestions);
          if (dry_run && suggestions[0]) {
            console.log(`  ${candidate.name} -> ${suggestions[0].entity_name} (${suggestions[0].match_reason}, ${suggestions[0].score})`);
          }
        } catch (caught_error) {
          totals.errors += 1;
          console.error(`  ${candidate.name}: ${caught_error instanceof Error ? caught_error.message : caught_error}`);
        }
        totals.checked += 1;
        if (totals.checked % 100 === 0) console.log(`  …${totals.checked}/${candidates.length}`);
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    console.log(
      `Checked ${totals.checked}: ${totals.strong} strong (same name at the address), ${totals.likely} likely ` +
        `(a food business at the address), ${totals.name_only} name only, ${totals.none} with no suggestion, ${totals.errors} errors.`,
    );
    if (totals.errors > 0) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

main().catch((caught_error: unknown) => {
  console.error(caught_error instanceof Error ? caught_error.message : caught_error);
  process.exitCode = 1;
});
