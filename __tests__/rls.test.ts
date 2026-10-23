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

  test("no API role can write brands or storefronts directly, admins included", async () => {
    for (const claims of [USER_CLAIMS, FORGED_CLAIMS, ADMIN_CLAIMS]) {
      for (const statement of [
        NEW_BRAND_SQL,
        "UPDATE brands SET name = name",
        "DELETE FROM brands",
        "UPDATE locations SET address = address",
        "DELETE FROM locations",
      ]) {
        await within_rollback(async (client) => {
          await act_as(client, "authenticated", claims);
          await expect(client.query(statement)).rejects.toThrow(/permission denied/);
        });
      }
    }
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

describe("SECURITY DEFINER routines", () => {
  // On Supabase PostGIS lives in the `extensions` schema. A definer routine that pins
  // search_path without it fails there ("type geometry does not exist") while passing
  // locally, where PostGIS sits in `public`.
  test("every pinned search_path includes the extensions schema", async () => {
    const result = await test_pool.query<{ name: string; config: string[] | null }>(
      `SELECT p.oid::regprocedure::text AS name, p.proconfig AS config
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef`,
    );
    expect(result.rows.length).toBeGreaterThan(0);
    for (const routine of result.rows) {
      const search_path = (routine.config ?? []).find((setting) => setting.startsWith("search_path="));
      expect({ routine: routine.name, search_path }).toEqual({
        routine: routine.name,
        search_path: expect.stringMatching(/^search_path=.*\bextensions\b/),
      });
    }
  });
});

/* ------------------------------------------------------------------------- */
/* Brand re-verification and corrections                                      */
/* ------------------------------------------------------------------------- */

const BRAND_ID = "5b0d8a1e-7c2f-4e93-a6d1-3f8e2c9b7a40";
const REVERIFY_SQL = "SELECT reverify_brand($1, $2, $3)";
const CORRECT_SQL = "SELECT correct_brand($1, $2, $3, $4, $5, $6, $7)";

/** A Tier 2 brand with one NYC storefront and no recorded source (inserted as the table owner). */
async function insert_brand(client: PoolClient, name = "Audit Brand Coffee"): Promise<void> {
  await client.query(
    `INSERT INTO brands (id, name, corporate_tier, industry_vertical, parent_entity)
     VALUES ($1, $2, 2, 'coffee_bakery', 'Old Capital')`,
    [BRAND_ID, name],
  );
  await client.query(
    `INSERT INTO locations (brand_id, address, coordinates)
     VALUES ($1, '3 Audit St, New York, NY', ST_SetSRID(ST_MakePoint(-74.0021, 40.7324), 4326))`,
    [BRAND_ID],
  );
}

describe("audited brand routines", () => {
  test("anon cannot call them; non-admins and forged admins are refused", async () => {
    await within_rollback(async (client) => {
      await insert_brand(client);
      await act_as(client, "anon");
      await expect_rejection(client, REVERIFY_SQL, [BRAND_ID, "crunchbase", "https://example.com/a"], /permission denied/);
      await expect_rejection(
        client,
        CORRECT_SQL,
        [BRAND_ID, 1, "New Capital", [], "sec_edgar", "https://example.com/b", "why"],
        /permission denied/,
      );
      for (const claims of [USER_CLAIMS, FORGED_CLAIMS, ADMIN_CLAIMS]) {
        await act_as(client, "authenticated", claims);
        await expect_rejection(client, REVERIFY_SQL, [BRAND_ID, "crunchbase", "https://example.com/a"], /not_admin/);
        await expect_rejection(
          client,
          CORRECT_SQL,
          [BRAND_ID, 1, "New Capital", [], "sec_edgar", "https://example.com/b", "why"],
          /not_admin/,
        );
      }
    });
  });

  test("re-verification records fresh evidence, keeps the claim and is audited", async () => {
    await within_rollback(async (client) => {
      await insert_brand(client);
      await act_as(client, "authenticated", AUDITED_ADMIN_CLAIMS);
      await expect_rejection(client, REVERIFY_SQL, [BRAND_ID, "community_consensus", "https://example.com/a"], /invalid_source_type/);
      await client.query(REVERIFY_SQL, [BRAND_ID, "crunchbase", " https://www.crunchbase.com/organization/audit "]);

      const brand = await client.query(
        `SELECT corporate_tier, parent_entity, ownership_source_type, ownership_source_url,
                ownership_verified_on = current_date AS verified_today
           FROM brands WHERE id = $1`,
        [BRAND_ID],
      );
      expect(brand.rows[0]).toEqual({
        corporate_tier: 2,
        parent_entity: "Old Capital",
        ownership_source_type: "crunchbase",
        ownership_source_url: "https://www.crunchbase.com/organization/audit",
        verified_today: true,
      });
      const audit = await client.query("SELECT action, actor_id, payload FROM admin_audit_log WHERE brand_id = $1", [BRAND_ID]);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({
        action: "reverify",
        actor_id: ADMIN_ACTOR,
        payload: { previous_source_url: null, ownership_source_type: "crunchbase" },
      });
    });
  });

  test("a correction changes the claim with new evidence and a reason, keeping before/after in the log", async () => {
    await within_rollback(async (client) => {
      await insert_brand(client);
      await act_as(client, "authenticated", AUDITED_ADMIN_CLAIMS);
      await expect_rejection(
        client,
        CORRECT_SQL,
        [BRAND_ID, 1, "New Capital", [], "sec_edgar", "https://example.com/b", "  "],
        /note_required/,
      );
      await expect_rejection(
        client,
        CORRECT_SQL,
        [BRAND_ID, 1, " ", [], "sec_edgar", "https://example.com/b", "PE buyout"],
        /parent_required/,
      );
      await client.query(CORRECT_SQL, [
        BRAND_ID,
        1,
        "New Capital",
        ["Fund A", "Fund B"],
        "sec_edgar",
        "https://www.sec.gov/example",
        "Acquired by New Capital",
      ]);
      const brand = await client.query(
        "SELECT corporate_tier, parent_entity, financial_backers, ownership_source_type, home_market_id FROM brands WHERE id = $1",
        [BRAND_ID],
      );
      expect(brand.rows[0]).toEqual({
        corporate_tier: 1,
        parent_entity: "New Capital",
        financial_backers: ["Fund A", "Fund B"],
        ownership_source_type: "sec_edgar",
        home_market_id: null,
      });
      const audit = await client.query("SELECT payload FROM admin_audit_log WHERE brand_id = $1 AND action = 'correct'", [BRAND_ID]);
      expect(audit.rows[0].payload).toMatchObject({
        review_note: "Acquired by New Capital",
        before: { corporate_tier: 2, parent_entity: "Old Capital" },
        after: { corporate_tier: 1, parent_entity: "New Capital" },
      });
    });
  });

  test("becoming independent clears the parent and backers and sets the home market", async () => {
    await within_rollback(async (client) => {
      await insert_brand(client);
      await act_as(client, "authenticated", AUDITED_ADMIN_CLAIMS);
      await client.query(CORRECT_SQL, [
        BRAND_ID,
        3,
        "Ignored Parent",
        ["Ignored Fund"],
        "state_business_registry",
        "https://apps.dos.ny.gov/publicInquiry/",
        "Founders bought the company back",
      ]);
      const brand = await client.query(
        `SELECT b.corporate_tier, b.parent_entity, b.financial_backers, m.slug
           FROM brands b LEFT JOIN markets m ON m.id = b.home_market_id WHERE b.id = $1`,
        [BRAND_ID],
      );
      expect(brand.rows[0]).toEqual({ corporate_tier: 3, parent_entity: null, financial_backers: [], slug: "nyc" });
    });
  });

  test("a brand trading in two markets cannot become a local independent", async () => {
    await within_rollback(async (client) => {
      await insert_brand(client);
      await client.query(
        `INSERT INTO locations (brand_id, address, coordinates)
         VALUES ($1, '1 Congress Ave, Austin, TX', ST_SetSRID(ST_MakePoint(-97.7431, 30.2672), 4326))`,
        [BRAND_ID],
      );
      await act_as(client, "authenticated", AUDITED_ADMIN_CLAIMS);
      await expect_rejection(
        client,
        CORRECT_SQL,
        [BRAND_ID, 3, null, [], "local_press", "https://example.com/c", "Went independent"],
        /independent_spans_markets/,
      );
    });
  });

  test("a correction cannot contradict another brand with the same name", async () => {
    await within_rollback(async (client) => {
      await insert_brand(client, "Birch Coffee");
      await act_as(client, "authenticated", AUDITED_ADMIN_CLAIMS);
      // A live Tier 3 "Birch Coffee" already trades in NYC (seed data).
      await expect_rejection(
        client,
        CORRECT_SQL,
        [BRAND_ID, 1, "Some Capital", [], "sec_edgar", "https://example.com/d", "Buyout"],
        /brand_tier_conflict/,
      );
    });
  });
});
