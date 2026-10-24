import { Pool } from "pg";
import { NextRequest } from "next/server";
import { GET as proximity_handler } from "@/app/api/proximity/route";
import { get_database_pool } from "@/lib/db/pool";
import {
  MAX_COLLECTION_LOCATIONS,
  drop_redundant_owners,
  fetch_brand_discovery,
  fetch_brand_suggestions,
  fetch_owner_discovery,
  fetch_owner_suggestions,
  reset_trigram_check,
} from "@/lib/db/brand-search";
import type { NearbyResponse, NeighborhoodSuggestionsResponse } from "@/lib/types";

/**
 * Brand and owner search against the seeded PostGIS database, with fixture brands:
 *   Qx Roastworks (Tier 2, parent Qx Group, backed by Qxstone Partners), 2 locations
 *   Qx Bagel Co. (Tier 1, parent Qxstone Partners), 1 location
 *   Qx Corner Bakery (Tier 3, independent), 1 location
 *   Qx Hidden Cafe (Tier 2, backed by Qxstone Partners), only outside any active market
 */
const database_url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/trueown";
const PREFIX = "Qx ";
const WEST_VILLAGE = { latitude: 40.7329, longitude: -74.0011 };
let pool: Pool;
const ids: Record<string, string> = {};

async function insert_brand(name: string, tier: number, parent: string | null, backers: string[] = []): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO brands (name, corporate_tier, industry_vertical, parent_entity, financial_backers)
     VALUES ($1, $2, 'coffee_bakery', $3, $4) RETURNING id`,
    [name, tier, parent, backers],
  );
  return result.rows[0]!.id;
}

async function insert_location(brand_id: string, address: string, latitude: number, longitude: number): Promise<void> {
  await pool.query(
    `INSERT INTO locations (brand_id, address, coordinates) VALUES ($1, $2, ST_SetSRID(ST_MakePoint($4, $3), 4326))`,
    [brand_id, address, latitude, longitude],
  );
}

async function cleanup(): Promise<void> {
  await pool.query(`DELETE FROM brands WHERE name LIKE $1`, [`${PREFIX}%`]);
  await pool.query(`UPDATE markets SET status = 'coming_soon' WHERE slug = 'qx-test'`).catch(() => undefined);
}

beforeAll(async () => {
  process.env.DATABASE_URL = database_url;
  pool = new Pool({ connectionString: database_url, max: 2 });
  await cleanup();
  ids.roast = await insert_brand(`${PREFIX}Roastworks`, 2, "Qx Group", ["Qxstone Partners"]);
  ids.bagel = await insert_brand(`${PREFIX}Bagel Co.`, 1, "Qxstone Partners");
  ids.corner = await insert_brand(`${PREFIX}Corner Bakery`, 3, null);
  ids.hidden = await insert_brand(`${PREFIX}Hidden Cafe`, 2, "Qx Hidden Holdings", ["Qxstone Partners"]);
  await insert_location(ids.roast, "1 Qx Far St, New York, NY", 40.7831, -73.9712); // Upper West Side
  await insert_location(ids.roast, "2 Qx Near St, New York, NY", 40.7335, -74.0027); // West Village
  await insert_location(ids.bagel, "3 Qx Bagel St, New York, NY", 40.7306, -73.9866);
  await insert_location(ids.corner, "4 Qx Corner St, New York, NY", 40.7340, -74.0050);
  // Austin is a coming-soon market: its locations never show on the public map.
  await insert_location(ids.hidden, "5 Qx Austin St, Austin, TX", 30.2672, -97.7431);
});

afterAll(async () => {
  await cleanup();
  await pool.end();
  await get_database_pool().end();
});

function call(query: string) {
  return proximity_handler(new NextRequest(`http://localhost/api/proximity${query}`));
}

