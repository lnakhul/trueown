import { Pool } from "pg";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { get_database_pool } from "@/lib/db/pool";
import { fetch_brand_directory, fetch_brand_page, fetch_owner_page, fetch_owners, fetch_public_brand_slugs } from "@/lib/db/directory";
import { SLUG_PATTERN, absolute_url, slugify } from "@/lib/site";
import { ownership_sentence } from "@/lib/ui/ownership-labels";

/** Against the seeded database, with fixture brands named "Qd …". */
const database_url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/trueown";
let pool: Pool;
const ids: Record<string, string> = {};

async function insert_brand(name: string, tier: number, parent: string | null, backers: string[] = []): Promise<string> {
  return (
    await pool.query<{ id: string }>(
      `INSERT INTO brands (name, corporate_tier, industry_vertical, parent_entity, financial_backers) VALUES ($1, $2, 'coffee_bakery', $3, $4) RETURNING id`,
      [name, tier, parent, backers],
    )
  ).rows[0]!.id;
}
async function insert_location(brand_id: string, address: string, latitude: number, longitude: number): Promise<void> {
  await pool.query(`INSERT INTO locations (brand_id, address, coordinates) VALUES ($1, $2, ST_SetSRID(ST_MakePoint($4, $3), 4326))`, [
    brand_id,
    address,
    latitude,
    longitude,
  ]);
}
async function cleanup(): Promise<void> {
  await pool.query(`DELETE FROM brands WHERE name LIKE 'Qd %'`);
}

beforeAll(async () => {
  process.env.DATABASE_URL = database_url;
  pool = new Pool({ connectionString: database_url, max: 2 });
  await cleanup();
  ids.chain = await insert_brand("Qd Café Chain", 1, "Qd Capital Partners", ["Qd Growth Fund"]);
  ids.second = await insert_brand("Qd Donut Co", 2, "Qd Donut Inc.", ["Qd Growth Fund"]);
  ids.indie = await insert_brand("Qd Corner Roasters", 3, null);
  ids.hidden = await insert_brand("Qd Hidden Bakery", 2, "Qd Hidden Holdings");
  await insert_location(ids.chain, "1 Qd St, New York, NY", 40.7335, -74.0027);
  await insert_location(ids.chain, "2 Qd St, New York, NY", 40.7831, -73.9712);
  await insert_location(ids.second, "3 Qd St, New York, NY", 40.7306, -73.9866);
  await insert_location(ids.indie, "4 Qd St, New York, NY", 40.734, -74.004);
  await insert_location(ids.hidden, "5 Qd St, Austin, TX", 30.2672, -97.7431); // coming-soon market
});

afterAll(async () => {
  await cleanup();
  await pool.end();
  await get_database_pool().end();
});

describe("slugs", () => {
  test("slugify makes readable, URL-safe words", () => {
    expect(slugify("Café Grumpy & Co.")).toBe("cafe-grumpy-and-co");
    expect(slugify("Turner Image Capital")).toBe("turner-image-capital");
    expect(slugify("  ’s  ")).toBe("s");
    expect(slugify("!!!")).toBe("owner");
    expect(SLUG_PATTERN.test(slugify("Blank Street Inc."))).toBe(true);
    expect(SLUG_PATTERN.test("../etc")).toBe(false);
  });

  test("brands get a slug from their name; a duplicate name gets a short suffix; renames follow", async () => {
    const chain = (await pool.query<{ slug: string }>("SELECT slug FROM brands WHERE id = $1", [ids.chain])).rows[0]!.slug;
    expect(chain).toBe("qd-cafe-chain");
    const twin = await pool.query<{ id: string; slug: string }>(
      `INSERT INTO brands (name, corporate_tier, industry_vertical, home_market_id)
       SELECT 'Qd Corner Roasters', 3, 'restaurant', id FROM markets WHERE slug = 'nyc' RETURNING id, slug`,
    );
    expect(twin.rows[0]!.slug).toMatch(/^qd-corner-roasters-[0-9a-f]{6}$/);
    await pool.query("UPDATE brands SET name = 'Qd Renamed Roasters' WHERE id = $1", [twin.rows[0]!.id]);
    expect((await pool.query("SELECT slug FROM brands WHERE id = $1", [twin.rows[0]!.id])).rows[0].slug).toBe("qd-renamed-roasters");
    await pool.query("DELETE FROM brands WHERE id = $1", [twin.rows[0]!.id]);
  });
});

