import { Pool } from "pg";
import { LOCAL_DEV_ADMIN_EMAIL, LOCAL_DEV_ADMIN_ID, type AdminIdentity } from "@/lib/auth/admin-session";
import {
  BrandChangeRejectedError,
  BrandNotFoundError,
  correct_brand_claim,
  fetch_brands_for_review,
  reverify_brand_claim,
} from "@/lib/db/brands";
import { fetch_corporate_location_by_address } from "@/lib/db/proximity";

/** The admin brand-review data layer end to end, plus the public source on the proximity record. */
const database_url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/trueown";
const NAME = "ZZ Review Coffee";
const ADDRESS = "77 Review St, New York, NY";

const admin: AdminIdentity = {
  actor_id: LOCAL_DEV_ADMIN_ID,
  email: LOCAL_DEV_ADMIN_EMAIL,
  mode: "local_basic",
  claims: { role: "authenticated", sub: LOCAL_DEV_ADMIN_ID, email: LOCAL_DEV_ADMIN_EMAIL, app_metadata: { role: "admin" } },
};

let pool: Pool;
let brand_id: string;

beforeAll(async () => {
  pool = new Pool({ connectionString: database_url, max: 2 });
});
beforeEach(async () => {
  await cleanup();
  const brand = await pool.query<{ id: string }>(
    `INSERT INTO brands (name, corporate_tier, industry_vertical, parent_entity, ownership_source_type, ownership_source_url, ownership_verified_on)
     VALUES ($1, 2, 'coffee_bakery', 'Review Capital', 'crunchbase', 'https://example.com/old', current_date - 500)
     RETURNING id`,
    [NAME],
  );
  brand_id = brand.rows[0]!.id;
  await pool.query(
    `INSERT INTO locations (brand_id, address, coordinates) VALUES ($1, $2, ST_SetSRID(ST_MakePoint(-74.0021, 40.7324), 4326))`,
    [brand_id, ADDRESS],
  );
});
afterAll(async () => {
  await cleanup();
  await pool.end();
});

async function cleanup(): Promise<void> {
  await pool.query("DELETE FROM admin_audit_log WHERE brand_id IN (SELECT id FROM brands WHERE name = $1)", [NAME]);
  await pool.query("DELETE FROM brands WHERE name = $1", [NAME]);
}

test("a stale claim is listed for review, shown publicly as stale, and leaves the list once re-verified", async () => {
  const needs_review = await fetch_brands_for_review(admin, { filter: "needs_review", search: "zz review" }, pool);
  expect(needs_review.map((brand) => brand.name)).toEqual([NAME]);
  expect(needs_review[0]).toMatchObject({
    corporate_tier: 2,
    storefront_count: 1,
    market_names: ["New York City"],
    source: { source_type: "crunchbase", source_url: "https://example.com/old" },
  });

  const before = await fetch_corporate_location_by_address(ADDRESS, pool);
  expect(before?.ownership_source).toMatchObject({ source_type: "crunchbase", source_url: "https://example.com/old" });

  await reverify_brand_claim(
    admin,
    brand_id,
    { ownership_source_type: "pitchbook", ownership_source_url: "https://pitchbook.com/profiles/review" },
    pool,
  );

  expect(await fetch_brands_for_review(admin, { filter: "needs_review", search: "zz review" }, pool)).toEqual([]);
  const all = await fetch_brands_for_review(admin, { filter: "all", search: "zz review" }, pool);
  expect(all[0]?.last_action).toMatchObject({ action: "reverify", actor_email: LOCAL_DEV_ADMIN_EMAIL });

  const after = await fetch_corporate_location_by_address(ADDRESS, pool);
  expect(after?.ownership_source).toMatchObject({
    source_type: "pitchbook",
    source_url: "https://pitchbook.com/profiles/review",
    verified_on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
  });
});

test("a correction updates what the public sees", async () => {
  await correct_brand_claim(
    admin,
    brand_id,
    {
      corporate_tier: 1,
      parent_entity: "Buyout Partners",
      financial_backers: ["Buyout Fund III"],
      ownership_source_type: "investor_press_release",
      ownership_source_url: "https://example.com/press",
      review_note: "Majority stake sold",
    },
    pool,
  );
  const record = await fetch_corporate_location_by_address(ADDRESS, pool);
  expect(record).toMatchObject({
    corporate_tier: 1,
    parent_entity: "Buyout Partners",
    financial_backers: ["Buyout Fund III"],
    ownership_source: { source_type: "investor_press_release" },
  });
});

test("database refusals map to domain errors", async () => {
  await expect(
    reverify_brand_claim(admin, "00000000-0000-4000-8000-000000000000", { ownership_source_type: "crunchbase", ownership_source_url: "https://x.io" }, pool),
  ).rejects.toBeInstanceOf(BrandNotFoundError);
  await expect(
    reverify_brand_claim(admin, brand_id, { ownership_source_type: "local_press", ownership_source_url: "https://x.io" }, pool),
  ).rejects.toMatchObject({ status: 422 });
  const not_admin = { ...admin, claims: { ...admin.claims, app_metadata: {} } } as unknown as AdminIdentity;
  await expect(
    reverify_brand_claim(not_admin, brand_id, { ownership_source_type: "crunchbase", ownership_source_url: "https://x.io" }, pool),
  ).rejects.toBeInstanceOf(BrandChangeRejectedError);
});
