import { Pool, PoolClient } from "pg";
import {
  SEARCH_RADIUS_METERS,
  fetch_corporate_location_by_address,
  fetch_nearby_independent_alternatives,
  fetch_nearest_corporate_discovery,
  fetch_neighborhood_corporate_discovery,
} from "@/lib/db/proximity";

/**
 * Verifies the RLS boundaries against the real database by impersonating the
 * Supabase roles (anon / authenticated + JWT claims) inside rolled-back
 * transactions, and that proximity filtering still works under those roles.
 */
const database_url =
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/trueown";

type ApiRole = "anon" | "authenticated";

const ADMIN_CLAIMS = { role: "authenticated", app_metadata: { role: "admin" } };
const FORGED_CLAIMS = { role: "authenticated", user_metadata: { role: "admin" } };
const USER_CLAIMS = { role: "authenticated" };

let test_pool: Pool;

beforeAll(() => {
  test_pool = new Pool({ connectionString: database_url, max: 2 });
});

afterAll(async () => {
  await test_pool.end();
});

/** Runs the callback in a transaction that is always rolled back. */
async function within_rollback<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await test_pool.connect();
  try {
    await client.query("BEGIN");
    return await run(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function act_as(
  client: PoolClient,
  role: ApiRole,
  claims: Record<string, unknown> | null = null,
): Promise<void> {
  await client.query(`SET LOCAL ROLE ${role}`);
  await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
    claims === null ? "" : JSON.stringify(claims),
  ]);
}

const NEW_BRAND_SQL = `INSERT INTO brands (name, corporate_tier, industry_vertical)
                       VALUES ('RLS Test Roasters', 3, 'coffee_bakery')`;
const NEW_SUBMISSION_SQL = `INSERT INTO submissions (business_name, street_address, evidence_url)
                            VALUES ('Tip Co', '1 Main St', 'https://example.com/news')`;

describe("RLS: brands and locations", () => {
  test("anonymous users can read both tables", async () => {
    await within_rollback(async (client) => {
      await act_as(client, "anon");
      const brands = await client.query("SELECT 1 FROM brands");
      const locations = await client.query("SELECT 1 FROM locations");
      expect(brands.rowCount).toBeGreaterThan(0);
      expect(locations.rowCount).toBeGreaterThan(0);
    });
  });

  test("anonymous users cannot insert, update, or delete", async () => {
    for (const statement of [
      NEW_BRAND_SQL,
      "UPDATE brands SET name = 'x'",
      "DELETE FROM locations",
    ]) {
      await within_rollback(async (client) => {
        await act_as(client, "anon");
        await expect(client.query(statement)).rejects.toThrow(/permission denied/);
      });
    }
  });

  test("authenticated non-admins and forged user_metadata admins cannot write", async () => {
    for (const claims of [USER_CLAIMS, FORGED_CLAIMS]) {
      await within_rollback(async (client) => {
        await act_as(client, "authenticated", claims);
        await expect(client.query(NEW_BRAND_SQL)).rejects.toThrow(/row-level security/);
      });
      await within_rollback(async (client) => {
        await act_as(client, "authenticated", claims);
        const updated = await client.query("UPDATE brands SET name = name");
        const deleted = await client.query("DELETE FROM brands");
        expect(updated.rowCount).toBe(0);
        expect(deleted.rowCount).toBe(0);
      });
    }
  });

  test("authenticated admins can write", async () => {
    await within_rollback(async (client) => {
      await act_as(client, "authenticated", ADMIN_CLAIMS);
      const inserted = await client.query(NEW_BRAND_SQL);
      expect(inserted.rowCount).toBe(1);
      const updated = await client.query(
        "UPDATE brands SET unique_selling_proposition = 'ok' WHERE name = 'RLS Test Roasters'",
      );
      expect(updated.rowCount).toBe(1);
    });
  });
});

