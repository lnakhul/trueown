import { request as https_request } from "node:https";
import type { Pool } from "pg";
import { names_match } from "@/lib/import/registry";

/**
 * Ownership-change watch: finds news articles and SEC filings that name a tracked
 * brand next to a deal signal, for an admin to review. Nothing here changes a
 * listing; an alert is a lead.
 *
 * Sources (both free, no key):
 *   - GDELT DOC 2.0 (api.gdeltproject.org): worldwide online news, about the last
 *     three months. Asks for at most one request every five seconds.
 *   - SEC EDGAR full-text search (efts.sec.gov): filings since 2001. Form D (a
 *     private fundraise), mergers and tender offers, and IPO registrations. The
 *     SEC requires a User-Agent that names a contact.
 */

export type AlertSource = "gdelt_news" | "sec_edgar";
export type AlertSignal = "acquisition" | "investment" | "public_offering";

export interface WatchedBrand {
  id: string;
  name: string;
  corporate_tier: 1 | 2 | 3;
  parent_entity: string | null;
  financial_backers: string[];
  /** When the watcher last checked this brand; null on the first run. */
  checked_at: Date | null;
}

export interface AlertCandidate {
  source: AlertSource;
  url: string;
  title: string;
  publisher: string | null;
  published_at: Date | null;
  signal: AlertSignal;
  matched_terms: string[];
  score: number;
}

/** Alerts below this score are not saved. */
export const MIN_ALERT_SCORE = 50;
export const GDELT_DOC_URL = "https://api.gdeltproject.org/api/v2/doc/doc";
export const SEC_SEARCH_URL = "https://efts.sec.gov/LATEST/search-index";
/** GDELT keeps about three months of articles. */
const GDELT_MAX_LOOKBACK_DAYS = 90;
const SEC_FIRST_RUN_LOOKBACK_DAYS = 365;

/* -------------------------------------------------------------------------- */
/* Matching                                                                    */
/* -------------------------------------------------------------------------- */

const LEGAL_SUFFIXES = new Set(["co", "inc", "llc", "ltd", "corp", "company", "the"]);
/** A one-word brand name ("Maman") must appear with one of these, or it is too ambiguous. */
const CONTEXT_WORDS =
  /\b(coffee|cafe|cafes|caf[eé]|bakery|bakeries|bagels?|donuts?|doughnuts?|tea|chain|restaurants?|eatery|shops?|brand|franchise|stores?|locations)\b/;

/** Lowercase, straight apostrophes removed, other punctuation as spaces. */
export function normalize_text(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’'`]s\b/g, "")
    .replace(/[’'`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function brand_phrase(name: string): string[] {
  const words = normalize_text(name).split(" ").filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1]!)) words.pop();
  while (words.length > 1 && words[0] === "the") words.shift();
  return words;
}

/** Words news often leaves off a brand's name ("Blank Street" for Blank Street Coffee). */
const GENERIC_TRAILING_WORDS = new Set([
  "coffee", "cafe", "caffe", "bakery", "bakeshop", "roasters", "roastery", "roasting", "bagels", "bagel", "donuts", "doughnuts",
  "tea", "espresso", "kitchen", "nyc",
]);

/** The full name, plus the name without trailing generic words when something distinctive is left. */
export function brand_aliases(name: string): string[][] {
  const full = brand_phrase(name);
  const short = [...full];
  while (short.length > 1 && GENERIC_TRAILING_WORDS.has(short[short.length - 1]!)) short.pop();
  return short.length < full.length ? [full, short] : [full];
}

/** The phrase used in search queries: the short name when it is still two or more words. */
export function search_phrase(name: string): string {
  const aliases = brand_aliases(name);
  const short = aliases[aliases.length - 1]!;
  return (short.length >= 2 ? short : aliases[0]!).join(" ");
}

/**
 * The brand's name appears as whole words ("Blank Street" in "Blank Street raises…").
 * A one-word name (or one-word short name) needs a business word in the same text.
 */
export function mentions_brand(text: string, brand_name: string): boolean {
  const haystack = ` ${normalize_text(text)} `;
  return brand_aliases(brand_name).some(
    (phrase) => phrase.length > 0 && haystack.includes(` ${phrase.join(" ")} `) && (phrase.length > 1 || CONTEXT_WORDS.test(haystack)),
  );
}

