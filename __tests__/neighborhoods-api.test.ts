import { Pool } from "pg";
import { NextRequest } from "next/server";
import { GET as neighborhoods_handler } from "@/app/api/neighborhoods/route";
import { get_database_pool } from "@/lib/db/pool";
import { MAX_POPULAR_NEIGHBORHOODS, fetch_neighborhoods, fetch_popular_neighborhoods } from "@/lib/db/proximity";

/** Integration tests against the seeded PostGIS database (supabase/seed.sql). */
const database_url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/trueown";
let test_pool: Pool;

beforeAll(() => {
  process.env.DATABASE_URL = database_url;
  test_pool = new Pool({ connectionString: database_url, max: 2 });
});

afterAll(async () => {
  await test_pool.end();
  await get_database_pool().end();
});

function call(query: string) {
  return neighborhoods_handler(new NextRequest(`http://localhost/api/neighborhoods${query}`));
}

describe("popular neighborhoods (search panel quick picks)", () => {
  test("returns the neighborhoods with the most storefronts first", async () => {
    const popular = await fetch_popular_neighborhoods(3, test_pool);
    expect(popular.length).toBeGreaterThan(0);
    expect(popular.length).toBeLessThanOrEqual(3);

    const counts = await test_pool.query<{ neighborhood: string; count: string }>(
      `SELECT neighborhood, count(*) FROM locations WHERE neighborhood IS NOT NULL GROUP BY neighborhood`,
    );
    const count_of = new Map(counts.rows.map((row) => [row.neighborhood, Number(row.count)]));
    const ordered = popular.map((name) => count_of.get(name) ?? 0);
    expect([...ordered].sort((a, b) => b - a)).toEqual(ordered);
    const highest = Math.max(...count_of.values());
    expect(count_of.get(popular[0]!)).toBe(highest);
  });

  test("every popular pick is also in the full list", async () => {
    const all = new Set(await fetch_neighborhoods(test_pool));
    for (const name of await fetch_popular_neighborhoods(MAX_POPULAR_NEIGHBORHOODS, test_pool)) {
      expect(all.has(name)).toBe(true);
    }
  });

  test("the API honours ?popular and its bounds", async () => {
    const response = await call("?popular=2");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { neighborhoods: string[] };
    expect(body.neighborhoods.length).toBeLessThanOrEqual(2);

    for (const bad of ["0", "-1", "1.5", "abc", String(MAX_POPULAR_NEIGHBORHOODS + 1)]) {
      expect((await call(`?popular=${bad}`)).status).toBe(400);
    }
  });

  test("an unknown city has no popular neighborhoods", async () => {
    const body = (await (await call("?popular=6&city=Atlantis")).json()) as { neighborhoods: string[] };
    expect(body.neighborhoods).toEqual([]);
  });

  test("without ?popular the full list is returned as before", async () => {
    const body = (await (await call("")).json()) as { neighborhoods: string[] };
    expect(body.neighborhoods).toEqual(await fetch_neighborhoods(test_pool));
  });
});
