import { parse } from "csv-parse/sync";
import type { Pool } from "pg";
import { INDUSTRY_VERTICALS } from "@/lib/import/venues";
import type { IndustryVertical } from "@/lib/types";

export const BRAND_CSV_COLUMNS = [
  "brand_name",
  "corporate_tier",
  "parent_entity",
  "financial_backers",
  "unique_selling_proposition",
  "industry_vertical",
] as const;

/** Optional trailing column: home market slug for Tier 3 independents (blank = set by its first storefront). */
export const OPTIONAL_BRAND_CSV_COLUMN = "market";

export interface BrandRow {
  line: number;
  brand_name: string;
  corporate_tier: 1 | 2 | 3;
  parent_entity: string | null;
  financial_backers: string[];
  unique_selling_proposition: string | null;
  industry_vertical: IndustryVertical;
  /** Home market slug (Tier 3 only; null = not declared). */
  market_slug: string | null;
}

export interface BrandParseResult {
  rows: BrandRow[];
  errors: string[];
  warnings: string[];
}

export interface BrandImportSummary {
  brands_created: number;
  brands_updated: number;
  errors: string[];
}

const MAX_BRAND_ROWS = 2000;
const MAX_BACKERS_PER_BRAND = 20;
const MAX_BACKER_LENGTH = 120;

