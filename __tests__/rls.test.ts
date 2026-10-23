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
    });
  });

  test("nobody can change a submission's status directly, not even an admin", async () => {
    for (const [role, claims] of [["anon", null], ["authenticated", USER_CLAIMS], ["authenticated", ADMIN_CLAIMS]] as const) {
      await within_rollback(async (client) => {
        await act_as(client, role, claims);
        await expect(client.query("UPDATE submissions SET status = 'approved'")).rejects.toThrow(/permission denied/);
      });
    }
  });
});

const ADMIN_ACTOR = "6f1c2a8e-3b7d-4c55-9a10-2f4e8d6b1a90";
const AUDITED_ADMIN_CLAIMS = { ...ADMIN_CLAIMS, sub: ADMIN_ACTOR, email: "reviewer@example.com" };
const TIP_ID = "0d3e7a52-1b9c-4f6a-8e21-7c5b9d4a3f10";

async function insert_tip(client: PoolClient, name = "Audit Test Cafe"): Promise<void> {
  await client.query(
    `INSERT INTO submissions (id, business_name, street_address, evidence_url)
     VALUES ($1, $2, '9 Audit St, New York, NY', 'https://example.com/acquisition')`,
    [TIP_ID, name],
  );
}

const APPROVE_SQL = `SELECT approve_submission($1, $2, $3, 'coffee_bakery', NULL, $4, 40.7324, -74.0021) AS location_id`;

/** Expects a statement to fail without aborting the surrounding test transaction. */
async function expect_rejection(client: PoolClient, sql: string, params: unknown[], pattern: RegExp): Promise<void> {
  await client.query("SAVEPOINT expected_failure");
  await expect(client.query(sql, params)).rejects.toThrow(pattern);
  await client.query("ROLLBACK TO SAVEPOINT expected_failure");
}

describe("audited vetting routines", () => {
  test("anon cannot call them at all", async () => {
    await within_rollback(async (client) => {
      await insert_tip(client);
      await act_as(client, "anon");
      await expect(client.query(APPROVE_SQL, [TIP_ID, 2, "Acme", "crunchbase"])).rejects.toThrow(/permission denied/);
    });
    await within_rollback(async (client) => {
      await insert_tip(client);
      await act_as(client, "anon");
      await expect(client.query("SELECT reject_submission($1, NULL)", [TIP_ID])).rejects.toThrow(/permission denied/);
    });
  });

  test("non-admins, forged admins and admin claims without a subject are refused", async () => {
    for (const claims of [USER_CLAIMS, FORGED_CLAIMS, ADMIN_CLAIMS]) {
      await within_rollback(async (client) => {
        await insert_tip(client);
        await act_as(client, "authenticated", claims);
        await expect(client.query(APPROVE_SQL, [TIP_ID, 2, "Acme", "crunchbase"])).rejects.toThrow(/not_admin/);
      });
      await within_rollback(async (client) => {
        await insert_tip(client);
        await act_as(client, "authenticated", claims);
        await expect(client.query("SELECT reject_submission($1, 'x')", [TIP_ID])).rejects.toThrow(/not_admin/);
      });
    }
  });

  test("an admin approval publishes with provenance, records the reviewer and is audited", async () => {
    await within_rollback(async (client) => {
      await insert_tip(client);
      await act_as(client, "authenticated", AUDITED_ADMIN_CLAIMS);
      const approved = await client.query<{ location_id: string }>(APPROVE_SQL, [TIP_ID, 2, "Acme Capital", "crunchbase"]);
      expect(approved.rows[0]?.location_id).toBeTruthy();

      const submission = await client.query("SELECT status, reviewed_by FROM submissions WHERE id = $1", [TIP_ID]);
      expect(submission.rows[0]).toEqual({ status: "approved", reviewed_by: ADMIN_ACTOR });

      const brand = await client.query(
        `SELECT b.ownership_source_type, b.ownership_source_url, b.ownership_verified_on IS NOT NULL AS dated, l.city
           FROM brands b JOIN locations l ON l.brand_id = b.id WHERE l.id = $1`,
        [approved.rows[0]!.location_id],
      );
      expect(brand.rows[0]).toEqual({
        ownership_source_type: "crunchbase",
        ownership_source_url: "https://example.com/acquisition",
        dated: true,
        city: "New York",
      });

      const audit = await client.query("SELECT actor_id, actor_email, action, payload FROM admin_audit_log WHERE submission_id = $1", [TIP_ID]);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({
        actor_id: ADMIN_ACTOR,
        actor_email: "reviewer@example.com",
        action: "approve",
        payload: { corporate_tier: 2, ownership_source_type: "crunchbase", evidence_url: "https://example.com/acquisition" },
      });
    });
  });

  test("a source type that does not fit the tier is refused", async () => {
    for (const [tier, parent, source_type] of [
      [1, "Acme", "community_consensus"],
      [3, null, "sec_edgar"],
      [2, "Acme", null],
    ] as const) {
      await within_rollback(async (client) => {
        await insert_tip(client);
        await act_as(client, "authenticated", AUDITED_ADMIN_CLAIMS);
        await expect(client.query(APPROVE_SQL, [TIP_ID, tier, parent, source_type])).rejects.toThrow(/invalid_source_type/);
      });
    }
  });

  test("a rejection keeps the note and reviewer, and a decided tip cannot be decided again", async () => {
    await within_rollback(async (client) => {
      await insert_tip(client);
      await act_as(client, "authenticated", AUDITED_ADMIN_CLAIMS);
      await client.query("SELECT reject_submission($1, '  Source names another location ')", [TIP_ID]);
      const submission = await client.query("SELECT status, reviewed_by, review_note FROM submissions WHERE id = $1", [TIP_ID]);
      expect(submission.rows[0]).toEqual({
        status: "rejected",
        reviewed_by: ADMIN_ACTOR,
        review_note: "Source names another location",
      });
      await expect_rejection(client, "SELECT reject_submission($1, NULL)", [TIP_ID], /submission_not_pending/);
      await expect_rejection(client, APPROVE_SQL, [TIP_ID, 2, "Acme", "crunchbase"], /submission_not_pending/);
    });
  });

  test("only admins can read the audit log, and nobody can write it directly", async () => {
    await within_rollback(async (client) => {
      await insert_tip(client);
      await act_as(client, "authenticated", AUDITED_ADMIN_CLAIMS);
      await client.query("SELECT reject_submission($1, NULL)", [TIP_ID]);
      expect((await client.query("SELECT 1 FROM admin_audit_log")).rowCount).toBeGreaterThan(0);
      await expect_rejection(client, "INSERT INTO admin_audit_log (actor_id, action) VALUES ($1, 'approve')", [ADMIN_ACTOR], /permission denied/);
      await expect_rejection(client, "DELETE FROM admin_audit_log", [], /permission denied/);

      await act_as(client, "authenticated", USER_CLAIMS);
      expect((await client.query("SELECT 1 FROM admin_audit_log")).rowCount).toBe(0);
      await act_as(client, "anon");
      await expect(client.query("SELECT 1 FROM admin_audit_log")).rejects.toThrow(/permission denied/);
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
