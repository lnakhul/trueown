import { NextRequest } from "next/server";
import { Pool } from "pg";
import { POST as claim_handler } from "@/app/api/claims/route";
import { LOCAL_DEV_ADMIN_EMAIL, LOCAL_DEV_ADMIN_ID, type AdminIdentity } from "@/lib/auth/admin-session";
import { validate_business_claim, validate_claim_resolution } from "@/lib/claims";
import { ClaimChangeRejectedError, fetch_business_claims, resolve_business_claim } from "@/lib/db/claims";

const database_url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/trueown";
const MARKER = "ZZ claim test";
const admin: AdminIdentity = {
  actor_id: LOCAL_DEV_ADMIN_ID,
  email: LOCAL_DEV_ADMIN_EMAIL,
  mode: "local_basic",
  claims: { role: "authenticated", sub: LOCAL_DEV_ADMIN_ID, email: LOCAL_DEV_ADMIN_EMAIL, app_metadata: { role: "admin" } },
};

let pool: Pool;
let independent_location: string;
let corporate_location: string;
let birch_brand_id: string;
let birch_provenance: { ownership_source_type: string | null; ownership_source_url: string | null; ownership_verified_on: Date | null };
let counter = 0;

beforeAll(async () => {
  process.env.DATABASE_URL = database_url;
  delete process.env.TURNSTILE_SECRET_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.UPSTASH_REDIS_REST_URL;
  pool = new Pool({ connectionString: database_url, max: 2 });
  const birch = await pool.query<{ location_id: string; brand_id: string }>(
    "SELECT l.id AS location_id, b.id AS brand_id FROM locations l JOIN brands b ON b.id = l.brand_id WHERE b.name = 'Birch Coffee' LIMIT 1",
  );
  independent_location = birch.rows[0]!.location_id;
  birch_brand_id = birch.rows[0]!.brand_id;
  birch_provenance = (
    await pool.query("SELECT ownership_source_type, ownership_source_url, ownership_verified_on FROM brands WHERE id = $1", [birch_brand_id])
  ).rows[0];
  corporate_location = (
    await pool.query<{ id: string }>("SELECT l.id FROM locations l JOIN brands b ON b.id = l.brand_id WHERE b.name = 'Magnolia Bakery' LIMIT 1")
  ).rows[0]!.id;
});
afterEach(async () => {
  await pool.query("DELETE FROM admin_audit_log WHERE payload ->> 'business_claim_id' IN (SELECT id::text FROM business_claims WHERE claimant_name LIKE $1)", [`${MARKER}%`]);
  await pool.query("DELETE FROM business_claims WHERE claimant_name LIKE $1", [`${MARKER}%`]);
  await pool.query(
    "UPDATE brands SET ownership_source_type = $2, ownership_source_url = $3, ownership_verified_on = $4 WHERE id = $1",
    [birch_brand_id, birch_provenance.ownership_source_type, birch_provenance.ownership_source_url, birch_provenance.ownership_verified_on],
  );
});
afterAll(async () => {
  await pool.end();
});

const valid_claim = (overrides: Record<string, unknown> = {}) => ({
  location_id: independent_location,
  claimant_name: `${MARKER} Owner`,
  claimant_role: "owner",
  contact_email: "Owner@BirchCoffee.com",
  contact_phone: "(212) 555-0100",
  website_url: "https://birchcoffee.com",
  attests_independent: true,
  ...overrides,
});

function post_claim(body: Record<string, unknown>): Promise<Response> {
  counter += 1;
  return claim_handler(
    new NextRequest("http://localhost/api/claims", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", "x-forwarded-for": `203.0.113.${counter}` },
    }),
  );
}

describe("claim validation", () => {
  test("requires a role, a business email, a website and the independence statement", () => {
    expect(validate_business_claim(valid_claim())).toMatchObject({ valid: true, input: { contact_email: "owner@birchcoffee.com" } });
    for (const broken of [
      { attests_independent: false },
      { claimant_role: "fan" },
      { contact_email: "nope" },
      { website_url: "javascript:alert(1)" },
      { contact_phone: "call me maybe" },
      { claimant_name: " " },
    ]) {
      expect(validate_business_claim(valid_claim(broken))).toMatchObject({ valid: false });
    }
    // An unlisted business needs its name and address.
    expect(validate_business_claim(valid_claim({ location_id: null }))).toMatchObject({ valid: false });
    expect(
      validate_business_claim(valid_claim({ location_id: null, business_name: "New Cafe", business_address: "1 Main St, Brooklyn, NY" })),
    ).toMatchObject({ valid: true });
    expect(validate_claim_resolution({ outcome: "rejected" })).toMatchObject({ valid: false });
    expect(validate_claim_resolution({ outcome: "verified", record_evidence: true })).toMatchObject({ valid: true, input: { record_evidence: true } });
  });
});

