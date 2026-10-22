import { ensure_boundaries_loaded } from "@/lib/import/nta-file";
import { Pool } from "pg";
import { NextRequest } from "next/server";
import { GET as proximity_handler } from "@/app/api/proximity/route";
import { get_database_pool } from "@/lib/db/pool";
import {
  MAX_RECOMMENDATIONS,
  MARKET_RADIUS_METERS,
  SEARCH_RADIUS_METERS,
  fetch_corporate_location_by_address,
  fetch_nearby_independent_alternatives,
  fetch_catalog,
  fetch_neighborhood_centroid,
  fetch_neighborhood_suggestions,
} from "@/lib/db/proximity";
import type { NearbyResponse, OutsideMarketResponse, ProximityResponse } from "@/lib/types";

/**
 * Integration tests against a real PostGIS database seeded with
 * supabase/seed.sql (docker compose up -d db). No SQL is mocked: the
 * 1500m boundary is exercised by PostGIS itself.
 */
const database_url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/trueown";

const BLANK_STREET_ADDRESS = "186 W 4th St";

let test_pool: Pool;

beforeAll(async () => {
  // The route handler resolves its own pool from DATABASE_URL; keep both on the same database.
  process.env.DATABASE_URL = database_url;
  test_pool = new Pool({ connectionString: database_url, max: 2 });
  await ensure_boundaries_loaded(test_pool);
});

afterAll(async () => {
  await test_pool.end();
  await get_database_pool().end();
});

async function resolve_blank_street() {
  const target = await fetch_corporate_location_by_address(BLANK_STREET_ADDRESS, test_pool);
  if (!target) {
    throw new Error("Seed data missing: Blank Street at 186 W 4th St not found.");
  }
  return target;
}

describe("proximity lookup: 1500m PostGIS boundary", () => {
  test("A (within range): captures Porto Rico Importing Co. at roughly 200-300m", async () => {
    const target = await resolve_blank_street();
    expect(target.brand_name).toBe("Blank Street Coffee");
    expect(target.corporate_tier).toBe(2);

    const alternatives = await fetch_nearby_independent_alternatives(
      target.latitude,
      target.longitude,
      target.industry_vertical,
      test_pool,
    );

    const porto_rico = alternatives.find(
      (alternative) => alternative.brand_name === "Porto Rico Importing Co.",
    );
    expect(porto_rico).toBeDefined();
    expect(porto_rico!.distance_meters).toBeGreaterThanOrEqual(200);
    expect(porto_rico!.distance_meters).toBeLessThanOrEqual(300);
    expect(porto_rico!.distance_label).toBe(`${porto_rico!.distance_meters}m away`);
  });

  test("B (out of range): excludes Mighty Oak Roasters in Astoria (~9km away)", async () => {
    const target = await resolve_blank_street();

    // Prove the fixture really is far away, so exclusion is due to the radius.
    const distance_result = await test_pool.query<{ distance_meters: number }>(
      `SELECT ST_Distance(l.coordinates::geography,
                          ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) AS distance_meters
         FROM locations l JOIN brands b ON b.id = l.brand_id
        WHERE b.name = 'Mighty Oak Roasters'`,
      [target.latitude, target.longitude],
    );
    const astoria_distance = Number(distance_result.rows[0]?.distance_meters);
    expect(astoria_distance).toBeGreaterThan(SEARCH_RADIUS_METERS);
    expect(astoria_distance).toBeGreaterThan(8000);
    expect(astoria_distance).toBeLessThan(12000);

    const alternatives = await fetch_nearby_independent_alternatives(
      target.latitude,
      target.longitude,
      target.industry_vertical,
      test_pool,
    );
    expect(alternatives.map((alternative) => alternative.brand_name)).not.toContain(
      "Mighty Oak Roasters",
    );
  });

  test("results never exceed the radius and are strictly sorted closest to furthest", async () => {
    const target = await resolve_blank_street();
    const alternatives = await fetch_nearby_independent_alternatives(
      target.latitude,
      target.longitude,
      target.industry_vertical,
      test_pool,
    );

    expect(alternatives.length).toBeGreaterThan(1);
    expect(alternatives.length).toBeLessThanOrEqual(MAX_RECOMMENDATIONS);

    const distances = alternatives.map((alternative) => alternative.distance_meters);
    expect(distances.every((distance) => distance <= SEARCH_RADIUS_METERS)).toBe(true);
    expect(distances).toEqual([...distances].sort((first, second) => first - second));
    expect(alternatives[0]?.brand_name).toBe("Porto Rico Importing Co.");
  });

  test("only Tier 3 brands are ever returned", async () => {
    const target = await resolve_blank_street();
    const alternatives = await fetch_nearby_independent_alternatives(
      target.latitude,
      target.longitude,
      target.industry_vertical,
      test_pool,
    );
    const corporate_names = ["Blank Street Coffee", "Maman", "Magnolia Bakery"];
    for (const alternative of alternatives) {
      expect(corporate_names).not.toContain(alternative.brand_name);
    }
  });
});

