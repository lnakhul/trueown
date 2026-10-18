import { Pool } from "pg";
import { ensure_boundaries_loaded } from "@/lib/import/nta-file";
import { import_venues, parse_venue_csv, VENUE_CSV_COLUMNS } from "@/lib/import/venues";

const HEADER = VENUE_CSV_COLUMNS.join(",");
const TODAY = new Date("2026-11-01T00:00:00Z");

const TIER3 =
  'ZZ Test Roasters,coffee_bakery,3,,Family roaster,nys_dos_corporations,https://apps.dos.ny.gov/publicInquiry/,2026-10-01,"1 Test St, New York, NY 10014",,New York,40.7324,-74.0021';
const TIER2 =
  'ZZ Test Corp,coffee_bakery,2,ZZ Capital,,crunchbase,https://www.crunchbase.com/organization/zz,2026-10-01,"2 Test St, New York, NY 10014",,New York,40.7330,-74.0030';

const parse = (...lines: string[]) => parse_venue_csv([HEADER, ...lines].join("\n"), TODAY);

describe("venue CSV validation", () => {
  test("accepts valid rows, including quoted commas and a BOM", () => {
    const result = parse_venue_csv("\uFEFF" + [HEADER, TIER3, TIER2].join("\n"), TODAY);
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.address).toBe("1 Test St, New York, NY 10014");
    expect(result.rows[0]?.parent_entity).toBeNull();
  });

  test("rejects a wrong header", () => {
    expect(parse_venue_csv("a,b\n1,2", TODAY).errors.length).toBeGreaterThan(0);
  });

  test("rejects Tier 3 with a parent entity and Tier 2 without one", () => {
    expect(parse(TIER3.replace("coffee_bakery,3,,", "coffee_bakery,3,Someone,")).errors.length).toBeGreaterThan(0);
    expect(parse(TIER2.replace("ZZ Capital", "")).errors.length).toBeGreaterThan(0);
  });

  test("rejects a source type that does not match the tier", () => {
    expect(parse(TIER3.replace("nys_dos_corporations", "sec_edgar")).errors.length).toBeGreaterThan(0);
    expect(parse(TIER2.replace("crunchbase,", "eater_ny,")).errors.length).toBeGreaterThan(0);
  });

  test("rejects bad urls, future/invalid dates and bad coordinates", () => {
    expect(parse(TIER3.replace("https://apps.dos.ny.gov/publicInquiry/", "javascript:alert(1)")).errors.length).toBeGreaterThan(0);
    expect(parse(TIER3.replace("2026-10-01", "2027-01-01")).errors.length).toBeGreaterThan(0);
    expect(parse(TIER3.replace("2026-10-01", "2026-02-30")).errors.length).toBeGreaterThan(0);
    expect(parse(TIER3.replace("40.7324", "abc")).errors.length).toBeGreaterThan(0);
    expect(parse(TIER3.replace("40.7324", "140.7324")).errors.length).toBeGreaterThan(0);
  });

  test("rejects inconsistent brands and duplicate storefronts", () => {
    const other_tier = TIER3.replace('"1 Test St', '"9 Test St').replace("coffee_bakery,3,,", "coffee_bakery,2,X,");
    expect(parse(TIER3, other_tier).errors.length).toBeGreaterThan(0);
    expect(parse(TIER3, TIER3).errors.length).toBeGreaterThan(0);
  });

  test("a header-only template is refused as empty", () => {
    const result = parse_venue_csv(HEADER + "\n", TODAY);
    expect(result.rows).toEqual([]);
    expect(result.errors).toEqual(["File has a header but no data rows."]);
  });
});

const database_url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/trueown";
let pool: Pool;

async function cleanup(): Promise<void> {
  await pool.query("DELETE FROM locations WHERE brand_id IN (SELECT id FROM brands WHERE name LIKE 'ZZ Test%')");
  await pool.query("DELETE FROM brands WHERE name LIKE 'ZZ Test%'");
}

describe("venue import (database)", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: database_url, max: 2 });
    await ensure_boundaries_loaded(pool);
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  test("dry run executes but rolls back", async () => {
    const parsed = parse(TIER3);
    const summary = await import_venues(pool, parsed.rows, { dry_run: true });
    expect(summary.errors).toEqual([]);
    expect(summary.locations_created).toBe(1);
    const count = await pool.query("SELECT count(*)::int AS n FROM brands WHERE name LIKE 'ZZ Test%'");
    expect(count.rows[0].n).toBe(0);
  });

  test("rejects swapped latitude/longitude", async () => {
    const swapped = TIER3.replace("40.7324,-74.0021", "-74.0021,40.7324");
    const parsed = parse(swapped);
    if (parsed.errors.length > 0) return; // caught at parse time
    const summary = await import_venues(pool, parsed.rows);
    expect(summary.errors.length).toBeGreaterThan(0);
  });

  test("commits, derives the neighborhood, is idempotent, and blocks tier changes", async () => {
    const parsed = parse(TIER3);
    const first = await import_venues(pool, parsed.rows);
    expect(first.errors).toEqual([]);
    expect(first.locations_created).toBe(1);

    const row = await pool.query(
      "SELECT l.neighborhood FROM locations l JOIN brands b ON b.id = l.brand_id WHERE b.name = 'ZZ Test Roasters'",
    );
    expect(row.rows[0].neighborhood).toMatch(/Village/);

    const again = await import_venues(pool, parsed.rows);
    expect(again.errors).toEqual([]);
    expect(again.locations_created).toBe(0);
    expect(again.locations_skipped).toBe(1);

    const conflicting = parse(
      'ZZ Test Roasters,coffee_bakery,2,ZZ Capital,,crunchbase,https://www.crunchbase.com/organization/zz,2026-10-01,"5 Test St, New York, NY 10014",,New York,40.7330,-74.0030',
    );
    const blocked = await import_venues(pool, conflicting.rows);
    expect(blocked.errors.length).toBeGreaterThan(0);
    const tier = await pool.query("SELECT corporate_tier FROM brands WHERE name = 'ZZ Test Roasters'");
    expect(tier.rows[0].corporate_tier).toBe(3);
  });
});
