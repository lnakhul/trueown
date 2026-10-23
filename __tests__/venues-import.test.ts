import { Pool } from "pg";
import { ensure_boundaries_loaded } from "@/lib/import/nta-file";
import {
  CORPORATE_SOURCE_TYPES,
  INDEPENDENT_SOURCE_TYPES,
  VENUE_CSV_COLUMNS,
  VENUE_TEMPLATE_COLUMNS,
  import_venues,
  parse_venue_csv,
} from "@/lib/import/venues";

/** Legacy header: the required columns with the old `city` column before latitude. */
const HEADER = [...VENUE_CSV_COLUMNS.slice(0, 10), "city", ...VENUE_CSV_COLUMNS.slice(10)].join(",");
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

  test("loads a non-coffee vertical in another market and assigns its market", async () => {
    const bar =
      'ZZ Test Dive Bar,bar_nightlife,3,,Neighborhood dive,community_consensus,https://example.com/austin-dive,2026-10-01,"1 Test Ave, Austin, TX 78701",,Austin,30.2672,-97.7431';
    const summary = await import_venues(pool, parse(bar).rows);
    expect(summary.errors).toEqual([]);
    expect(summary.locations_created).toBe(1);
    expect(summary.warnings.some((warning) => warning.includes("Austin"))).toBe(true);

    const row = await pool.query(
      `SELECT b.industry_vertical, m.city_name
         FROM locations l JOIN brands b ON b.id = l.brand_id JOIN markets m ON m.id = l.market_id
        WHERE b.name = 'ZZ Test Dive Bar'`,
    );
    expect(row.rows[0]).toEqual({ industry_vertical: "bar_nightlife", city_name: "Austin" });
  });

  test("rejects a storefront that is not within 50 miles of any market", async () => {
    const remote =
      'ZZ Test Remote,restaurant,3,,Far away,community_consensus,https://example.com/remote,2026-10-01,"1 Remote Rd, Nowhere",,Nowhere,-33.8688,151.2093';
    const summary = await import_venues(pool, parse(remote).rows);
    expect(summary.errors.some((error) => error.includes("50 miles of any market"))).toBe(true);
  });
});

/* ------------------------------------------------------------------------- */
/* Multi-market files                                                         */
/* ------------------------------------------------------------------------- */

const TEMPLATE_HEADER = VENUE_TEMPLATE_COLUMNS.join(",");
const SOURCE = "2026-10-01";
/** Builds a template-format row (market column instead of city). */
function market_row(
  name: string,
  tier: 1 | 2 | 3,
  market: string,
  address: string,
  latitude: number,
  longitude: number,
): string {
  const parent = tier === 3 ? "" : "ZZ Capital";
  const source = tier === 3 ? "state_business_registry" : "crunchbase";
  return `${name},coffee_bakery,${tier},${parent},,${source},https://example.com/${encodeURIComponent(name)},${SOURCE},"${address}",,${market},${latitude},${longitude}`;
}
const parse_template = (...lines: string[]) => parse_venue_csv([TEMPLATE_HEADER, ...lines].join("\n"), TODAY);

const NYC_POINT = [40.7324, -74.0021] as const;
const AUSTIN_POINT = [30.2672, -97.7431] as const;
const CHICAGO_POINT = [41.8781, -87.6298] as const;

describe("multi-market CSV validation", () => {
  test("the template header (market, no city) is accepted and generic source types are valid", () => {
    const result = parse_template(market_row("ZZ Test Sunrise Bakery", 3, "austin", "1 Congress Ave, Austin, TX", ...AUSTIN_POINT));
    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toMatchObject({ market_slug: "austin", declared_city: null, ownership_source_type: "state_business_registry" });
  });

  test("a malformed market slug is rejected", () => {
    const result = parse_template(market_row("ZZ Test Bad", 3, "Austin TX", "1 Congress Ave", ...AUSTIN_POINT));
    expect(result.errors.some((error) => error.includes("market must be a market slug"))).toBe(true);
  });

  test("same-named independents in different markets are not treated as one brand", () => {
    const nyc = market_row("ZZ Test Sunrise Bakery", 3, "nyc", "10 Test St, New York, NY", ...NYC_POINT).replace(",,state", ",Bagels,state");
    const austin = market_row("ZZ Test Sunrise Bakery", 3, "austin", "1 Congress Ave, Austin, TX", ...AUSTIN_POINT);
    expect(parse_template(nyc, austin).errors).toEqual([]);
  });

  test("a national brand must agree with itself across markets", () => {
    const nyc = market_row("ZZ Test National Coffee", 2, "nyc", "11 Test St, New York, NY", ...NYC_POINT);
    const chicago = market_row("ZZ Test National Coffee", 2, "chicago", "1 State St, Chicago, IL", ...CHICAGO_POINT).replace("ZZ Capital", "Other Capital");
    expect(parse_template(nyc, chicago).errors.some((error) => error.includes("parent_entity"))).toBe(true);
  });
});