/** Calls the real Route Handler in-process against the seeded database. */
async function call_proximity(query: string): Promise<Response> {
  return proximity_handler(new NextRequest(`http://localhost/api/proximity${query}`));
}

describe("C: zero-state results", () => {
  // Blank Street at 980 Lexington Ave (Upper East Side) is several km from every Tier 3 seed.
  const UES_LATITUDE = 40.7698;
  const UES_LONGITUDE = -73.9612;

  test("helper returns an empty array (no throw) when no independents are in range", async () => {
    const alternatives = await fetch_nearby_independent_alternatives(
      UES_LATITUDE,
      UES_LONGITUDE,
      "coffee_bakery",
      test_pool,
    );
    expect(alternatives).toEqual([]);
  });

  test("API returns 200 with a structured payload and an empty alternatives array", async () => {
    const response = await call_proximity(`?lat=${UES_LATITUDE}&lng=${UES_LONGITUDE}`);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as ProximityResponse;
    expect(payload.target_brand_name).toBe("Blank Street Coffee");
    expect(payload.target_corporate_tier).toBe(2);
    expect(payload.radius_meters).toBe(SEARCH_RADIUS_METERS);
    expect(Array.isArray(payload.alternatives)).toBe(true);
    expect(payload.alternatives).toHaveLength(0);
  });

  test("a remote origin gets a structured outside-market response naming the closest active market", async () => {
    const response = await call_proximity("?scope=nearest&lat=51.5&lng=-0.12&vertical=coffee_bakery");
    expect(response.status).toBe(200);
    const payload = (await response.json()) as OutsideMarketResponse;
    expect(payload.status).toBe("outside_active_market");
    expect(payload.closest_active_market?.city_name).toBe("New York City");
    expect(payload.closest_active_market?.distance_meters).toBeGreaterThan(MARKET_RADIUS_METERS);
    expect(payload).not.toHaveProperty("results");
  });
});

describe("D: null / malformed coordinate guard", () => {
  const BAD_QUERIES: ReadonlyArray<readonly [string, string]> = [
    ["no parameters", ""],
    ["missing lng", "?lat=40.7"],
    ["missing lat", "?lng=-74.0"],
    ["alphanumeric lat", "?lat=abc&lng=-74.0"],
    ["alphanumeric lng", "?lat=40.7&lng=12ab"],
    ["empty values", "?lat=&lng="],
    ["whitespace values", "?lat=%20&lng=%20"],
    ["NaN literal", "?lat=NaN&lng=-74.0"],
    ["Infinity literal", "?lat=Infinity&lng=-74.0"],
    ["latitude out of range", "?lat=91&lng=-74.0"],
    ["longitude out of range", "?lat=40.7&lng=-181"],
    ["SQL injection attempt", "?lat=40.7%3B%20DROP%20TABLE%20brands&lng=-74.0"],
    ["invalid scope", "?lat=40.7&lng=-74.0&scope=everything"],
  ];

  test.each(BAD_QUERIES)("%s -> 400 Bad Request with an error body", async (_label, query) => {
    const response = await call_proximity(query);
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string };
    expect(typeof payload.error).toBe("string");
    expect(payload.error.length).toBeGreaterThan(0);
  });

  test("the injection attempt left the database intact", async () => {
    const result = await test_pool.query("SELECT count(*)::int AS total FROM brands");
    expect(result.rows[0].total).toBeGreaterThan(0);
  });
});

