import type { Pool } from "pg";
import { normalize_business_name } from "@/lib/import/storefronts";

/**
 * Suggests which New York State registered entity may own a possible independent.
 * Source: NYS Department of State "Active Corporations: Beginning 1800" (data.ny.gov,
 * n9v6-gdp6), updated daily. Shops are listed by the name on their sign; entities by
 * their legal name, so matches combine the name and the registered address.
 * A suggestion is only a lead: an admin decides, and a registry record shows a local
 * entity exists, not that no outside investor is behind it.
 */

export const NYS_REGISTRY = "nys_dos";
export const NYS_ACTIVE_CORPORATIONS_URL = "https://data.ny.gov/resource/n9v6-gdp6.json";
export const NYS_REGISTRY_ATTRIBUTION = "New York State Department of State, Active Corporations (data.ny.gov)";

/** Public, verifiable link to one entity's official record. */
export function registry_record_url(entity_id: string): string {
  return `${NYS_ACTIVE_CORPORATIONS_URL}?dos_id=${encodeURIComponent(entity_id)}`;
}

const LEGAL_SUFFIXES = new Set([
  "LLC", "L L C", "INC", "INCORPORATED", "CORP", "CORPORATION", "CO", "COMPANY", "LTD", "LIMITED", "LP", "LLP", "PLLC", "PC", "THE",
]);
/** Words too common in shop names to identify a business by themselves. */
const GENERIC_WORDS = new Set([
  "THE", "AND", "CAFE", "CAFFE", "COFFEE", "ESPRESSO", "BAKERY", "BAKE", "SHOP", "HOUSE", "BAR", "TEA", "NYC", "NY", "NEW", "YORK", "OF",
  // Address words: "11 Street Cafe" must not match "West 11th Street Block Association".
  "STREET", "ST", "AVENUE", "AVE", "ROAD", "RD", "BOULEVARD", "BLVD", "PLACE", "PL", "LANE", "DRIVE", "WAY", "PLAZA",
  "EAST", "WEST", "NORTH", "SOUTH",
]);
/** An entity named like a food business, registered at the shop's address, is a likely owner. */
const BUSINESS_KEYWORDS = [
  "CAFE", "CAFFE", "COFFEE", "ESPRESSO", "ROAST", "BAKERY", "BAKE", "PASTRY", "PATISSERIE", "BAGEL", "DONUT", "DOUGHNUT",
  "TEA", "BOBA", "DESSERT", "CREPE", "FOOD", "DELI", "KITCHEN", "BREW", "BREAD", "CAKE", "SWEET", "JUICE", "GELATO",
];

export function core_name_tokens(name: string): string[] {
  return normalize_business_name(name)
    .split(" ")
    .filter((word) => word.length > 0 && !LEGAL_SUFFIXES.has(word));
}

function distinctive_tokens(name: string): string[] {
  return core_name_tokens(name).filter((word) => word.length >= 2 && !GENERIC_WORDS.has(word));
}

/**
 * Same business name, ignoring legal suffixes and generic words: every distinctive
 * word of the shop's name appears in the entity's name ("ELSEWHERE ESPRESSO" ->
 * "ELSEWHERE ESPRESSO LLC"; "D'AMICO COFFEE" -> "D AMICO COFFEE ROASTERS INC").
 */
export function names_match(shop_name: string, entity_name: string): boolean {
  const shop = distinctive_tokens(shop_name);
  if (shop.length === 0) return false;
  const entity_tokens = core_name_tokens(entity_name);
  // A name made only of numbers ("18 Bakery", "787 Coffee") must lead the entity name.
  if (shop.every((word) => /^\d+$/.test(word))) return entity_tokens[0] === shop[0];
  const entity = new Set(entity_tokens);
  const joined = entity_tokens.join("");
  // Long words may be run together in the legal name ("18.5 GRAM" -> "18.5GRAM"); short ones must match whole.
  return shop.every((word) => entity.has(word) || (word.length >= 4 && joined.includes(word)));
}

const KEYWORD_ENDINGS = ["", "S", "ES", "ERY", "ERIES", "ERS", "ING", "IES", "SHOP"];

/** Whole words only: "BAGELS" and "BAKERIES" count, "BREWSTER" and "ARMISTEAD" do not. */
export function looks_like_food_business(entity_name: string): boolean {
  const words = new Set(normalize_business_name(entity_name).split(" "));
  return BUSINESS_KEYWORDS.some((keyword) => KEYWORD_ENDINGS.some((ending) => words.has(keyword + ending)));
}

/** Professional practices (P.C., PLLC, professional corporations) are never the shop itself. */
export function is_professional_practice(entity: Pick<RegistryEntity, "current_entity_name" | "entity_type">): boolean {
  const name = normalize_business_name(entity.current_entity_name);
  return /PROFESSIONAL/i.test(entity.entity_type ?? "") || /\b(P L L C|PLLC|P C)$/.test(name);
}

