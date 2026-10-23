/**
 * Fills blank latitude/longitude in a venues CSV from the street addresses.
 *
 *   npm run db:geocode:venues -- data/markets/nyc/venues.csv
 *     -> writes data/markets/nyc/venues.geocoded.csv   (review it, then import it)
 *     -> writes data/markets/nyc/venues.geocode-report.csv
 *
 *   --out <file>      where to write the filled CSV
 *   --report <file>   where to write the per-row report
 *
 * Nothing is written to the database. Only exact house-number matches inside the
 * row's market are filled; every other row is left blank and listed in the report.
 * Follows the Nominatim usage policy: at most 1 request per second, an identifying
 * User-Agent (set GEOCODER_USER_AGENT with your contact), and a local cache in
 * .cache/geocode-venues.json so re-runs do not repeat requests.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { parse } from "csv-parse/sync";
import { load_local_env } from "@/lib/import/cli";
import {
  geocode_venue_table,
  nominatim_search_url,
  parse_nominatim_results,
  to_csv,
  type CsvTable,
  type GeocodeCandidate,
  type GeocodeLookup,
} from "@/lib/import/geocode-venues";
import { geocoder_base_url, geocoder_user_agent } from "@/lib/geocoding";
import { load_market_configs } from "@/lib/markets/config";

const CACHE_PATH = resolve(".cache/geocode-venues.json");
const MIN_INTERVAL_MS = 1100;
const REQUEST_TIMEOUT_MS = 10_000;

function option_value(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value.`);
  return value;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve_sleep) => setTimeout(resolve_sleep, milliseconds));
}

function read_cache(): Record<string, GeocodeCandidate[]> {
  if (!existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8")) as Record<string, GeocodeCandidate[]>;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const input_path = argv.find((argument, index) => !argument.startsWith("--") && !argv[index - 1]?.startsWith("--"));
  if (!input_path) throw new Error("Usage: npm run db:geocode:venues -- <venues.csv> [--out file] [--report file]");
  load_local_env();

  const base_path = input_path.replace(/\.csv$/i, "");
  const out_path = resolve(option_value(argv, "--out") ?? `${base_path}.geocoded.csv`);
  const report_path = resolve(option_value(argv, "--report") ?? `${base_path}.geocode-report.csv`);
  if (out_path === resolve(input_path)) throw new Error("--out must not overwrite the input file.");

  const records = parse(readFileSync(input_path, "utf8"), {
    bom: true,
    skip_empty_lines: true,
    info: true,
    relax_column_count: false,
  }) as unknown as Array<{ record: string[]; info: { lines: number } }>;
  const [header_record, ...body] = records;
  if (!header_record) throw new Error("The file is empty.");
  const table: CsvTable = {
    header: header_record.record.map((column) => column.trim()),
    records: body.map(({ record, info }) => ({ line: info.lines, cells: record })),
  };

  const markets = load_market_configs();
  const cache = read_cache();
  const base_url = geocoder_base_url();
  const user_agent = geocoder_user_agent();
  let last_request_ms = 0;
  let provider_requests = 0;

  const lookup: GeocodeLookup = async (query, market) => {
    const url = nominatim_search_url(base_url, query, market);
    const cache_key = url.search;
    const cached = cache[cache_key];
    if (cached) return cached;

    const wait_ms = last_request_ms + MIN_INTERVAL_MS - Date.now();
    if (wait_ms > 0) await sleep(wait_ms);
    last_request_ms = Date.now();
    provider_requests += 1;
    const response = await fetch(url, {
      headers: { "User-Agent": user_agent, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Geocoder responded with HTTP ${response.status}.`);
    const candidates = parse_nominatim_results(await response.json());
    cache[cache_key] = candidates;
    return candidates;
  };

  const to_geocode = table.records.length;
  console.log(`Geocoding ${to_geocode} rows from ${input_path} (about 1 per second for uncached addresses)…`);
  const result = await geocode_venue_table(table, markets, lookup);

  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache));
  writeFileSync(out_path, to_csv([result.table.header, ...result.table.records.map((record) => record.cells)]));
  writeFileSync(
    report_path,
    to_csv([
      ["line", "brand_name", "address", "status", "query", "matched", "latitude", "longitude", "note"],
      ...result.outcomes.map((outcome) => [
        outcome.line,
        outcome.brand_name,
        outcome.address,
        outcome.status,
        outcome.query,
        outcome.matched,
        outcome.latitude,
        outcome.longitude,
        outcome.note,
      ]),
    ]),
  );

  const counts = result.outcomes.reduce<Record<string, number>>((totals, outcome) => {
    totals[outcome.status] = (totals[outcome.status] ?? 0) + 1;
    return totals;
  }, {});
  console.log(
    `Done (${provider_requests} geocoder requests): ${counts.filled ?? 0} filled, ${counts.kept ?? 0} already had coordinates, ` +
      `${counts.needs_review ?? 0} need review, ${counts.not_found ?? 0} not found, ${counts.error ?? 0} errors.`,
  );
  console.log(`Review: ${report_path}`);
  console.log(`Then import: npm run db:import:venues -- ${out_path} --dry-run`);
  if ((counts.needs_review ?? 0) + (counts.not_found ?? 0) + (counts.error ?? 0) > 0) process.exitCode = 2;
}

main().catch((caught_error: unknown) => {
  console.error(caught_error instanceof Error ? caught_error.message : caught_error);
  process.exitCode = 1;
});
