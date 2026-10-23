import { NextRequest } from "next/server";
import { Pool, PoolClient } from "pg";
import { POST as report_handler } from "@/app/api/corrections/route";
import { LOCAL_DEV_ADMIN_EMAIL, LOCAL_DEV_ADMIN_ID, type AdminIdentity } from "@/lib/auth/admin-session";
import { validate_correction_request, validate_resolution } from "@/lib/corrections";
import { fetch_brands_for_review } from "@/lib/db/brands";
import { CorrectionChangeRejectedError, fetch_correction_requests, resolve_correction_request } from "@/lib/db/corrections";

const database_url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/trueown";
const MARKER = "ZZ correction test";

const admin: AdminIdentity = {
  actor_id: LOCAL_DEV_ADMIN_ID,
  email: LOCAL_DEV_ADMIN_EMAIL,
  mode: "local_basic",
  claims: { role: "authenticated", sub: LOCAL_DEV_ADMIN_ID, email: LOCAL_DEV_ADMIN_EMAIL, app_metadata: { role: "admin" } },
};

let pool: Pool;
let location_id: string;
let brand_name: string;
let client_counter = 0;

beforeAll(async () => {
  process.env.DATABASE_URL = database_url;
  delete process.env.TURNSTILE_SECRET_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.UPSTASH_REDIS_REST_URL;
  pool = new Pool({ connectionString: database_url, max: 2 });
  const listing = await pool.query<{ id: string; name: string }>(
    `SELECT l.id, b.name FROM locations l JOIN brands b ON b.id = l.brand_id
      WHERE b.name = 'Blank Street Coffee' ORDER BY l.address LIMIT 1`,
  );
  location_id = listing.rows[0]!.id;
  brand_name = listing.rows[0]!.name;
});
afterEach(async () => {
  await pool.query("DELETE FROM admin_audit_log WHERE payload ->> 'correction_request_id' IN (SELECT id::text FROM correction_requests WHERE details LIKE $1)", [`${MARKER}%`]);
  await pool.query("DELETE FROM correction_requests WHERE details LIKE $1", [`${MARKER}%`]);
});
afterAll(async () => {
  await pool.end();
});

function report(body: Record<string, unknown>): Promise<Response> {
  client_counter += 1;
  return report_handler(
    new NextRequest("http://localhost/api/corrections", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", "x-forwarded-for": `198.51.100.${client_counter}` },
    }),
  );
}

const valid_body = () => ({
  location_id,
  issue: "not_affiliated",
  reporter_relationship: "owner",
  details: `${MARKER}: we are family owned and never raised money.`,
  contact_email: "Owner@Example.com",
  evidence_url: "",
});

describe("report validation", () => {
  test("requires a listing, an issue, a relationship and real details", () => {
    expect(validate_correction_request(valid_body())).toMatchObject({
      valid: true,
      input: { contact_email: "owner@example.com", evidence_url: null },
    });
    for (const broken of [
      { location_id: "not-a-uuid" },
      { issue: "rude" },
      { reporter_relationship: "competitor" },
      { details: "short" },
      { contact_email: "not-an-email" },
      { evidence_url: "javascript:alert(1)" },
    ]) {
      expect(validate_correction_request({ ...valid_body(), ...broken })).toMatchObject({ valid: false });
    }
  });

  test("dismissals need a reason", () => {
    expect(validate_resolution({ outcome: "dismissed", note: " " })).toMatchObject({ valid: false });
    expect(validate_resolution({ outcome: "resolved" })).toEqual({ valid: true, outcome: "resolved", note: null });
    expect(validate_resolution({ outcome: "deleted" })).toMatchObject({ valid: false });
  });
});