export interface ShopAddress {
  building: string;
  street: string;
  zipcode: string;
}

/** "186 West 4 Street, Manhattan, NY 10014" -> { building: "186", street: "West 4 Street", zipcode: "10014" }. */
export function parse_shop_address(address: string): ShopAddress | null {
  const match = /^(\S+)\s+([^,]+),.*?(\d{5})\s*$/.exec(address.trim());
  if (!match) return null;
  return { building: match[1]!, street: match[2]!, zipcode: match[3]! };
}

const DIRECTIONS = new Set(["EAST", "WEST", "NORTH", "SOUTH", "E", "W", "N", "S"]);

/** The street's identifying word: "West 4 Street" -> "4", "Wyckoff Avenue" -> "WYCKOFF". */
export function street_key(street: string): string {
  const words = normalize_business_name(street).split(" ").filter((word) => !DIRECTIONS.has(word));
  return words[0] ?? "";
}

/** Does a registry address line point at the shop's building on the same street? */
export function same_address(shop: ShopAddress, address_line: string | null | undefined, zip: string | null | undefined): boolean {
  if (!address_line || !zip || zip.slice(0, 5) !== shop.zipcode) return false;
  const line = normalize_business_name(address_line);
  const building = normalize_business_name(shop.building);
  if (!line.startsWith(`${building} `)) return false;
  const key = street_key(shop.street);
  if (!key) return false;
  // Numbered streets are written "4", "4TH" or "FOURTH"; match the number with or without a suffix.
  return /^\d+$/.test(key)
    ? new RegExp(`\\b${key}(ST|ND|RD|TH)?\\b`).test(line)
    : line.includes(key);
}

export interface RegistryEntity {
  dos_id: string;
  current_entity_name: string;
  entity_type?: string;
  jurisdiction?: string;
  initial_dos_filing_date?: string;
  county?: string;
  dos_process_address_1?: string;
  dos_process_zip?: string;
  location_address_1?: string;
  location_zip?: string;
}

export type MatchReason = "name_at_address" | "business_at_address" | "name_elsewhere";

export interface RegistrySuggestion {
  entity_id: string;
  entity_name: string;
  entity_type: string | null;
  jurisdiction: string | null;
  filed_on: string | null;
  entity_address: string | null;
  match_reason: MatchReason;
  score: number;
  record_url: string;
}

const NYC_COUNTIES = new Set(["New York", "Kings", "Queens", "Bronx", "Richmond"]);
export const MAX_SUGGESTIONS = 3;

/** Ranks registry entities as possible owners of one shop; best first, at most three. */
export function rank_registry_entities(shop_name: string, address: ShopAddress | null, entities: RegistryEntity[]): RegistrySuggestion[] {
  const by_id = new Map<string, RegistrySuggestion>();
  for (const entity of entities) {
    if (!entity.dos_id || !entity.current_entity_name || is_professional_practice(entity)) continue;
    const at_address =
      address !== null &&
      (same_address(address, entity.location_address_1, entity.location_zip) ||
        same_address(address, entity.dos_process_address_1, entity.dos_process_zip));
    const name_match = names_match(shop_name, entity.current_entity_name);

    let reason: MatchReason | null = null;
    let score = 0;
    if (at_address && name_match) {
      reason = "name_at_address";
      score = 90;
    } else if (at_address && looks_like_food_business(entity.current_entity_name)) {
      reason = "business_at_address";
      score = 60;
    } else if (name_match && NYC_COUNTIES.has(entity.county ?? "")) {
      reason = "name_elsewhere";
      score = 35;
    }
    if (!reason) continue;
    // Registered outside New York (e.g. Delaware) is common for larger companies: rank lower.
    if (entity.jurisdiction && entity.jurisdiction !== "New York") score -= 15;

    const address_line = [entity.location_address_1 || entity.dos_process_address_1, entity.location_zip || entity.dos_process_zip]
      .filter(Boolean)
      .join(" ");
    const suggestion: RegistrySuggestion = {
      entity_id: entity.dos_id,
      entity_name: entity.current_entity_name.slice(0, 300),
      entity_type: entity.entity_type ?? null,
      jurisdiction: entity.jurisdiction ?? null,
      filed_on: entity.initial_dos_filing_date ? entity.initial_dos_filing_date.slice(0, 10) : null,
      entity_address: address_line || null,
      match_reason: reason,
      score,
      record_url: registry_record_url(entity.dos_id),
    };
    const existing = by_id.get(suggestion.entity_id);
    if (!existing || existing.score < suggestion.score) by_id.set(suggestion.entity_id, suggestion);
  }
  return [...by_id.values()]
    .sort((a, b) => b.score - a.score || (b.filed_on ?? "").localeCompare(a.filed_on ?? ""))
    .slice(0, MAX_SUGGESTIONS);
}