describe("neighborhood text fallback: centroid origin + 1500m search", () => {
  test("resolves a case-insensitive centroid inside the expected area", async () => {
    const centroid = await fetch_neighborhood_centroid("west village", test_pool);
    expect(centroid?.neighborhood).toBe("West Village");
    expect(centroid!.latitude).toBeGreaterThan(40.73);
    expect(centroid!.latitude).toBeLessThan(40.74);
    expect(centroid!.longitude).toBeGreaterThan(-74.01);
    expect(centroid!.longitude).toBeLessThan(-74.0);
  });

  test("West Village: alternatives are bounded to 1500m of the centroid and sorted", async () => {
    const response = await call_proximity("?neighborhood=West%20Village&vertical=coffee_bakery");
    expect(response.status).toBe(200);
    const payload = (await response.json()) as NearbyResponse;

    expect(payload.origin.kind).toBe("neighborhood");
    const names = payload.origin_alternatives.map((alternative) => alternative.brand_name);
    expect(names).toContain("Porto Rico Importing Co.");
    expect(names).not.toContain("Mighty Oak Roasters");

    const distances = payload.origin_alternatives.map((alternative) => alternative.distance_meters);
    expect(distances.every((distance) => distance <= SEARCH_RADIUS_METERS)).toBe(true);
    expect(distances).toEqual([...distances].sort((first, second) => first - second));
    expect(payload.results.map((entry) => entry.target.brand_name).sort()).toEqual([
      "Blank Street Coffee",
      "Magnolia Bakery",
    ]);
  });

  test("Astoria: no corporate brands, but its centroid still finds Mighty Oak Roasters", async () => {
    const response = await call_proximity("?neighborhood=astoria&vertical=coffee_bakery");
    expect(response.status).toBe(200);
    const payload = (await response.json()) as NearbyResponse;
    expect(payload.results).toEqual([]);
    expect(payload.origin_alternatives.map((alternative) => alternative.brand_name)).toEqual([
      "Mighty Oak Roasters",
    ]);
  });

  test("unknown or invalid neighborhood input is rejected cleanly", async () => {
    const scope = "&vertical=coffee_bakery";
    expect((await call_proximity(`?neighborhood=Atlantis${scope}`)).status).toBe(404);
    expect((await call_proximity(`?neighborhood=%20${scope}`)).status).toBe(400);
    expect((await call_proximity(`?neighborhood=${"x".repeat(101)}${scope}`)).status).toBe(400);
  });

  test("lookahead suggests by prefix and treats LIKE wildcards literally", async () => {
    const west = await fetch_neighborhood_suggestions("wes", test_pool);
    expect(west[0]).toBe("West Village");
    expect(west.length).toBeLessThanOrEqual(8);
    expect(await fetch_neighborhood_suggestions("%", test_pool)).toEqual([]);

    const response = await call_proximity("?suggest=gre");
    expect(response.status).toBe(200);
    const { suggestions } = (await response.json()) as { suggestions: string[] };
    expect(suggestions[0]).toBe("Greenwich Village");
    expect((await call_proximity("?suggest=%20")).status).toBe(400);
  });
});