describe("POST /api/claims", () => {
  test("stores an open claim for an independent listing, using the server's name and address", async () => {
    const response = await post_claim(valid_claim({ business_name: "Forged Name" }));
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const stored = await pool.query("SELECT business_name, brand_id, status, attests_independent FROM business_claims WHERE id = $1", [id]);
    expect(stored.rows[0]).toEqual({ business_name: "Birch Coffee", brand_id: birch_brand_id, status: "open", attests_independent: true });
  });

  test("corporate listings are sent to Report an error; bots learn nothing", async () => {
    expect((await post_claim(valid_claim({ location_id: corporate_location }))).status).toBe(409);
    expect((await post_claim(valid_claim({ attests_independent: false }))).status).toBe(422);
    expect((await post_claim(valid_claim({ website: "spam" }))).status).toBe(201);
    const count = await pool.query("SELECT count(*)::int AS n FROM business_claims WHERE claimant_name LIKE $1", [`${MARKER}%`]);
    expect(count.rows[0].n).toBe(0);
  });
});

describe("claims (database)", () => {
  test("only admins can read or close claims; the public cannot pre-verify one", async () => {
    await post_claim(valid_claim());
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE anon");
      await expect(client.query("SELECT 1 FROM business_claims")).rejects.toThrow(/permission denied/);
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE anon");
      await expect(
        client.query(
          `INSERT INTO business_claims (business_name, business_address, claimant_name, claimant_role, contact_email, website_url, attests_independent, status, resolved_at)
           VALUES ('X', 'Y', '${MARKER} anon', 'owner', 'a@b.co', 'https://x.io', true, 'verified', now())`,
        ),
      ).rejects.toThrow(/row-level security/);
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE authenticated");
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: LOCAL_DEV_ADMIN_ID })]);
      expect((await client.query("SELECT 1 FROM business_claims")).rowCount).toBe(0);
      await expect(client.query("SELECT resolve_business_claim(gen_random_uuid(), 'verified', NULL, false)")).rejects.toThrow(/not_admin/);
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  test("verifying can record the owner's confirmation as the listing's evidence, audited", async () => {
    await post_claim(valid_claim());
    const open = (await fetch_business_claims(admin, "open", pool)).find((claim) => claim.claimant_name.startsWith(MARKER))!;
    expect(open).toMatchObject({ business_name: "Birch Coffee", listing_tier: 3, contact_email: "owner@birchcoffee.com" });

    await resolve_business_claim(admin, open.id, "verified", "Called the shop", true, pool);
    const brand = await pool.query("SELECT ownership_source_type, ownership_source_url, ownership_verified_on = current_date AS today FROM brands WHERE id = $1", [birch_brand_id]);
    expect(brand.rows[0]).toEqual({ ownership_source_type: "owner_attestation", ownership_source_url: "https://birchcoffee.com/", today: true });

    const closed = (await fetch_business_claims(admin, "closed", pool)).find((claim) => claim.id === open.id);
    expect(closed).toMatchObject({ status: "verified", resolver_email: LOCAL_DEV_ADMIN_EMAIL, resolution_note: "Called the shop" });
    await expect(resolve_business_claim(admin, open.id, "rejected", "x", false, pool)).rejects.toMatchObject({ status: 409 });
  });

  test("rejecting needs a reason, and an unlisted claim cannot record evidence", async () => {
    await post_claim(valid_claim({ location_id: null, business_name: "ZZ New Cafe", business_address: "1 Main St, Brooklyn, NY 11201" }));
    const open = (await fetch_business_claims(admin, "open", pool)).find((claim) => claim.claimant_name.startsWith(MARKER))!;
    expect(open.brand_id).toBeNull();
    await expect(resolve_business_claim(admin, open.id, "rejected", null, false, pool)).rejects.toBeInstanceOf(ClaimChangeRejectedError);
    await expect(resolve_business_claim(admin, open.id, "verified", null, true, pool)).rejects.toMatchObject({ status: 422 });
    await resolve_business_claim(admin, open.id, "verified", "Listed via the storefront queue", false, pool);
  });
});