describe("RLS: submissions", () => {
  test("anonymous users can insert a pending tip but cannot read submissions", async () => {
    await within_rollback(async (client) => {
      await act_as(client, "anon");
      const inserted = await client.query(NEW_SUBMISSION_SQL);
      expect(inserted.rowCount).toBe(1);
    });
    await within_rollback(async (client) => {
      await act_as(client, "anon");
      await expect(client.query("SELECT * FROM submissions")).rejects.toThrow(/permission denied/);
    });
  });

  test("anonymous users cannot self-approve or bypass the evidence rule", async () => {
    await within_rollback(async (client) => {
      await act_as(client, "anon");
      await expect(
        client.query(
          `INSERT INTO submissions (business_name, street_address, evidence_url, status)
           VALUES ('Tip Co', '1 Main St', 'https://example.com/news', 'approved')`,
        ),
      ).rejects.toThrow(/row-level security/);
    });
    await within_rollback(async (client) => {
      await act_as(client, "anon");
      await expect(
        client.query(
          `INSERT INTO submissions (business_name, street_address, evidence_url)
           VALUES ('Tip Co', '1 Main St', 'not-a-url')`,
        ),
      ).rejects.toThrow(/check constraint/);
    });
  });

  test("non-admin authenticated users see zero submissions; admins see them", async () => {
    await within_rollback(async (client) => {
      await act_as(client, "anon");
      await client.query(NEW_SUBMISSION_SQL);

      await act_as(client, "authenticated", USER_CLAIMS);
      const as_user = await client.query("SELECT 1 FROM submissions");
      expect(as_user.rowCount).toBe(0);

      await act_as(client, "authenticated", FORGED_CLAIMS);
      const as_forged = await client.query("SELECT 1 FROM submissions");
      expect(as_forged.rowCount).toBe(0);

      await act_as(client, "authenticated", ADMIN_CLAIMS);
      const as_admin = await client.query("SELECT 1 FROM submissions");
      expect(as_admin.rowCount).toBe(1);
      const reviewed = await client.query(
        "UPDATE submissions SET status = 'rejected', reviewed_at = now()",
      );
      expect(reviewed.rowCount).toBe(1);
    });
  });
});

describe("proximity filtering is unaffected by RLS", () => {
  test("anon role gets the same sorted, 1500m-bounded alternatives", async () => {
    await within_rollback(async (client) => {
      await act_as(client, "anon");
      const target = await fetch_corporate_location_by_address("186 W 4th St", client);
      expect(target?.brand_name).toBe("Blank Street Coffee");

      const alternatives = await fetch_nearby_independent_alternatives(
        target!.latitude,
        target!.longitude,
        target!.industry_vertical,
        client,
      );
      const names = alternatives.map((alternative) => alternative.brand_name);
      expect(names[0]).toBe("Porto Rico Importing Co.");
      expect(names).not.toContain("Mighty Oak Roasters");

      const distances = alternatives.map((alternative) => alternative.distance_meters);
      expect(distances.every((distance) => distance <= SEARCH_RADIUS_METERS)).toBe(true);
      expect(distances).toEqual([...distances].sort((first, second) => first - second));
    });
  });

  test("nearest-corporate discovery from a West Village position is sorted and self-contained", async () => {
    await within_rollback(async (client) => {
      await act_as(client, "anon");
      const results = await fetch_nearest_corporate_discovery(40.7324, -74.0021, client);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.target.brand_name).toBe("Blank Street Coffee");

      const corporate_distances = results.map((entry) => entry.target.distance_meters ?? 0);
      expect(corporate_distances).toEqual([...corporate_distances].sort((a, b) => a - b));

      for (const entry of results) {
        const distances = entry.alternatives.map((alternative) => alternative.distance_meters);
        expect(distances).toEqual([...distances].sort((a, b) => a - b));
        expect(distances.every((distance) => distance <= SEARCH_RADIUS_METERS)).toBe(true);
      }
    });
  });

  test("neighborhood discovery returns only that neighborhood's corporate brands", async () => {
    await within_rollback(async (client) => {
      await act_as(client, "anon");
      const west_village = await fetch_neighborhood_corporate_discovery("west village", client);
      expect(west_village.map((entry) => entry.target.brand_name).sort()).toEqual([
        "Blank Street Coffee",
        "Magnolia Bakery",
      ]);
      const astoria = await fetch_neighborhood_corporate_discovery("Astoria", client);
      expect(astoria).toEqual([]);
    });
  });
});