describe("city and vertical scope", () => {
  test("a search that starts from a location requires an industry vertical", async () => {
    expect((await call_proximity("?neighborhood=West%20Village")).status).toBe(400);
    expect((await call_proximity("?scope=nearest&lat=40.7324&lng=-74.0021")).status).toBe(400);
  });

  test("a vertical with no storefronts returns nothing; the right one still matches", async () => {
    const empty = (await (await call_proximity("?neighborhood=West%20Village&vertical=restaurant")).json()) as NearbyResponse;
    expect(empty.results).toEqual([]);
    expect(empty.origin_alternatives).toEqual([]);

    const coffee = (await (await call_proximity("?neighborhood=West%20Village&vertical=coffee_bakery")).json()) as NearbyResponse;
    expect(coffee.results.length).toBeGreaterThan(0);
  });

  test("nearest search honours the vertical filter", async () => {
    const none = (await (await call_proximity("?scope=nearest&lat=40.7324&lng=-74.0021&vertical=bar_nightlife")).json()) as NearbyResponse;
    expect(none.results).toEqual([]);
  });

  test("city scope narrows neighborhood matching and suggestions", async () => {
    expect((await call_proximity("?neighborhood=West%20Village&city=New%20York&vertical=coffee_bakery")).status).toBe(200);
    expect((await call_proximity("?neighborhood=West%20Village&city=Atlantis&vertical=coffee_bakery")).status).toBe(404);
    const response = await call_proximity("?suggest=wes&city=Atlantis");
    expect(((await response.json()) as { suggestions: string[] }).suggestions).toEqual([]);
  });

  test("malformed scope parameters are rejected, never widened", async () => {
    expect((await call_proximity("?neighborhood=Astoria&vertical=bogus")).status).toBe(400);
    expect((await call_proximity("?neighborhood=Astoria&city=%20")).status).toBe(400);
    expect((await call_proximity(`?neighborhood=Astoria&city=${"x".repeat(101)}`)).status).toBe(400);
  });

  test("catalog lists the cities and verticals that have storefronts", async () => {
    const catalog = await fetch_catalog(test_pool);
    expect(catalog.cities).toContain("New York City");
    expect(catalog.verticals).toContain("coffee_bakery");
  });
});

describe("neighborhood label point", () => {
  test("every boundary name resolves to a point inside its own polygons", async () => {
    const names = await test_pool.query<{ name: string }>("SELECT DISTINCT name FROM neighborhood_boundaries");
    expect(names.rows.length).toBeGreaterThan(200);
    const outside: string[] = [];
    for (const { name } of names.rows) {
      const centroid = await fetch_neighborhood_centroid(name, test_pool);
      if (!centroid) continue;
      const inside = await test_pool.query<{ covered: boolean }>(
        `SELECT bool_or(ST_Covers(geometry, ST_SetSRID(ST_MakePoint($2, $1), 4326))) AS covered
           FROM neighborhood_boundaries WHERE id = ANY($3::uuid[])`,
        [centroid.latitude, centroid.longitude, centroid.boundary_ids],
      );
      if (!inside.rows[0]?.covered) outside.push(name);
    }
    expect(outside).toEqual([]);
  }, 60_000);
});

/* ------------------------------------------------------------------------- */
/* Multi-market and multi-vertical fixtures (Austin and Chicago go live)      */
/* ------------------------------------------------------------------------- */

interface FixtureStorefront {
  brand: string;
  tier: 2 | 3;
  vertical: "coffee_bakery" | "bar_nightlife";
  market_city: "Austin" | "Chicago";
  latitude: number;
  longitude: number;
}

const FIXTURE_PREFIX = "ZZ Market Test";
const AUSTIN_BAR_CORP = { latitude: 30.27, longitude: -97.74 };

const FIXTURE_STOREFRONTS: readonly FixtureStorefront[] = [
  { brand: `${FIXTURE_PREFIX} Austin Roasters`, tier: 3, vertical: "coffee_bakery", market_city: "Austin", latitude: 30.268, longitude: -97.7431 },
  { brand: `${FIXTURE_PREFIX} Austin Coffee Corp`, tier: 2, vertical: "coffee_bakery", market_city: "Austin", latitude: 30.2701, longitude: -97.74 },
  { brand: `${FIXTURE_PREFIX} Austin Cafe`, tier: 3, vertical: "coffee_bakery", market_city: "Austin", latitude: 30.2702, longitude: -97.7401 },
  { brand: `${FIXTURE_PREFIX} Austin Bar Corp`, tier: 2, vertical: "bar_nightlife", market_city: "Austin", ...AUSTIN_BAR_CORP },
  { brand: `${FIXTURE_PREFIX} Austin Dive Bar`, tier: 3, vertical: "bar_nightlife", market_city: "Austin", latitude: 30.2704, longitude: -97.7398 },
  { brand: `${FIXTURE_PREFIX} Chicago Coffee Corp`, tier: 2, vertical: "coffee_bakery", market_city: "Chicago", latitude: 41.8781, longitude: -87.6298 },
  { brand: `${FIXTURE_PREFIX} Chicago Roasters`, tier: 3, vertical: "coffee_bakery", market_city: "Chicago", latitude: 41.8785, longitude: -87.63 },
];

