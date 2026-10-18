import { Pool } from "pg";
import { NextRequest } from "next/server";
import { GET as proximity_handler } from "@/app/api/proximity/route";
import { get_database_pool } from "@/lib/db/pool";
import {
  MAX_RECOMMENDATIONS,
  SEARCH_RADIUS_METERS,
  fetch_corporate_location_by_address,
  fetch_nearby_independent_alternatives,
  fetch_neighborhood_centroid,
  fetch_neighborhood_suggestions,
} from "@/lib/db/proximity";
import type { NearbyResponse, ProximityResponse } from "@/lib/types";

/**
 * Integration tests against a real PostGIS database seeded with
 * supabase/seed.sql (docker compose up -d db). No SQL is mocked: the
 * 1500m boundary is exercised by PostGIS itself.
 */
const database_url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/trueown";

const BLANK_STREET_ADDRESS = "186 W 4th St";

let test_pool: Pool;

beforeAll(() => {
  // The route handler resolves its own pool from DATABASE_URL; keep both on the same database.
  process.env.DATABASE_URL = database_url;
  test_pool = new Pool({ connectionString: database_url, max: 2 });
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

  test("a remote origin returns an empty, well-formed nearest payload", async () => {
    const response = await call_proximity("?scope=nearest&lat=51.5&lng=-0.12");
    expect(response.status).toBe(200);
    const payload = (await response.json()) as NearbyResponse;
    expect(payload.results).toEqual([]);
    expect(payload.origin_alternatives).toEqual([]);
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
    const response = await call_proximity("?neighborhood=West%20Village");
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
    const response = await call_proximity("?neighborhood=astoria");
    expect(response.status).toBe(200);
    const payload = (await response.json()) as NearbyResponse;
    expect(payload.results).toEqual([]);
    expect(payload.origin_alternatives.map((alternative) => alternative.brand_name)).toEqual([
      "Mighty Oak Roasters",
    ]);
  });

  test("unknown or invalid neighborhood input is rejected cleanly", async () => {
    expect((await call_proximity("?neighborhood=Atlantis")).status).toBe(404);
    expect((await call_proximity("?neighborhood=%20")).status).toBe(400);
    expect((await call_proximity(`?neighborhood=${"x".repeat(101)}`)).status).toBe(400);
  });

  test("lookahead suggests by prefix and treats LIKE wildcards literally", async () => {
    expect(await fetch_neighborhood_suggestions("wes", test_pool)).toEqual(["West Village"]);
    expect(await fetch_neighborhood_suggestions("%", test_pool)).toEqual([]);

    const response = await call_proximity("?suggest=gre");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ suggestions: ["Greenwich Village"] });
    expect((await call_proximity("?suggest=%20")).status).toBe(400);
  });
});