/* ------------------------------------------------------------------------- */
/* Registry queries                                                            */
/* ------------------------------------------------------------------------- */

const SELECT_FIELDS = [
  "dos_id", "current_entity_name", "entity_type", "jurisdiction", "initial_dos_filing_date", "county",
  "dos_process_address_1", "dos_process_zip", "location_address_1", "location_zip",
].join(",");
const REQUEST_TIMEOUT_MS = 30_000;

function soql_string(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Two lookups per shop: everything registered at its building and zip, and entities named like it. */
export function build_registry_queries(shop_name: string, address: ShopAddress | null): string[] {
  const queries: string[] = [];
  if (address) {
    const building = soql_string(`${address.building.toUpperCase()} %`);
    const zip = soql_string(`${address.zipcode}%`);
    queries.push(
      `(location_zip like ${zip} and upper(location_address_1) like ${building}) or ` +
        `(dos_process_zip like ${zip} and upper(dos_process_address_1) like ${building})`,
    );
  }
  const words = distinctive_tokens(shop_name);
  if (words.length > 0) {
    const prefix = core_name_tokens(shop_name).slice(0, Math.max(2, core_name_tokens(shop_name).indexOf(words[0]!) + 1)).join(" ");
    if (prefix.length >= 3) queries.push(`upper(current_entity_name) like ${soql_string(`${prefix}%`)}`);
  }
  return queries;
}

export async function fetch_registry_entities(
  where: string,
  options: { app_token?: string | null; fetch_impl?: typeof fetch } = {},
): Promise<RegistryEntity[]> {
  const fetch_impl = options.fetch_impl ?? fetch;
  const url = new URL(NYS_ACTIVE_CORPORATIONS_URL);
  url.searchParams.set("$select", SELECT_FIELDS);
  url.searchParams.set("$where", where);
  url.searchParams.set("$limit", "60");
  const response = await fetch_impl(url, {
    headers: { Accept: "application/json", ...(options.app_token ? { "X-App-Token": options.app_token } : {}) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`data.ny.gov responded with HTTP ${response.status}.`);
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) throw new Error("data.ny.gov returned a malformed response.");
  return payload as RegistryEntity[];
}

/* ------------------------------------------------------------------------- */
/* Database                                                                    */
/* ------------------------------------------------------------------------- */

export interface CandidateToCheck {
  id: string;
  name: string;
  address: string;
}

/** Possible independents in a market not checked within `recheck_after_days`. */
export async function fetch_candidates_to_check(
  pool: Pool,
  market_slug: string,
  options: { recheck_after_days?: number; limit?: number | null } = {},
): Promise<CandidateToCheck[]> {
  const result = await pool.query<CandidateToCheck>(
    `SELECT c.id, c.name, c.address
       FROM storefront_candidates c JOIN markets m ON m.id = c.market_id AND m.slug = $1
      WHERE c.status = 'pending' AND c.match_kind = 'none'
        AND (c.registry_checked_at IS NULL OR c.registry_checked_at < now() - make_interval(days => $2))
      ORDER BY c.registry_checked_at NULLS FIRST, c.name
      LIMIT $3`,
    [market_slug, options.recheck_after_days ?? 30, options.limit ?? 100_000],
  );
  return result.rows;
}

/** Replaces one candidate's suggestions and marks it checked (one transaction). */
export async function save_registry_suggestions(pool: Pool, candidate_id: string, suggestions: RegistrySuggestion[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM registry_suggestions WHERE candidate_id = $1", [candidate_id]);
    for (const suggestion of suggestions) {
      await client.query(
        `INSERT INTO registry_suggestions
           (candidate_id, registry, entity_id, entity_name, entity_type, jurisdiction, filed_on, entity_address,
            match_reason, score, record_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          candidate_id,
          NYS_REGISTRY,
          suggestion.entity_id,
          suggestion.entity_name,
          suggestion.entity_type,
          suggestion.jurisdiction,
          suggestion.filed_on,
          suggestion.entity_address,
          suggestion.match_reason,
          suggestion.score,
          suggestion.record_url,
        ],
      );
    }
    await client.query("UPDATE storefront_candidates SET registry_checked_at = now() WHERE id = $1", [candidate_id]);
    await client.query("COMMIT");
  } catch (caught_error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw caught_error;
  } finally {
    client.release();
  }
}

/** Looks one shop up in the registry and ranks the results. */
export async function suggest_registry_entities(
  candidate: CandidateToCheck,
  options: { app_token?: string | null; fetch_impl?: typeof fetch } = {},
): Promise<RegistrySuggestion[]> {
  const address = parse_shop_address(candidate.address);
  const entities: RegistryEntity[] = [];
  for (const where of build_registry_queries(candidate.name, address)) {
    entities.push(...(await fetch_registry_entities(where, options)));
  }
  return rank_registry_entities(candidate.name, address, entities);
}