/**
 * The headline names the listed parent, and the parent is not just the brand's own
 * company ("Blank Street Inc." for Blank Street Coffee does not count).
 */
function names_distinct_owner(title: string, brand_name: string, parent_entity: string): boolean {
  const parent = brand_phrase(parent_entity).join(" ");
  const brand = brand_phrase(brand_name).join(" ");
  if (!parent || brand.includes(parent) || parent.includes(brand)) return false;
  // Drop generic company words so "Turner Image Capital" matches "Turner Image".
  const core = parent.replace(/\b(capital|partners|group|holdings|management|equity|ventures|fund|lp|llc|inc)\b/g, "").replace(/\s+/g, " ").trim();
  return ` ${normalize_text(title)} `.includes(` ${core || parent} `);
}

const SIGNAL_PATTERNS: Array<{ signal: AlertSignal; pattern: RegExp }> = [
  { signal: "acquisition", pattern: /\b(acquires?|acquired|acquiring|acquisition|buyout|buys|bought|to buy|takes? over|takeover|merger|merges?|merging|sold to|sells? (?:\w+ ){0,3}to|sale of|majority stake|controlling stake|private equity)\b/g },
  { signal: "public_offering", pattern: /\b(ipo|initial public offering|goes public|going public|go public|files? to go public|spac)\b/g },
  { signal: "investment", pattern: /\b(raises?|raised|raising|funding|funded|investment|invests?|invested|investor|minority stake|stake in|series [a-f]|growth equity|venture capital|backed by|backs|valuation)\b/g },
];

const BASE_SCORE: Record<AlertSignal, number> = { acquisition: 70, public_offering: 60, investment: 55 };

/**
 * Scores a headline about `brand`. Returns null when the brand is not named or no
 * deal word appears. The strongest signal wins; several signals add a little.
 *   + an independent being bought or funded is the change that matters most
 *   - funding news for a brand already listed as VC-funded is expected
 *   - naming the current owner usually means the change is already on the listing
 */
export function classify_headline(title: string, brand: Pick<WatchedBrand, "name" | "corporate_tier" | "parent_entity">): {
  signal: AlertSignal;
  matched_terms: string[];
  score: number;
} | null {
  if (!mentions_brand(title, brand.name)) return null;
  const text = normalize_text(title);
  const found: Array<{ signal: AlertSignal; terms: string[] }> = [];
  for (const { signal, pattern } of SIGNAL_PATTERNS) {
    const terms = [...new Set([...text.matchAll(pattern)].map((match) => match[0]))];
    if (terms.length > 0) found.push({ signal, terms });
  }
  if (found.length === 0) return null;
  const strongest = found.reduce((best, entry) => (BASE_SCORE[entry.signal] > BASE_SCORE[best.signal] ? entry : best));
  const matched_terms = found.flatMap((entry) => entry.terms).slice(0, 10);

  let score = BASE_SCORE[strongest.signal] + 5 * (found.length - 1);
  if (brand.corporate_tier === 3 && strongest.signal !== "public_offering") score += 15;
  if (brand.corporate_tier === 2 && strongest.signal === "investment") score -= 10;
  if (brand.parent_entity && names_distinct_owner(title, brand.name, brand.parent_entity)) {
    score -= 15;
    matched_terms.push("names current owner");
  }
  return { signal: strongest.signal, matched_terms, score: Math.max(0, Math.min(100, score)) };
}

/* -------------------------------------------------------------------------- */
/* GDELT news                                                                  */
/* -------------------------------------------------------------------------- */

const NEWS_DEAL_TERMS = [
  "acquired", "acquires", "acquisition", "buys", "stake", "funding", "raises", "investment", "merger", "\"private equity\"", "IPO",
];

function gdelt_datetime(date: Date): string {
  return date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

export function build_gdelt_url(brand: Pick<WatchedBrand, "name">, since: Date, now: Date = new Date()): string {
  const phrase = search_phrase(brand.name);
  const params = new URLSearchParams({
    query: `"${phrase}" (${NEWS_DEAL_TERMS.join(" OR ")}) sourcelang:english`,
    mode: "artlist",
    format: "json",
    maxrecords: "75",
    sort: "datedesc",
    startdatetime: gdelt_datetime(since),
    enddatetime: gdelt_datetime(now),
  });
  return `${GDELT_DOC_URL}?${params.toString()}`;
}

interface GdeltArticle {
  url?: unknown;
  title?: unknown;
  seendate?: unknown;
  domain?: unknown;
}

function parse_gdelt_date(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) return null;
  const date = new Date(Date.UTC(+match[1]!, +match[2]! - 1, +match[3]!, +match[4]!, +match[5]!, +match[6]!));
  return Number.isNaN(date.getTime()) ? null : date;
}

