import { Pool } from "pg";
import {
  MAX_RECOMMENDATIONS,
  SEARCH_RADIUS_METERS,
  fetch_corporate_location_by_address,
  fetch_nearby_independent_alternatives,
} from "@/lib/db/proximity";

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
  test_pool = new Pool({ connectionString: database_url, max: 2 });
});

afterAll(async () => {
  await test_pool.end();
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