describe("multi-market import (database)", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: database_url, max: 2 });
    await ensure_boundaries_loaded(pool);
    await cleanup();
  });
  afterEach(cleanup);
  afterAll(async () => {
    await pool.end();
  });

  test("NYC + Austin + Chicago in one file: independents split by market, national brands stay one brand", async () => {
    const parsed = parse_template(
      market_row("ZZ Test Sunrise Bakery", 3, "nyc", "10 Test St, New York, NY", ...NYC_POINT),
      market_row("ZZ Test Sunrise Bakery", 3, "austin", "1 Congress Ave, Austin, TX", ...AUSTIN_POINT),
      market_row("ZZ Test National Coffee", 2, "nyc", "11 Test St, New York, NY", 40.733, -74.003),
      market_row("ZZ Test National Coffee", 2, "chicago", "1 State St, Chicago, IL", ...CHICAGO_POINT),
    );
    expect(parsed.errors).toEqual([]);
    const summary = await import_venues(pool, parsed.rows);
    expect(summary.errors).toEqual([]);
    expect(summary.brands_created).toBe(3);
    expect(summary.locations_created).toBe(4);

    const brands = await pool.query<{ name: string; corporate_tier: number; slug: string | null; storefront_cities: string[] }>(
      `SELECT b.name, b.corporate_tier, m.slug,
              array_agg(l.city ORDER BY l.city) AS storefront_cities
         FROM brands b
         LEFT JOIN markets m ON m.id = b.home_market_id
         JOIN locations l ON l.brand_id = b.id
        WHERE b.name LIKE 'ZZ Test%'
        GROUP BY b.id, b.name, b.corporate_tier, m.slug
        ORDER BY b.name, m.slug`,
    );
    expect(brands.rows).toEqual([
      { name: "ZZ Test National Coffee", corporate_tier: 2, slug: null, storefront_cities: ["Chicago", "New York"] },
      { name: "ZZ Test Sunrise Bakery", corporate_tier: 3, slug: "austin", storefront_cities: ["Austin"] },
      { name: "ZZ Test Sunrise Bakery", corporate_tier: 3, slug: "nyc", storefront_cities: ["New York"] },
    ]);
  });

  test("a market column that disagrees with the coordinates is rejected", async () => {
    const parsed = parse_template(market_row("ZZ Test Misplaced", 3, "chicago", "1 Congress Ave, Austin, TX", ...AUSTIN_POINT));
    const summary = await import_venues(pool, parsed.rows);
    expect(summary.errors.some((error) => error.includes('market is "chicago"') && error.includes("Austin"))).toBe(true);
  });

  test("a legacy city column must match the market's label; the stored city always comes from the market", async () => {
    const wrong_label = parse(TIER3.replace(",New York,40.7324", ",New York City,40.7324"));
    const blocked = await import_venues(pool, wrong_label.rows);
    expect(blocked.errors.some((error) => error.includes('city "New York City"'))).toBe(true);

    const blank_city = parse(TIER3.replace(",New York,40.7324", ",,40.7324"));
    expect((await import_venues(pool, blank_city.rows)).errors).toEqual([]);
    const stored = await pool.query("SELECT l.city FROM locations l JOIN brands b ON b.id = l.brand_id WHERE b.name = 'ZZ Test Roasters'");
    expect(stored.rows[0].city).toBe("New York");
  });

  test("an independent cannot reuse the name of a national Tier 1/2 brand in the same vertical", async () => {
    const national = parse_template(market_row("ZZ Test Shared Name", 2, "chicago", "1 State St, Chicago, IL", ...CHICAGO_POINT));
    expect((await import_venues(pool, national.rows)).errors).toEqual([]);
    const local = parse_template(market_row("ZZ Test Shared Name", 3, "austin", "1 Congress Ave, Austin, TX", ...AUSTIN_POINT));
    const blocked = await import_venues(pool, local.rows);
    expect(blocked.errors.some((error) => error.includes("different corporate tier"))).toBe(true);
  });

  test("the database refuses an independent storefront outside its home market", async () => {
    const parsed = parse_template(market_row("ZZ Test Local Only", 3, "nyc", "12 Test St, New York, NY", ...NYC_POINT));
    expect((await import_venues(pool, parsed.rows)).errors).toEqual([]);
    await expect(
      pool.query(
        `INSERT INTO locations (brand_id, address, coordinates)
         SELECT id, '2 Congress Ave', ST_SetSRID(ST_MakePoint($1, $2), 4326) FROM brands WHERE name = 'ZZ Test Local Only'`,
        [AUSTIN_POINT[1], AUSTIN_POINT[0]],
      ),
    ).rejects.toThrow(/independent_market_mismatch/);
  });

  test("source types in code match the database constraint exactly", async () => {
    const result = await pool.query<{ definition: string }>(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'brands_ownership_source_type_check'",
    );
    const in_database = [...(result.rows[0]?.definition ?? "").matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort();
    expect(in_database).toEqual([...CORPORATE_SOURCE_TYPES, ...INDEPENDENT_SOURCE_TYPES].sort());
  });
});