function clean_title(title: string): string {
  return title.replace(/\s+/g, " ").trim().slice(0, 500);
}

export function parse_gdelt_articles(body: unknown, brand: WatchedBrand): AlertCandidate[] {
  const articles = (body as { articles?: GdeltArticle[] } | null)?.articles;
  if (!Array.isArray(articles)) return [];
  const alerts: AlertCandidate[] = [];
  for (const article of articles) {
    if (typeof article.url !== "string" || typeof article.title !== "string") continue;
    if (!/^https:\/\/[^\s/]+\.[^\s/]{2,}(\/\S*)?$/i.test(article.url) || article.url.length > 2000) continue;
    const title = clean_title(article.title);
    const classified = classify_headline(title, brand);
    if (!classified || classified.score < MIN_ALERT_SCORE) continue;
    alerts.push({
      source: "gdelt_news",
      url: article.url,
      title,
      publisher: typeof article.domain === "string" ? article.domain.slice(0, 200) : null,
      published_at: parse_gdelt_date(article.seendate),
      ...classified,
    });
  }
  return alerts;
}

/* -------------------------------------------------------------------------- */
/* SEC EDGAR full-text search                                                  */
/* -------------------------------------------------------------------------- */

const SEC_FORMS: Record<string, { signal: AlertSignal; label: string }> = {
  D: { signal: "investment", label: "Form D (private fundraise)" },
  "D/A": { signal: "investment", label: "Form D amendment (private fundraise)" },
  "8-K": { signal: "acquisition", label: "Form 8-K (material event)" },
  "425": { signal: "acquisition", label: "Merger communication (Rule 425)" },
  "SC TO-T": { signal: "acquisition", label: "Tender offer (SC TO-T)" },
  "SC 13D": { signal: "acquisition", label: "Ownership stake over 5% (SC 13D)" },
  DEFM14A: { signal: "acquisition", label: "Merger proxy (DEFM14A)" },
  "S-1": { signal: "public_offering", label: "IPO registration (S-1)" },
  "F-1": { signal: "public_offering", label: "IPO registration (F-1)" },
};

export function build_sec_url(brand: Pick<WatchedBrand, "name">, since: Date, now: Date = new Date()): string {
  const day = (date: Date) => date.toISOString().slice(0, 10);
  const params = new URLSearchParams({
    q: `"${search_phrase(brand.name)}"`,
    forms: Object.keys(SEC_FORMS).join(","),
    dateRange: "custom",
    startdt: day(since),
    enddt: day(now),
  });
  return `${SEC_SEARCH_URL}?${params.toString()}`;
}

