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

export interface BrandRow {
  line: number;
  brand_name: string;
  corporate_tier: 1 | 2 | 3;
  parent_entity: string | null;
  unique_selling_proposition: string | null;
  industry_vertical: IndustryVertical;
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

const clean = (value: string | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();

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
  if (!header || header.record.join(",") !== BRAND_CSV_COLUMNS.join(",")) {
    result.errors.push(`Header must be exactly: ${BRAND_CSV_COLUMNS.join(",")}`);
    return result;
  }
  if (body.length === 0) result.errors.push("File has a header but no data rows.");
  if (body.length > MAX_BRAND_ROWS) result.errors.push(`Too many rows (max ${MAX_BRAND_ROWS}).`);

  const seen = new Set<string>();
  let backers_ignored = 0;
  let parent_ignored = 0;

  for (const { record, info } of body) {
    const at = `Line ${info.lines}`;
    if (record.length !== BRAND_CSV_COLUMNS.length) {
      result.errors.push(`${at}: expected ${BRAND_CSV_COLUMNS.length} columns, found ${record.length}.`);
      continue;
    }
    const [name, tier_text, parent, backers, usp, vertical] = record.map(clean);
    const tier = Number(tier_text);
    const problems: string[] = [];

    if (!name || name.length > 200) problems.push("brand_name is required (max 200 characters)");
    if (tier !== 1 && tier !== 2 && tier !== 3) problems.push("corporate_tier must be 1, 2 or 3");
    if (!(INDUSTRY_VERTICALS as readonly string[]).includes(vertical ?? "")) {
      problems.push(`industry_vertical must be one of ${INDUSTRY_VERTICALS.join(", ")}`);
    }
    if ((usp ?? "").length > 300) problems.push("unique_selling_proposition is over 300 characters");
    if ((tier === 1 || tier === 2) && !parent) problems.push("parent_entity is required for Tier 1 and 2");

    const key = `${(name ?? "").toLowerCase()}|${vertical}`;
    if (seen.has(key)) problems.push(`duplicate brand "${name}"`);
    seen.add(key);

    if (problems.length > 0) {
      problems.forEach((problem) => result.errors.push(`${at}: ${problem}.`));
      continue;
    }

    // The schema requires independents to have no parent; the file's placeholder text is dropped.
    if (tier === 3 && parent) parent_ignored += 1;
    if (backers && backers.toLowerCase() !== "none") backers_ignored += 1;

    result.rows.push({
      line: info.lines,
      brand_name: name!,
      corporate_tier: tier as 1 | 2 | 3,
      parent_entity: tier === 3 ? null : parent!,
      unique_selling_proposition: usp || null,
      industry_vertical: vertical as IndustryVertical,
    });
  }

  if (parent_ignored > 0) {
    result.warnings.push(`${parent_ignored} Tier 3 rows had a parent_entity placeholder; stored as no parent.`);
  }
  if (backers_ignored > 0) {
    result.warnings.push(
      `financial_backers (${backers_ignored} rows) is not stored: the schema has no column for it yet.`,
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
      const result = await client.query<{ inserted: boolean }>(
        `INSERT INTO brands (name, corporate_tier, industry_vertical, parent_entity, unique_selling_proposition)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (lower(btrim(name)), industry_vertical) DO UPDATE
           SET parent_entity = EXCLUDED.parent_entity,
               unique_selling_proposition = EXCLUDED.unique_selling_proposition
           WHERE brands.corporate_tier = EXCLUDED.corporate_tier
         RETURNING (xmax = 0) AS inserted`,
        [row.brand_name, row.corporate_tier, row.industry_vertical, row.parent_entity, row.unique_selling_proposition],
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