describe("brand suggestions", () => {
  test("match a name fragment, with the location count and nearest distance", async () => {
    const brands = await fetch_brand_suggestions("qx roast", pool, { near: WEST_VILLAGE });
    expect(brands).toHaveLength(1);
    expect(brands[0]).toMatchObject({ name: `${PREFIX}Roastworks`, corporate_tier: 2, location_count: 2 });
    expect(brands[0]!.nearest_distance_meters).toBeLessThan(300);
  });

  test("names that start with the term come before ones that only contain it", async () => {
    const names = (await fetch_brand_suggestions("qx", pool)).map((brand) => brand.name);
    expect(names).toEqual(expect.arrayContaining([`${PREFIX}Roastworks`, `${PREFIX}Bagel Co.`, `${PREFIX}Corner Bakery`]));
    const bakery = (await fetch_brand_suggestions("bakery", pool)).map((brand) => brand.name);
    expect(bakery.indexOf(`${PREFIX}Corner Bakery`)).toBeGreaterThanOrEqual(0);
  });

  test("independents are searchable too", async () => {
    const [corner] = await fetch_brand_suggestions("qx corner", pool);
    expect(corner).toMatchObject({ corporate_tier: 3, location_count: 1 });
  });

  test("small typos still match when pg_trgm is installed", async () => {
    reset_trigram_check();
    const names = (await fetch_brand_suggestions("qx roastwork", pool)).map((brand) => brand.name);
    expect(names).toContain(`${PREFIX}Roastworks`);
    const typo = (await fetch_brand_suggestions("blank stret", pool)).map((brand) => brand.name);
    expect(typo).toContain("Blank Street Coffee");
    // Look-alikes are not typos.
    const look_alike = (await fetch_brand_suggestions("qx roast", pool)).map((brand) => brand.name);
    expect(look_alike).not.toContain("Mighty Oak Roasters");
  });

  test("brands with no location in an active market are never suggested", async () => {
    expect(await fetch_brand_suggestions("qx hidden", pool)).toEqual([]);
  });

  test("without pg_trgm, exact fragments still match (deploying before migration 11 is safe)", async () => {
    reset_trigram_check();
    const without_trigram = {
      query: (sql: string, params?: unknown[]) =>
        sql.includes("to_regprocedure") ? Promise.resolve({ rows: [{ available: false }] }) : pool.query(sql, params),
    } as unknown as Pool;
    try {
      expect((await fetch_brand_suggestions("qx roast", without_trigram)).map((brand) => brand.name)).toEqual([`${PREFIX}Roastworks`]);
      expect(await fetch_brand_suggestions("blank stret", without_trigram)).toEqual([]);
      expect((await fetch_owner_suggestions("qxstone", without_trigram)).map((owner) => owner.name)).toEqual(["Qxstone Partners"]);
    } finally {
      reset_trigram_check();
    }
  });

  test("wildcards in the input are plain text", async () => {
    expect(await fetch_brand_suggestions("%", pool)).toEqual([]);
    expect(await fetch_brand_suggestions("_", pool)).toEqual([]);
  });

  test("the city filter applies", async () => {
    expect(await fetch_brand_suggestions("qx roast", pool, { city: "Atlantis" })).toEqual([]);
  });
});

describe("owner suggestions", () => {
  test("a backer lists every visible brand it owns or funds", async () => {
    const owners = await fetch_owner_suggestions("qxstone", pool);
    expect(owners).toEqual([{ name: "Qxstone Partners", brand_names: [`${PREFIX}Bagel Co.`, `${PREFIX}Roastworks`] }]);
  });

  test("a single-brand parent of a listed brand is dropped; multi-brand owners stay", () => {
    const brands = [
      { brand_id: "x", name: "Blank Street Coffee", corporate_tier: 2 as const, industry_vertical: "coffee_bakery" as const, location_count: 1, nearest_distance_meters: null },
    ];
    expect(
      drop_redundant_owners(
        [
          { name: "Blank Street Inc.", brand_names: ["Blank Street Coffee"] },
          { name: "Big Fund", brand_names: ["Blank Street Coffee", "Other Coffee"] },
          { name: "Solo Parent", brand_names: ["Unlisted Coffee"] },
        ],
        brands,
      ).map((owner) => owner.name),
    ).toEqual(["Big Fund", "Solo Parent"]);
  });
});