/** Public index page of one filing, e.g. https://www.sec.gov/Archives/edgar/data/1815159/000101359420000624/0001013594-20-000624-index.htm */
export function sec_filing_url(cik: string, accession: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}/${accession}-index.htm`;
}

interface SecHit {
  _id?: unknown;
  _source?: { ciks?: unknown; display_names?: unknown; form?: unknown; file_date?: unknown; adsh?: unknown };
}

/** "Blank Street Inc.  (CIK 0001815159)" -> "Blank Street Inc." */
function filer_name(display_name: string): string {
  return display_name.replace(/\s*\(CIK \d+\)\s*$/i, "").replace(/\s+/g, " ").trim();
}

/**
 * A filing counts when the brand itself filed it (its name matches the filer), or
 * when it is a merger, tender-offer or IPO document that names a multi-word brand.
 * One-word names in someone else's filing are too ambiguous.
 */
export function parse_sec_hits(body: unknown, brand: WatchedBrand): AlertCandidate[] {
  const hits = (body as { hits?: { hits?: SecHit[] } } | null)?.hits?.hits;
  if (!Array.isArray(hits)) return [];
  const by_accession = new Map<string, AlertCandidate>();
  for (const hit of hits) {
    const source = hit._source ?? {};
    const form = typeof source.form === "string" ? source.form : null;
    const accession = typeof source.adsh === "string" ? source.adsh : typeof hit._id === "string" ? hit._id.split(":")[0]! : null;
    const ciks = Array.isArray(source.ciks) ? source.ciks.filter((cik): cik is string => typeof cik === "string") : [];
    const names = Array.isArray(source.display_names)
      ? source.display_names.filter((name): name is string => typeof name === "string").map(filer_name)
      : [];
    const info = form ? SEC_FORMS[form] : undefined;
    if (!info || !accession || !/^\d{10}-\d{2}-\d{6}$/.test(accession) || ciks.length === 0 || by_accession.has(accession)) continue;

    const filer_index = names.findIndex((name) => names_match(brand.name, name));
    const is_filer = filer_index >= 0;
    if (!is_filer && (info.signal === "investment" || brand_phrase(brand.name).length < 2)) continue;

    let score = BASE_SCORE[info.signal] + (is_filer ? 10 : 0);
    if (brand.corporate_tier === 3 && info.signal !== "public_offering") score += 15;
    if (brand.corporate_tier === 2 && info.signal === "investment") score -= 10;
    score = Math.max(0, Math.min(100, score));
    if (score < MIN_ALERT_SCORE) continue;

    const filer = names[is_filer ? filer_index : 0] ?? "an SEC filer";
    const filed = typeof source.file_date === "string" ? new Date(`${source.file_date}T00:00:00Z`) : null;
    by_accession.set(accession, {
      source: "sec_edgar",
      url: sec_filing_url(ciks[is_filer ? filer_index : 0] ?? ciks[0]!, accession),
      title: clean_title(`${info.label} filed by ${filer}${is_filer ? "" : ` mentioning ${brand.name}`}`),
      publisher: "SEC EDGAR",
      published_at: filed && !Number.isNaN(filed.getTime()) ? filed : null,
      signal: info.signal,
      matched_terms: [form!, is_filer ? "filed by the brand" : "names the brand"],
      score,
    });
  }
  return [...by_accession.values()];
}

/* -------------------------------------------------------------------------- */
/* Fetching (paced)                                                            */
/* -------------------------------------------------------------------------- */

export interface HttpResult {
  status: number;
  text: string;
}
export type HttpGet = (url: string, user_agent: string) => Promise<HttpResult>;

export interface WatchOptions {
  /** Names a contact, as the SEC requires: "TrueOwn ownership watch (you@example.com)". */
  user_agent: string;
  http_get?: HttpGet;
  sleep?: (ms: number) => Promise<void>;
  now?: Date;
}

export const GDELT_MIN_INTERVAL_MS = 6000;
const GDELT_RETRY_WAITS_MS = [30_000, 90_000];
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_RESPONSE_BYTES = 5_000_000;
const default_sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * GET over node:https. GDELT's servers can take ~10 s to finish the TLS handshake,
 * longer than fetch()'s fixed connect timeout, so this allows 45 s overall.
 */
export const https_get: HttpGet = (url, user_agent) =>
  new Promise((resolve, reject) => {
    const request = https_request(url, { headers: { "User-Agent": user_agent, Accept: "application/json" } }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          request.destroy(new Error("Response too large."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error(`Timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`)));
    request.on("error", reject);
    request.end();
  });

let last_gdelt_request_ms = 0;

/** For tests: forget when GDELT was last called. */
export function reset_gdelt_pacing(): void {
  last_gdelt_request_ms = 0;
}

function since_for(brand: WatchedBrand, max_lookback_days: number, now: Date): Date {
  const earliest = new Date(now.getTime() - max_lookback_days * 86_400_000);
  if (!brand.checked_at) return earliest;
  // Overlap a day so nothing published around the last run is missed.
  const since = new Date(brand.checked_at.getTime() - 86_400_000);
  return since > earliest ? since : earliest;
}

/**
 * GDELT answers "Please limit requests…" (or 429) when called too often, and can be
 * slow to connect: both wait and retry, twice.
 */
export async function fetch_news_alerts(brand: WatchedBrand, options: WatchOptions): Promise<AlertCandidate[]> {
  const http_get = options.http_get ?? https_get;
  const sleep = options.sleep ?? default_sleep;
  const now = options.now ?? new Date();
  const url = build_gdelt_url(brand, since_for(brand, GDELT_MAX_LOOKBACK_DAYS, now), now);
  for (let attempt = 0; ; attempt += 1) {
    const wait = last_gdelt_request_ms + GDELT_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last_gdelt_request_ms = Date.now();
    let problem: string;
    try {
      const { status, text } = await http_get(url, options.user_agent);
      if (status === 200 && text.trimStart().startsWith("{")) return parse_gdelt_articles(JSON.parse(text), brand);
      // No results come back as an empty body.
      if (status === 200 && text.trim() === "") return [];
      const throttled = status === 429 || /limit requests/i.test(text);
      if (!throttled) throw new Error(`GDELT ${status}: ${text.slice(0, 120)}`);
      problem = "rate limited";
    } catch (caught_error) {
      if (caught_error instanceof Error && caught_error.message.startsWith("GDELT ")) throw caught_error;
      problem = caught_error instanceof Error ? caught_error.message : String(caught_error);
    }
    if (attempt >= GDELT_RETRY_WAITS_MS.length) throw new Error(`GDELT ${problem}`);
    await sleep(GDELT_RETRY_WAITS_MS[attempt]!);
  }
}

export async function fetch_filing_alerts(brand: WatchedBrand, options: WatchOptions): Promise<AlertCandidate[]> {
  const http_get = options.http_get ?? https_get;
  const now = options.now ?? new Date();
  const { status, text } = await http_get(build_sec_url(brand, since_for(brand, SEC_FIRST_RUN_LOOKBACK_DAYS, now), now), options.user_agent);
  if (status !== 200) throw new Error(`SEC EDGAR ${status}`);
  return parse_sec_hits(JSON.parse(text), brand);
}

/* -------------------------------------------------------------------------- */
/* Database                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Brands on the public map (a location in an active market), least recently
 * checked first, skipping ones checked within `recheck_after_days`.
 */
export async function fetch_brands_to_watch(
  pool: Pick<Pool, "query">,
  options: { recheck_after_days: number; limit: number | null; name: string | null },
): Promise<WatchedBrand[]> {
  const result = await pool.query<{
    id: string;
    name: string;
    corporate_tier: number;
    parent_entity: string | null;
    financial_backers: string[];
    checked_at: Date | null;
  }>(
    `SELECT b.id, b.name, b.corporate_tier, b.parent_entity, b.financial_backers, w.checked_at
       FROM brands b
       LEFT JOIN ownership_watch_state w ON w.brand_id = b.id
      WHERE EXISTS (SELECT 1 FROM locations l JOIN markets m ON m.id = l.market_id AND m.status = 'active'
                     WHERE l.brand_id = b.id)
        AND ($3::text IS NULL OR lower(b.name) = lower($3))
        AND ($3::text IS NOT NULL OR w.checked_at IS NULL OR w.checked_at < now() - make_interval(days => $1))
      ORDER BY w.checked_at NULLS FIRST, b.name
      LIMIT $2`,
    [options.recheck_after_days, options.limit, options.name],
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    corporate_tier: row.corporate_tier as 1 | 2 | 3,
    parent_entity: row.parent_entity,
    financial_backers: row.financial_backers ?? [],
    checked_at: row.checked_at,
  }));
}

/**
 * Saves new alerts (already-seen stories, by URL or title, are skipped, so a
 * dismissed alert never comes back) and records the check. Returns how many were new.
 */
export async function save_watch_results(
  pool: Pick<Pool, "query">,
  brand_id: string,
  alerts: AlertCandidate[],
  checked_at: Date = new Date(),
): Promise<number> {
  let inserted = 0;
  for (const alert of alerts) {
    const result = await pool.query(
      `INSERT INTO ownership_alerts (brand_id, source, url, title, publisher, published_at, signal, matched_terms, score)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT DO NOTHING`,
      [brand_id, alert.source, alert.url, alert.title, alert.publisher, alert.published_at, alert.signal, alert.matched_terms, alert.score],
    );
    inserted += result.rowCount ?? 0;
  }
  await pool.query(
    `INSERT INTO ownership_watch_state (brand_id, checked_at) VALUES ($1, $2)
     ON CONFLICT (brand_id) DO UPDATE SET checked_at = EXCLUDED.checked_at`,
    [brand_id, checked_at],
  );
  return inserted;
}
