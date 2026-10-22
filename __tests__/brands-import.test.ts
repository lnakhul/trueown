import { Pool } from "pg";
import { BRAND_CSV_COLUMNS, import_brands, parse_brand_csv, split_backers } from "@/lib/import/brands";

const HEADER = BRAND_CSV_COLUMNS.join(",");
const database_url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/trueown";

describe("split_backers", () => {
  test("splits on commas and semicolons, keeping separators inside parentheses", () => {
    expect(split_backers("General Atlantic, General Catalyst; Tiger Global")).toEqual([
      "General Atlantic",
      "General Catalyst",
      "Tiger Global",
    ]);
    expect(split_backers("Nestlé (controlling stake, since 2017), JAB")).toEqual([
      "Nestlé (controlling stake, since 2017)",
      "JAB",
    ]);
  });

  test("treats none and blanks as empty", () => {
    expect(split_backers("None")).toEqual([]);
    expect(split_backers("")).toEqual([]);
    expect(split_backers(" , ;")).toEqual([]);
  });
});

describe("brand CSV backers", () => {
  const row = (tier: number, parent: string, backers: string) =>
    `ZZ Backers Brand,${tier},${parent},"${backers}",Tagline,coffee_bakery`;

  test("stores backers for Tier 1/2 and drops them for Tier 3", () => {
    const tier2 = parse_brand_csv([HEADER, row(2, "ZZ Parent", "Fund A, Fund B")].join("\n"));
    expect(tier2.errors).toEqual([]);
    expect(tier2.rows[0]?.financial_backers).toEqual(["Fund A", "Fund B"]);

    const tier3 = parse_brand_csv([HEADER, row(3, "", "Fund A")].join("\n"));
    expect(tier3.rows[0]?.financial_backers).toEqual([]);
    expect(tier3.warnings.join(" ")).toMatch(/Tier 3 rows listed financial_backers/);
  });

  test("rejects oversized backer lists and entries", () => {
    const many = Array.from({ length: 21 }, (_, index) => `Fund ${index}`).join(", ");
    expect(parse_brand_csv([HEADER, row(2, "ZZ Parent", many)].join("\n")).errors.length).toBeGreaterThan(0);
    expect(parse_brand_csv([HEADER, row(2, "ZZ Parent", "x".repeat(121))].join("\n")).errors.length).toBeGreaterThan(0);
  });
});

describe("brand import persists financial_backers", () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: database_url, max: 2 });
  });
  afterAll(async () => {
    await pool.query("DELETE FROM brands WHERE name = 'ZZ Backers Brand'");
    await pool.end();
  });

  test("inserts then updates the backer list", async () => {
    const parse = (backers: string) =>
      parse_brand_csv([HEADER, `ZZ Backers Brand,2,ZZ Parent,"${backers}",Tagline,coffee_bakery`].join("\n")).rows;

    expect((await import_brands(pool, parse("Fund A, Fund B"))).errors).toEqual([]);
    let stored = await pool.query("SELECT financial_backers FROM brands WHERE name = 'ZZ Backers Brand'");
    expect(stored.rows[0].financial_backers).toEqual(["Fund A", "Fund B"]);

    expect((await import_brands(pool, parse("Fund C"))).errors).toEqual([]);
    stored = await pool.query("SELECT financial_backers FROM brands WHERE name = 'ZZ Backers Brand'");
    expect(stored.rows[0].financial_backers).toEqual(["Fund C"]);
  });
});