describe("brand directory", () => {
  test("filters by ownership and searches names and owners", async () => {
    const all = await fetch_brand_directory({ ownership: "all", search: "qd", page: 1 });
    expect(all.brands.map((brand) => brand.name)).toEqual(["Qd Café Chain", "Qd Corner Roasters", "Qd Donut Co"]);
    expect(all.counts).toEqual({ all: 3, pe: 1, vc: 1, independent: 1 });
    expect(all.brands[0]).toMatchObject({ slug: "qd-cafe-chain", corporate_tier: 1, location_count: 2 });

    const independents = await fetch_brand_directory({ ownership: "independent", search: "qd", page: 1 });
    expect(independents.brands.map((brand) => brand.name)).toEqual(["Qd Corner Roasters"]);

    const by_owner = await fetch_brand_directory({ ownership: "all", search: "qd capital", page: 1 });
    expect(by_owner.brands.map((brand) => brand.name)).toEqual(["Qd Café Chain"]);
  });

  test("brands with no location in an active market are not public", async () => {
    expect((await fetch_brand_directory({ ownership: "all", search: "qd hidden", page: 1 })).total).toBe(0);
    expect(await fetch_brand_page("qd-hidden-bakery")).toBeNull();
    expect((await fetch_public_brand_slugs()).map((brand) => brand.slug)).not.toContain("qd-hidden-bakery");
  });
});

describe("brand page", () => {
  test("a corporate-backed brand lists owners, locations and nearby independents", async () => {
    const page = await fetch_brand_page("qd-cafe-chain");
    expect(page).toMatchObject({ name: "Qd Café Chain", corporate_tier: 1, location_count: 2 });
    expect(page!.owners).toEqual([
      { name: "Qd Capital Partners", slug: "qd-capital-partners", role: "parent" },
      { name: "Qd Growth Fund", slug: "qd-growth-fund", role: "backer" },
    ]);
    const corner = page!.alternatives.find((alternative) => alternative.brand_name === "Qd Corner Roasters");
    expect(corner).toMatchObject({ brand_slug: "qd-corner-roasters", near_address: "1 Qd St, New York, NY" });
    expect(corner!.distance_meters).toBeLessThan(300);
  });

  test("an independent has no owners or alternatives", async () => {
    const page = await fetch_brand_page("qd-corner-roasters");
    expect(page).toMatchObject({ corporate_tier: 3, owners: [], alternatives: [] });
  });

  test("the ownership sentence answers the question in plain words", () => {
    expect(ownership_sentence({ name: "A", corporate_tier: 3, parent_entity: null, financial_backers: [] })).toBe("A is independently owned.");
    expect(ownership_sentence({ name: "B", corporate_tier: 1, parent_entity: "Big PE", financial_backers: ["Big PE", "Fund X"] })).toBe(
      "B is owned by private equity (Big PE). Backers include Fund X.",
    );
    expect(ownership_sentence({ name: "C", corporate_tier: 2, parent_entity: "C Inc.", financial_backers: [] })).toBe(
      "C is funded by venture capital; its parent company is C Inc.",
    );
  });
});

describe("owners", () => {
  test("parents and backers are grouped by slug with their public brands", async () => {
    const fund = await fetch_owner_page("qd-growth-fund");
    expect(fund).toMatchObject({ name: "Qd Growth Fund", location_count: 3 });
    expect(fund!.brands.map((brand) => [brand.name, brand.role])).toEqual([
      ["Qd Café Chain", "backer"],
      ["Qd Donut Co", "backer"],
    ]);
    expect(await fetch_owner_page("qd-hidden-holdings")).toBeNull();
    expect((await fetch_owners()).map((owner) => owner.slug)).toContain("qd-capital-partners");
  });
});

describe("sitemap and robots", () => {
  test("the sitemap lists static pages, public brands and owners", async () => {
    const urls = (await sitemap()).map((entry) => entry.url);
    expect(urls).toEqual(expect.arrayContaining([absolute_url("/"), absolute_url("/brands/qd-cafe-chain"), absolute_url("/owners/qd-growth-fund")]));
    expect(urls).not.toContain(absolute_url("/brands/qd-hidden-bakery"));
  });

  test("robots keeps crawlers out of admin and the API", () => {
    const rules = robots().rules as { disallow: string[] }[];
    expect(rules[0]!.disallow).toEqual(expect.arrayContaining(["/admin", "/api/"]));
  });
});