async function delete_market_fixtures(): Promise<void> {
  await test_pool.query("DELETE FROM brands WHERE name LIKE $1", [`${FIXTURE_PREFIX}%`]);
}

describe("regional markets and verticals", () => {
  beforeAll(async () => {
    await delete_market_fixtures();
    await test_pool.query("UPDATE markets SET status = 'active' WHERE city_name IN ('Austin', 'Chicago')");
    for (const [index, storefront] of FIXTURE_STOREFRONTS.entries()) {
      const brand = await test_pool.query<{ id: string }>(
        `INSERT INTO brands (name, corporate_tier, industry_vertical, parent_entity, unique_selling_proposition)
         VALUES ($1, $2, $3::industry_vertical, $4, $5) RETURNING id`,
        [storefront.brand, storefront.tier, storefront.vertical, storefront.tier === 3 ? null : "ZZ Capital", "Fixture"],
      );
      await test_pool.query(
        `INSERT INTO locations (brand_id, address, city, coordinates)
         VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326))`,
        [brand.rows[0]!.id, `${index} Fixture St`, storefront.market_city, storefront.longitude, storefront.latitude],
      );
    }
  });

  afterAll(async () => {
    await delete_market_fixtures();
    await test_pool.query("UPDATE markets SET status = 'coming_soon' WHERE city_name IN ('Austin', 'Chicago')");
  });

  async function market_cities_of(location_ids: string[]): Promise<string[]> {
    const result = await test_pool.query<{ city_name: string }>(
      `SELECT DISTINCT m.city_name FROM locations l JOIN markets m ON m.id = l.market_id WHERE l.id = ANY($1::uuid[])`,
      [location_ids],
    );
    return result.rows.map((row) => row.city_name);
  }

  test("locations are assigned to the market covering their coordinates", async () => {
    const result = await test_pool.query<{ brand: string; city_name: string }>(
      `SELECT b.name AS brand, m.city_name
         FROM locations l JOIN brands b ON b.id = l.brand_id JOIN markets m ON m.id = l.market_id
        WHERE b.name LIKE $1`,
      [`${FIXTURE_PREFIX}%`],
    );
    expect(result.rows).toHaveLength(FIXTURE_STOREFRONTS.length);
    for (const row of result.rows) {
      expect(row.city_name).toBe(row.brand.includes("Chicago") ? "Chicago" : "Austin");
    }
    await expect(
      test_pool.query(
        `INSERT INTO locations (brand_id, address, city, coordinates)
         SELECT id, 'Nowhere', 'Nowhere', ST_SetSRID(ST_MakePoint(0, 0), 4326) FROM brands WHERE name LIKE $1 LIMIT 1`,
        [`${FIXTURE_PREFIX}%`],
      ),
    ).rejects.toThrow(/not within 50 miles of any market/);
  });

  test("E (cross-market isolation): an Austin query returns only Austin venues, never NYC or Chicago", async () => {
    const response = await call_proximity(
      `?scope=nearest&lat=${AUSTIN_BAR_CORP.latitude}&lng=${AUSTIN_BAR_CORP.longitude}&vertical=coffee_bakery`,
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as NearbyResponse;

    expect(payload.results.length).toBeGreaterThan(0);
    const brand_names = [
      ...payload.results.map((entry) => entry.target.brand_name),
      ...payload.results.flatMap((entry) => entry.alternatives.map((alternative) => alternative.brand_name)),
    ];
    expect(brand_names).toContain(`${FIXTURE_PREFIX} Austin Cafe`);
    expect(brand_names.every((name) => name.startsWith(`${FIXTURE_PREFIX} Austin`))).toBe(true);

    const location_ids = payload.results.flatMap((entry) => [
      entry.target.location_id,
      ...entry.alternatives.map((alternative) => alternative.location_id),
    ]);
    expect(await market_cities_of(location_ids)).toEqual(["Austin"]);

    // The market filter holds even where the radius would otherwise match: Austin's point
    // scoped to the NYC market yields nothing.
    const nyc_market = await test_pool.query<{ id: string }>("SELECT id FROM markets WHERE city_name = 'New York City'");
    const bleed = await fetch_nearby_independent_alternatives(
      AUSTIN_BAR_CORP.latitude,
      AUSTIN_BAR_CORP.longitude,
      "coffee_bakery",
      test_pool,
      nyc_market.rows[0]!.id,
    );
    expect(bleed).toEqual([]);

    // And the reverse: an NYC query never surfaces the Austin or Chicago fixtures.
    const nyc = (await (await call_proximity("?scope=nearest&lat=40.7324&lng=-74.0021&vertical=coffee_bakery")).json()) as NearbyResponse;
    const nyc_names = nyc.results.flatMap((entry) => [entry.target.brand_name, ...entry.alternatives.map((a) => a.brand_name)]);
    expect(nyc_names.length).toBeGreaterThan(0);
    expect(nyc_names.some((name) => name.startsWith(FIXTURE_PREFIX))).toBe(false);
  });

  test("E: Chicago coordinates resolve to Chicago only", async () => {
    const response = await call_proximity("?scope=nearest&lat=41.8781&lng=-87.6298&vertical=coffee_bakery");
    const payload = (await response.json()) as NearbyResponse;
    const names = payload.results.flatMap((entry) => [entry.target.brand_name, ...entry.alternatives.map((a) => a.brand_name)]);
    expect(names).toEqual([`${FIXTURE_PREFIX} Chicago Coffee Corp`, `${FIXTURE_PREFIX} Chicago Roasters`]);
  });

  test("a market that is not active is treated as outside the service area", async () => {
    await test_pool.query("UPDATE markets SET status = 'coming_soon' WHERE city_name = 'Chicago'");
    try {
      const payload = (await (await call_proximity("?scope=nearest&lat=41.8781&lng=-87.6298&vertical=coffee_bakery")).json()) as OutsideMarketResponse;
      expect(payload.status).toBe("outside_active_market");
      expect(payload.closest_active_market?.city_name).not.toBe("Chicago");
    } finally {
      await test_pool.query("UPDATE markets SET status = 'active' WHERE city_name = 'Chicago'");
    }
  });

  test("F (category disambiguation): a bar_nightlife query returns zero coffee shops in the same block", async () => {
    // Exact-point lookup on the bar's own coordinates; a coffee corporate storefront sits ~11m away.
    const response = await call_proximity(
      `?lat=${AUSTIN_BAR_CORP.latitude}&lng=${AUSTIN_BAR_CORP.longitude}&vertical=bar_nightlife`,
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as ProximityResponse;
    expect(payload.target_brand_name).toBe(`${FIXTURE_PREFIX} Austin Bar Corp`);
    expect(payload.industry_vertical).toBe("bar_nightlife");
    expect(payload.alternatives.map((alternative) => alternative.brand_name)).toEqual([`${FIXTURE_PREFIX} Austin Dive Bar`]);

    // Nearest search: no coffee storefront appears as a target or an alternative.
    const nearest = (await (
      await call_proximity(
        `?scope=nearest&lat=${AUSTIN_BAR_CORP.latitude}&lng=${AUSTIN_BAR_CORP.longitude}&vertical=bar_nightlife`,
      )
    ).json()) as NearbyResponse;
    const names = nearest.results.flatMap((entry) => [entry.target.brand_name, ...entry.alternatives.map((a) => a.brand_name)]);
    expect(names).toEqual([`${FIXTURE_PREFIX} Austin Bar Corp`, `${FIXTURE_PREFIX} Austin Dive Bar`]);
    expect(names.some((name) => /Cafe|Coffee|Roasters/.test(name))).toBe(false);
  });

  test("F: the vertical is honoured in the database, not just in the response", async () => {
    const coffee = await fetch_nearby_independent_alternatives(
      AUSTIN_BAR_CORP.latitude,
      AUSTIN_BAR_CORP.longitude,
      "coffee_bakery",
      test_pool,
    );
    expect(coffee.map((alternative) => alternative.brand_name)).toEqual([
      `${FIXTURE_PREFIX} Austin Cafe`,
      `${FIXTURE_PREFIX} Austin Roasters`,
    ]);
    const restaurants = await fetch_nearby_independent_alternatives(
      AUSTIN_BAR_CORP.latitude,
      AUSTIN_BAR_CORP.longitude,
      "restaurant",
      test_pool,
    );
    expect(restaurants).toEqual([]);
  });
});