const clean = (value: string | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();

/**
 * Splits a free-text backer list on commas or semicolons, ignoring separators inside
 * parentheses ("Nestlé (controlling stake, since 2017)"). "none" means no backers.
 */
export function split_backers(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of text) {
    if (character === "(") depth += 1;
    if (character === ")") depth = Math.max(0, depth - 1);
    if ((character === "," || character === ";") && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0 && part.toLowerCase() !== "none");
}

/** Parses the brand-level CSV (no storefronts). Any error means "import nothing". */
export function parse_brand_csv(text: string): BrandParseResult {
  const result: BrandParseResult = { rows: [], errors: [], warnings: [] };
  let records: Array<{ record: string[]; info: { lines: number } }>;
  try {
    records = parse(text, { bom: true, skip_empty_lines: true, trim: true, info: true }) as unknown as typeof records;
  } catch (error) {
    result.errors.push(`CSV could not be parsed: ${error instanceof Error ? error.message : "unknown error"}`);
    return result;
  }

  const [header, ...body] = records;
  const base_header = BRAND_CSV_COLUMNS.join(",");
  const header_text = header?.record.join(",");
  const has_market_column = header_text === `${base_header},${OPTIONAL_BRAND_CSV_COLUMN}`;
  if (!header || (header_text !== base_header && !has_market_column)) {
    result.errors.push(`Header must be exactly: ${base_header} (optionally followed by ,${OPTIONAL_BRAND_CSV_COLUMN})`);
    return result;
  }
  const expected_columns = BRAND_CSV_COLUMNS.length + (has_market_column ? 1 : 0);
  if (body.length === 0) result.errors.push("File has a header but no data rows.");
  if (body.length > MAX_BRAND_ROWS) result.errors.push(`Too many rows (max ${MAX_BRAND_ROWS}).`);

  const seen = new Set<string>();
  let parent_ignored = 0;
  let backers_ignored = 0;

  for (const { record, info } of body) {
    const at = `Line ${info.lines}`;
    if (record.length !== expected_columns) {
      result.errors.push(`${at}: expected ${expected_columns} columns, found ${record.length}.`);
      continue;
    }
    const [name, tier_text, parent, backers_text, usp, vertical, market_text] = record.map(clean);
    const market_slug = (market_text ?? "").toLowerCase();
    const tier = Number(tier_text);
    const problems: string[] = [];

    if (!name || name.length > 200) problems.push("brand_name is required (max 200 characters)");
    if (tier !== 1 && tier !== 2 && tier !== 3) problems.push("corporate_tier must be 1, 2 or 3");
    if (!(INDUSTRY_VERTICALS as readonly string[]).includes(vertical ?? "")) {
      problems.push(`industry_vertical must be one of ${INDUSTRY_VERTICALS.join(", ")}`);
    }
    if ((usp ?? "").length > 300) problems.push("unique_selling_proposition is over 300 characters");
    const backers = split_backers(backers_text ?? "");
    if (backers.length > MAX_BACKERS_PER_BRAND) problems.push(`financial_backers lists more than ${MAX_BACKERS_PER_BRAND} names`);
    if (backers.some((backer) => backer.length > MAX_BACKER_LENGTH)) {
      problems.push(`a financial_backers entry is over ${MAX_BACKER_LENGTH} characters`);
    }
    if ((tier === 1 || tier === 2) && !parent) problems.push("parent_entity is required for Tier 1 and 2");
    if (market_slug && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(market_slug)) problems.push("market must be a market slug such as nyc");
    if (market_slug && tier !== 3) problems.push("market is only set for Tier 3 independents (Tier 1/2 brands are national)");

    const key = `${(name ?? "").toLowerCase()}|${vertical}|${tier === 3 ? market_slug : "*"}`;
    if (seen.has(key)) problems.push(`duplicate brand "${name}"`);
    seen.add(key);

    if (problems.length > 0) {
      problems.forEach((problem) => result.errors.push(`${at}: ${problem}.`));
      continue;
    }

    // The schema requires independents to have no parent; the file's placeholder text is dropped.
    if (tier === 3 && parent) parent_ignored += 1;
    if (tier === 3 && backers.length > 0) backers_ignored += 1;

    result.rows.push({
      line: info.lines,
      brand_name: name!,
      corporate_tier: tier as 1 | 2 | 3,
      parent_entity: tier === 3 ? null : parent!,
      financial_backers: tier === 3 ? [] : backers,
      unique_selling_proposition: usp || null,
      industry_vertical: vertical as IndustryVertical,
      market_slug: market_slug || null,
    });
  }

  if (parent_ignored > 0) {
    result.warnings.push(`${parent_ignored} Tier 3 rows had a parent_entity placeholder; stored as no parent.`);
  }
  if (backers_ignored > 0) {
    result.warnings.push(
      `${backers_ignored} Tier 3 rows listed financial_backers; stored as none (independents have no outside backers).`,
    );
  }
  return result;
}

/** Upserts brands in one transaction; a tier change on an existing brand aborts everything. */
export async function import_brands(
  pool: Pool,
  rows: BrandRow[],
  options: { dry_run?: boolean } = {},
): Promise<BrandImportSummary> {
  const summary: BrandImportSummary = { brands_created: 0, brands_updated: 0, errors: [] };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of rows) {
      let home_market_id: string | null = null;
      if (row.market_slug) {
        const market = await client.query<{ id: string }>("SELECT id FROM markets WHERE slug = $1", [row.market_slug]);
        home_market_id = market.rows[0]?.id ?? null;
        if (!home_market_id) throw new Error(`Line ${row.line}: unknown market "${row.market_slug}".`);
      }
      // Same rule as the venue importer: a same-named brand with another tier in the
      // same scope (national, or this market for independents) is never overwritten.
      const conflict = await client.query(
        `SELECT 1 FROM brands
          WHERE lower(btrim(name)) = lower(btrim($1))
            AND industry_vertical = $2::industry_vertical
            AND corporate_tier <> $3
            AND ($3 <> 3 OR home_market_id IS NULL OR $4::uuid IS NULL OR home_market_id = $4::uuid)
          LIMIT 1`,
        [row.brand_name, row.industry_vertical, row.corporate_tier, home_market_id],
      );
      if (conflict.rowCount && conflict.rowCount > 0) {
        throw new Error(`Line ${row.line}: "${row.brand_name}" already exists with a different tier; resolve it by hand.`);
      }
      const result = await client.query<{ inserted: boolean }>(
        `INSERT INTO brands (name, corporate_tier, industry_vertical, parent_entity, financial_backers,
                             unique_selling_proposition, home_market_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (lower(btrim(name)), industry_vertical,
                      COALESCE(home_market_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO UPDATE
           SET parent_entity = EXCLUDED.parent_entity,
               financial_backers = EXCLUDED.financial_backers,
               unique_selling_proposition = EXCLUDED.unique_selling_proposition
           WHERE brands.corporate_tier = EXCLUDED.corporate_tier
         RETURNING (xmax = 0) AS inserted`,
        [
          row.brand_name,
          row.corporate_tier,
          row.industry_vertical,
          row.parent_entity,
          row.financial_backers,
          row.unique_selling_proposition,
          home_market_id,
        ],
      );
      const outcome = result.rows[0];
      if (!outcome) {
        throw new Error(`Line ${row.line}: "${row.brand_name}" already exists with a different tier; resolve it by hand.`);
      }
      if (outcome.inserted) summary.brands_created += 1;
      else summary.brands_updated += 1;
    }
    await client.query(options.dry_run ? "ROLLBACK" : "COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    summary.brands_created = 0;
    summary.brands_updated = 0;
    summary.errors.push(error instanceof Error ? error.message : "Unknown database error");
  } finally {
    client.release();
  }
  return summary;
}