describe("POST /api/corrections", () => {
  test("stores an open report against the server-side listing", async () => {
    const response = await report({ ...valid_body(), brand_name: "Forged Name" });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    const stored = await pool.query(
      "SELECT brand_name_snapshot, status, contact_email, issue FROM correction_requests WHERE id = $1",
      [id],
    );
    expect(stored.rows[0]).toEqual({
      brand_name_snapshot: brand_name,
      status: "open",
      contact_email: "owner@example.com",
      issue: "not_affiliated",
    });
  });

  test("rejects invalid input and unknown listings; the honeypot stores nothing", async () => {
    expect((await report({ ...valid_body(), details: "short" })).status).toBe(422);
    expect((await report({ ...valid_body(), location_id: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
    const bot = await report({ ...valid_body(), website: "spam" });
    expect(bot.status).toBe(201);
    const count = await pool.query("SELECT count(*)::int AS n FROM correction_requests WHERE details LIKE $1", [`${MARKER}%`]);
    expect(count.rows[0].n).toBe(0);
  });
});

/** Runs as a Supabase API role inside a rolled-back transaction. */
async function as_role<T>(role: "anon" | "authenticated", claims: object | null, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims ? JSON.stringify(claims) : ""]);
    return await run(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

describe("RLS on correction_requests", () => {
  const insert_sql = `INSERT INTO correction_requests (brand_name_snapshot, issue, details, reporter_relationship, status, resolved_at)
                      VALUES ('X', 'other', '${MARKER}: anon insert', 'customer', $1, $2)`;

  test("the public can create open reports but never read or close them", async () => {
    await as_role("anon", null, async (client) => {
      expect((await client.query(insert_sql, ["open", null])).rowCount).toBe(1);
      await client.query("SAVEPOINT s");
      await expect(client.query(insert_sql, ["resolved", new Date()])).rejects.toThrow(/row-level security/);
      await client.query("ROLLBACK TO SAVEPOINT s");
      await expect(client.query("SELECT 1 FROM correction_requests")).rejects.toThrow(/permission denied/);
    });
    await as_role("authenticated", { role: "authenticated", app_metadata: { role: "admin" }, sub: LOCAL_DEV_ADMIN_ID }, async (client) => {
      await expect(client.query("UPDATE correction_requests SET status = 'resolved'")).rejects.toThrow(/permission denied/);
    });
  });

  test("non-admins see no reports and cannot close them", async () => {
    await report(valid_body());
    await as_role("authenticated", { role: "authenticated", sub: LOCAL_DEV_ADMIN_ID }, async (client) => {
      expect((await client.query("SELECT 1 FROM correction_requests")).rowCount).toBe(0);
      const open = await pool.query<{ id: string }>("SELECT id FROM correction_requests WHERE details LIKE $1", [`${MARKER}%`]);
      await expect(client.query("SELECT resolve_correction_request($1, 'resolved', NULL)", [open.rows[0]!.id])).rejects.toThrow(/not_admin/);
    });
  });
});

describe("admin handling", () => {
  test("open reports are listed, flag the brand for review, and close with an audit entry", async () => {
    await report(valid_body());
    const open = await fetch_correction_requests(admin, "open", pool);
    const mine = open.find((request) => request.details.startsWith(MARKER));
    expect(mine).toMatchObject({ brand_name, issue: "not_affiliated", reporter_relationship: "owner", status: "open" });

    const flagged = await fetch_brands_for_review(admin, { filter: "needs_review", search: brand_name }, pool);
    expect(flagged[0]).toMatchObject({ name: brand_name, open_reports: 1 });

    await expect(resolve_correction_request(admin, mine!.id, "dismissed", null, pool)).rejects.toBeInstanceOf(
      CorrectionChangeRejectedError,
    );
    await resolve_correction_request(admin, mine!.id, "resolved", "Re-verified with the state registry", pool);
    await expect(resolve_correction_request(admin, mine!.id, "resolved", null, pool)).rejects.toMatchObject({ status: 409 });

    const closed = (await fetch_correction_requests(admin, "closed", pool)).find((request) => request.id === mine!.id);
    expect(closed).toMatchObject({
      status: "resolved",
      resolution_note: "Re-verified with the state registry",
      resolver_email: LOCAL_DEV_ADMIN_EMAIL,
    });
    const audit = await pool.query("SELECT action FROM admin_audit_log WHERE payload ->> 'correction_request_id' = $1", [mine!.id]);
    expect(audit.rows).toEqual([{ action: "resolve_correction" }]);
  });
});