describe("brand and owner views", () => {
  test("a corporate-backed brand lists its locations nearest first, each with independents", async () => {
    const view = await fetch_brand_discovery(ids.roast!, pool, { near: WEST_VILLAGE });
    expect(view?.origin).toMatchObject({ anchor: "user", total_locations: 2, latitude: WEST_VILLAGE.latitude });
    expect(view?.results.map((result) => result.target.address)).toEqual(["2 Qx Near St, New York, NY", "1 Qx Far St, New York, NY"]);
    expect(view?.results[0]!.target.distance_meters).toBeLessThan(300);
    expect(view?.results[0]!.alternatives.map((alternative) => alternative.brand_name)).toContain(`${PREFIX}Corner Bakery`);
  });

  test("without a position there are no distances and the map centres on the first location", async () => {
    const view = await fetch_brand_discovery(ids.roast!, pool);
    expect(view?.origin.anchor).toBe("none");
    expect(view?.results.every((result) => result.target.distance_meters === null)).toBe(true);
    expect(view?.origin.latitude).toBeCloseTo(view!.results[0]!.target.latitude, 5);
  });

  test("an independent brand's locations come back as independents", async () => {
    const view = await fetch_brand_discovery(ids.corner!, pool, { near: WEST_VILLAGE });
    expect(view?.results).toEqual([]);
    expect(view?.independent_locations.map((location) => location.address)).toEqual(["4 Qx Corner St, New York, NY"]);
  });

  test("an owner view covers every visible brand it backs", async () => {
    const view = await fetch_owner_discovery("  qxstone partners ", pool, { near: WEST_VILLAGE });
    expect(view?.subject).toEqual({ name: "Qxstone Partners", brand_names: [`${PREFIX}Bagel Co.`, `${PREFIX}Roastworks`] });
    expect(view?.origin.total_locations).toBe(3);
    expect(new Set(view?.results.map((result) => result.target.brand_name))).toEqual(
      new Set([`${PREFIX}Bagel Co.`, `${PREFIX}Roastworks`]),
    );
    expect(view!.results.length).toBeLessThanOrEqual(MAX_COLLECTION_LOCATIONS);
  });

  test("unknown or hidden brands and owners have no view", async () => {
    expect(await fetch_brand_discovery(ids.hidden!, pool)).toBeNull();
    expect(await fetch_brand_discovery("00000000-0000-0000-0000-000000000000", pool)).toBeNull();
    expect(await fetch_owner_discovery("Qx Hidden Holdings", pool)).toBeNull();
  });
});

describe("API", () => {
  test("suggestions include neighborhoods, brands and owners", async () => {
    const response = await call(`?suggest=qx&lat=${WEST_VILLAGE.latitude}&lng=${WEST_VILLAGE.longitude}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as NeighborhoodSuggestionsResponse;
    expect(Array.isArray(body.suggestions)).toBe(true);
    expect(body.brands.map((brand) => brand.name)).toContain(`${PREFIX}Roastworks`);
    expect(body.owners.map((owner) => owner.name)).toContain("Qxstone Partners");
  });

  test("brand and owner views", async () => {
    const brand = (await (await call(`?brand=${ids.roast}`)).json()) as NearbyResponse;
    expect(brand.origin).toMatchObject({ kind: "brand", brand: { name: `${PREFIX}Roastworks` }, anchor: "none" });
    expect(brand.results).toHaveLength(2);

    const owner = (await (await call(`?owner=Qxstone%20Partners&lat=40.73&lng=-74`)).json()) as NearbyResponse;
    expect(owner.origin).toMatchObject({ kind: "owner", owner: { name: "Qxstone Partners" }, anchor: "user" });
  });

  test("bad input is rejected", async () => {
    expect((await call("?brand=not-a-uuid")).status).toBe(400);
    expect((await call(`?brand=${ids.roast}&owner=x`)).status).toBe(400);
    expect((await call(`?brand=${ids.roast}&lat=95&lng=0`)).status).toBe(400);
    expect((await call(`?brand=${ids.roast}&lat=40.7`)).status).toBe(400);
    expect((await call("?suggest=qx&lat=abc&lng=1")).status).toBe(400);
    expect((await call(`?owner=${"x".repeat(101)}`)).status).toBe(400);
    expect((await call("?brand=00000000-0000-0000-0000-000000000000")).status).toBe(404);
    expect((await call("?owner=Nobody%20Capital")).status).toBe(404);
  });
});
