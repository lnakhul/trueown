import { Pool } from "pg";
import { LOCAL_DEV_ADMIN_EMAIL, LOCAL_DEV_ADMIN_ID, type AdminIdentity } from "@/lib/auth/admin-session";
import {
  AdminPrivilegeError,
  ApprovalRejectedError,
  BrandTierConflictError,
  approve_pending_submission,
  fetch_pending_submissions,
  fetch_recent_reviews,
  reject_pending_submission,
} from "@/lib/db/submissions";

/** The app's admin data layer, end to end: verified claims -> authenticated role -> audited routines. */
const database_url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/trueown";
const PREFIX = "ZZ Admin Flow";

const admin: AdminIdentity = {
  actor_id: LOCAL_DEV_ADMIN_ID,
  email: LOCAL_DEV_ADMIN_EMAIL,
  mode: "local_basic",
  claims: { role: "authenticated", sub: LOCAL_DEV_ADMIN_ID, email: LOCAL_DEV_ADMIN_EMAIL, app_metadata: { role: "admin" } },
};
// Claims that skip is_admin(): what a bug that forgot the role would produce.
const not_admin = { ...admin, claims: { ...admin.claims, app_metadata: {} } } as unknown as AdminIdentity;

let pool: Pool;

async function insert_tip(name: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO submissions (business_name, street_address, evidence_url)
     VALUES ($1, '7 Flow St, New York, NY', 'https://example.com/flow') RETURNING id`,
    [name],
  );
  return result.rows[0]!.id;
}

async function cleanup(): Promise<void> {
  await pool.query("DELETE FROM admin_audit_log WHERE submission_id IN (SELECT id FROM submissions WHERE business_name LIKE $1)", [`${PREFIX}%`]);
  await pool.query("DELETE FROM submissions WHERE business_name LIKE $1", [`${PREFIX}%`]);
  await pool.query("DELETE FROM brands WHERE name LIKE $1", [`${PREFIX}%`]);
}

const approval = {
  corporate_tier: 2 as const,
  parent_entity: "Flow Capital",
  industry_vertical: "coffee_bakery" as const,
  unique_selling_proposition: null,
  ownership_source_type: "crunchbase" as const,
  latitude: 40.7324,
  longitude: -74.0021,
};

beforeAll(async () => {
  pool = new Pool({ connectionString: database_url, max: 2 });
  await cleanup();
});
afterEach(cleanup);
afterAll(async () => {
  await pool.end();
});

test("pending tips are listed, approved with provenance, and show up as recently reviewed", async () => {
  const tip_id = await insert_tip(`${PREFIX} Cafe`);
  expect((await fetch_pending_submissions(admin, pool)).map((tip) => tip.id)).toContain(tip_id);

  const location_id = await approve_pending_submission(admin, tip_id, approval, pool);
  expect(location_id).toMatch(/^[0-9a-f-]{36}$/);
  expect((await fetch_pending_submissions(admin, pool)).map((tip) => tip.id)).not.toContain(tip_id);

  const reviewed = (await fetch_recent_reviews(admin, pool)).find((review) => review.id === tip_id);
  expect(reviewed).toMatchObject({
    status: "approved",
    reviewer_email: LOCAL_DEV_ADMIN_EMAIL,
    ownership_source_type: "crunchbase",
    corporate_tier: 2,
  });
});

test("rejections carry the note into the recent list", async () => {
  const tip_id = await insert_tip(`${PREFIX} Rumor`);
  await reject_pending_submission(admin, tip_id, "No source names this shop", pool);
  const reviewed = (await fetch_recent_reviews(admin, pool)).find((review) => review.id === tip_id);
  expect(reviewed).toMatchObject({ status: "rejected", review_note: "No source names this shop" });
});

test("database refusals map to domain errors", async () => {
  const tip_id = await insert_tip(`${PREFIX} Errors`);
  await expect(approve_pending_submission(not_admin, tip_id, approval, pool)).rejects.toBeInstanceOf(AdminPrivilegeError);
  await expect(reject_pending_submission(not_admin, tip_id, null, pool)).rejects.toBeInstanceOf(AdminPrivilegeError);
  await expect(
    approve_pending_submission(admin, tip_id, { ...approval, latitude: -33.8688, longitude: 151.2093 }, pool),
  ).rejects.toBeInstanceOf(ApprovalRejectedError);

  // Same name as a live Tier 3 brand in this market, approved as Tier 2: a silent tier change.
  await pool.query(
    `INSERT INTO brands (name, corporate_tier, industry_vertical, home_market_id)
     VALUES ($1, 3, 'coffee_bakery', (SELECT id FROM markets WHERE slug = 'nyc'))`,
    [`${PREFIX} Errors`],
  );
  await expect(approve_pending_submission(admin, tip_id, approval, pool)).rejects.toBeInstanceOf(BrandTierConflictError);

  // Nothing was published or decided by the failed attempts.
  const status = await pool.query("SELECT status FROM submissions WHERE id = $1", [tip_id]);
  expect(status.rows[0].status).toBe("pending");
});
