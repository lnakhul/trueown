import { Pool } from "pg";
import { LOCAL_DEV_ADMIN_EMAIL, LOCAL_DEV_ADMIN_ID, type AdminIdentity } from "@/lib/auth/admin-session";
import { AlertNotOpenError, fetch_ownership_alerts, resolve_ownership_alert } from "@/lib/db/alerts";
import { BrandChangeRejectedError } from "@/lib/db/brands";
import {
  GDELT_MIN_INTERVAL_MS,
  build_gdelt_url,
  build_sec_url,
  classify_headline,
  fetch_brands_to_watch,
  fetch_news_alerts,
  mentions_brand,
  parse_gdelt_articles,
  parse_sec_hits,
  reset_gdelt_pacing,
  save_watch_results,
  search_phrase,
  sec_filing_url,
  type AlertCandidate,
  type WatchedBrand,
} from "@/lib/import/ownership-watch";
import { validate_alert_resolution } from "@/lib/ownership-alerts";

const independent: WatchedBrand = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "Porto Rico Importing Co.",
  corporate_tier: 3,
  parent_entity: null,
  financial_backers: [],
  checked_at: null,
};
const vc_brand: WatchedBrand = { ...independent, name: "Blank Street Coffee", corporate_tier: 2, parent_entity: "Blank Street Inc." };
const pe_brand: WatchedBrand = { ...independent, name: "Magnolia Bakery", corporate_tier: 1, parent_entity: "Turner Image Capital" };
const one_word: WatchedBrand = { ...independent, name: "Maman", corporate_tier: 2, parent_entity: "Maman Group" };

describe("headline matching", () => {
  test("the brand must be named as whole words; legal suffixes are optional", () => {
    expect(mentions_brand("Porto Rico Importing acquired by Example Capital", independent.name)).toBe(true);
    expect(mentions_brand("Blank Street raises $105 million", "Blank Street")).toBe(true);
    expect(mentions_brand("Blank Streets are empty", "Blank Street")).toBe(false);
    expect(mentions_brand("Magnolia Bakery’s new owner", "Magnolia Bakery")).toBe(true);
  });

  test("news often drops a generic last word; a one-word short name needs context", () => {
    expect(mentions_brand("Blank Street raises $105 million", "Blank Street Coffee")).toBe(true);
    expect(mentions_brand("Magnolia sold to new investors", "Magnolia Bakery")).toBe(false);
    expect(mentions_brand("Bakery chain Magnolia sold to new investors", "Magnolia Bakery")).toBe(true);
    expect(search_phrase("Blank Street Coffee")).toBe("blank street");
    expect(search_phrase("Magnolia Bakery")).toBe("magnolia bakery");
  });

  test("a one-word name needs a business word next to it", () => {
    expect(mentions_brand("Maman means mother", "Maman")).toBe(false);
    expect(mentions_brand("Bakery chain Maman sold to investors", "Maman")).toBe(true);
  });

  test("an independent being bought scores highest", () => {
    const result = classify_headline("Porto Rico Importing Co. acquired by Example Capital", independent);
    expect(result).toMatchObject({ signal: "acquisition" });
    expect(result!.score).toBeGreaterThanOrEqual(80);
    expect(result!.matched_terms).toContain("acquired");
  });

  test("more funding for a brand already listed as VC-funded is a weaker lead", () => {
    const vc = classify_headline("Coffee chain Blank Street raises $105 million", vc_brand)!;
    const indie = classify_headline("Porto Rico Importing raises $5 million from investors", independent)!;
    expect(vc.signal).toBe("investment");
    expect(vc.score).toBeLessThan(indie.score);
    expect(vc.matched_terms).not.toContain("names current owner"); // "Blank Street Inc." is the brand's own company
  });

  test("naming the current owner suggests the change is already listed", () => {
    const old_news = classify_headline("Turner Image Capital acquires Magnolia Bakery", pe_brand)!;
    const new_deal = classify_headline("Blackstone to buy Magnolia Bakery", pe_brand)!;
    expect(old_news.matched_terms).toContain("names current owner");
    expect(old_news.score).toBeLessThan(new_deal.score);
  });

  test("IPOs, and no signal or no brand means no alert", () => {
    expect(classify_headline("Blank Street Coffee files to go public", vc_brand)?.signal).toBe("public_offering");
    expect(classify_headline("Blank Street Coffee opens in Liverpool", vc_brand)).toBeNull();
    expect(classify_headline("Rival coffee chain acquired", vc_brand)).toBeNull();
    expect(classify_headline("Maman acquired", one_word)).toBeNull();
  });
});

describe("GDELT", () => {
  test("query names the brand phrase and deal words, within the window", () => {
    const url = new URL(build_gdelt_url(independent, new Date("2026-08-01T00:00:00Z"), new Date("2026-10-24T12:00:00Z")));
    expect(url.searchParams.get("query")).toMatch(/^"porto rico importing" \(acquired OR /);
    expect(url.searchParams.get("startdatetime")).toBe("20260801000000");
    expect(url.searchParams.get("enddatetime")).toBe("20261024120000");
  });

  test("articles become alerts only when the headline qualifies", () => {
    const alerts = parse_gdelt_articles(
      {
        articles: [
          { url: "https://news.example.com/a", title: "Porto Rico Importing Co. acquired by Example Capital", seendate: "20261020T093000Z", domain: "news.example.com" },
          { url: "https://news.example.com/b", title: "Huge American brand opening in Liverpool", seendate: "20261018T093000Z", domain: "x.com" },
          { url: "http://insecure.example.com/c", title: "Porto Rico Importing Co. acquired", seendate: "20261018T093000Z" },
          { url: "https://news.example.com/d", title: 42 },
        ],
      },
      independent,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ source: "gdelt_news", publisher: "news.example.com", signal: "acquisition" });
    expect(alerts[0]!.published_at?.toISOString()).toBe("2026-10-20T09:30:00.000Z");
    expect(parse_gdelt_articles(null, independent)).toEqual([]);
  });

  test("waits between requests and backs off when GDELT throttles or is slow to connect", async () => {
    reset_gdelt_pacing();
    const sleeps: number[] = [];
    const responses: Array<() => Promise<{ status: number; text: string }>> = [
      async () => ({ status: 200, text: "Please limit requests to one every 5 seconds" }),
      async () => {
        throw new Error("Timed out after 45s.");
      },
      async () => ({
        status: 200,
        text: JSON.stringify({ articles: [{ url: "https://n.example.com/x", title: "Porto Rico Importing Co. acquired", seendate: "20261020T000000Z" }] }),
      }),
      async () => ({ status: 200, text: "" }),
      async () => ({ status: 500, text: "Server error" }),
    ];
    const http_get = jest.fn(async () => responses.shift()!());
    const options = { user_agent: "test (a@b.co)", http_get, sleep: async (ms: number) => void sleeps.push(ms) };
    expect(await fetch_news_alerts(independent, options)).toHaveLength(1);
    expect(sleeps.filter((ms) => ms >= 30_000)).toEqual([30_000, 90_000]); // throttled, then a timeout
    expect(await fetch_news_alerts(independent, options)).toEqual([]); // empty body = no articles
    expect(sleeps.at(-1)).toBeGreaterThan(GDELT_MIN_INTERVAL_MS - 1000);
    await expect(fetch_news_alerts(independent, options)).rejects.toThrow(/GDELT 500/); // real errors are not retried
    expect(http_get.mock.calls[0]).toEqual([expect.stringContaining("api.gdeltproject.org"), "test (a@b.co)"]);
  });

  test("gives up after two retries", async () => {
    reset_gdelt_pacing();
    const http_get = jest.fn(async () => ({ status: 429, text: "" }));
    await expect(fetch_news_alerts(independent, { user_agent: "t (a@b.co)", http_get, sleep: async () => undefined })).rejects.toThrow(/rate limited/);
    expect(http_get).toHaveBeenCalledTimes(3);
  });
});

describe("SEC EDGAR", () => {
  const hit = (form: string, name: string, accession = "0001013594-24-000154") => ({
    _id: `${accession}:primary_doc.xml`,
    _source: { ciks: ["0001815159"], display_names: [`${name}  (CIK 0001815159)`], form, file_date: "2024-05-01", adsh: accession },
  });

  test("filing links point at the public index page", () => {
    expect(sec_filing_url("0001815159", "0001013594-20-000624")).toBe(
      "https://www.sec.gov/Archives/edgar/data/1815159/000101359420000624/0001013594-20-000624-index.htm",
    );
    expect(new URL(build_sec_url(vc_brand, new Date("2025-10-24T00:00:00Z"), new Date("2026-10-24T00:00:00Z"))).searchParams.get("q")).toBe(
      '"blank street"',
    );
  });

  test("the brand's own Form D is an investment lead; others' fundraises are ignored", () => {
    const alerts = parse_sec_hits({ hits: { hits: [hit("D", "Blank Street Inc."), hit("D", "Some Other Fund LP", "0000000001-24-000001")] } }, {
      ...vc_brand,
      name: "Blank Street",
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ source: "sec_edgar", signal: "investment", publisher: "SEC EDGAR" });
    expect(alerts[0]!.title).toBe("Form D (private fundraise) filed by Blank Street Inc.");
  });

  test("someone else's merger filing counts only for multi-word brand names", () => {
    const merger = { hits: { hits: [hit("425", "Big Food Corp", "0000000002-26-000002")] } };
    expect(parse_sec_hits(merger, pe_brand)[0]).toMatchObject({ signal: "acquisition" });
    expect(parse_sec_hits(merger, one_word)).toEqual([]);
    expect(parse_sec_hits({ hits: { hits: [hit("10-K", "Magnolia Bakery LLC")] } }, pe_brand)).toEqual([]);
  });
});

describe("resolution validation", () => {
  test("dismiss needs a reason; correct and reverify reuse the brand checks", () => {
    expect(validate_alert_resolution({ action: "dismiss", note: "  " }).valid).toBe(false);
    expect(validate_alert_resolution({ action: "dismiss", note: "Not about this brand" }).valid).toBe(true);
    expect(validate_alert_resolution({ action: "reverify", ownership_source_type: "sec_edgar", ownership_source_url: "ftp://x" }).valid).toBe(false);
    expect(
      validate_alert_resolution({
        action: "correct",
        corporate_tier: 1,
        parent_entity: "",
        ownership_source_type: "reputable_news",
        ownership_source_url: "https://news.example.com/a",
        review_note: "x",
      }).valid,
    ).toBe(false);
    expect(validate_alert_resolution({ action: "delete" }).valid).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Database                                                                    */
/* -------------------------------------------------------------------------- */

const database_url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/trueown";
const NAME = "Qw Alert Roasters";
const admin: AdminIdentity = {
  actor_id: LOCAL_DEV_ADMIN_ID,
  email: LOCAL_DEV_ADMIN_EMAIL,
  mode: "local_basic",
  claims: { role: "authenticated", sub: LOCAL_DEV_ADMIN_ID, email: LOCAL_DEV_ADMIN_EMAIL, app_metadata: { role: "admin" } },
};
let pool: Pool;
let brand_id: string;

const candidate = (overrides: Partial<AlertCandidate> = {}): AlertCandidate => ({
  source: "gdelt_news",
  url: "https://news.example.com/qw-acquired",
  title: `${NAME} acquired by Example Capital`,
  publisher: "news.example.com",
  published_at: new Date("2026-10-20T00:00:00Z"),
  signal: "acquisition",
  matched_terms: ["acquired"],
  score: 85,
  ...overrides,
});

async function open_alert_ids(): Promise<string[]> {
  return (await pool.query<{ id: string }>("SELECT id FROM ownership_alerts WHERE brand_id = $1 AND status = 'open' ORDER BY score DESC", [brand_id])).rows.map(
    (row) => row.id,
  );
}

beforeAll(async () => {
  process.env.DATABASE_URL = database_url;
  pool = new Pool({ connectionString: database_url, max: 2 });
  await pool.query("DELETE FROM brands WHERE name = $1", [NAME]);
  brand_id = (
    await pool.query<{ id: string }>(
      `INSERT INTO brands (name, corporate_tier, industry_vertical, ownership_source_type, ownership_source_url, ownership_verified_on)
       VALUES ($1, 3, 'coffee_bakery', 'local_press', 'https://press.example.com/qw', current_date) RETURNING id`,
      [NAME],
    )
  ).rows[0]!.id;
  await pool.query(`INSERT INTO locations (brand_id, address, coordinates) VALUES ($1, '9 Qw St, New York, NY', ST_SetSRID(ST_MakePoint(-74.0, 40.73), 4326))`, [
    brand_id,
  ]);
});

afterAll(async () => {
  await pool.query("DELETE FROM admin_audit_log WHERE brand_id = $1", [brand_id]);
  await pool.query("DELETE FROM brands WHERE id = $1", [brand_id]);
  await pool.end();
});

describe("ownership alerts (database)", () => {
  test("the watcher picks brands on the map, least recently checked first, and skips recent ones", async () => {
    const named = await fetch_brands_to_watch(pool, { recheck_after_days: 6, limit: null, name: NAME });
    expect(named).toEqual([expect.objectContaining({ id: brand_id, corporate_tier: 3, checked_at: null })]);
    await save_watch_results(pool, brand_id, []);
    const due = await fetch_brands_to_watch(pool, { recheck_after_days: 6, limit: null, name: null });
    expect(due.map((brand) => brand.id)).not.toContain(brand_id);
    const all = await fetch_brands_to_watch(pool, { recheck_after_days: 0, limit: null, name: null });
    expect(all.map((brand) => brand.id)).toContain(brand_id);
  });

  test("the same story is saved once, by URL or by title", async () => {
    expect(await save_watch_results(pool, brand_id, [candidate()])).toBe(1);
    expect(await save_watch_results(pool, brand_id, [candidate()])).toBe(0);
    expect(await save_watch_results(pool, brand_id, [candidate({ url: "https://syndicated.example.com/copy" })])).toBe(0);
    expect(
      await save_watch_results(pool, brand_id, [
        candidate({ url: "https://news.example.com/qw-funding", title: `${NAME} raises seed round`, signal: "investment", score: 70 }),
      ]),
    ).toBe(1);
  });

  test("only admins can read alerts", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE anon");
      await expect(client.query("SELECT 1 FROM ownership_alerts")).rejects.toThrow(/permission denied/);
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE authenticated");
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: LOCAL_DEV_ADMIN_ID })]);
      expect((await client.query("SELECT 1 FROM ownership_alerts")).rowCount).toBe(0);
      await expect(client.query("SELECT resolve_ownership_alert(gen_random_uuid(), 'dismissed', 'x')")).rejects.toThrow(/not_admin/);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    const groups = await fetch_ownership_alerts(admin, "open", pool);
    const group = groups.find((entry) => entry.brand_id === brand_id);
    expect(group?.alerts.map((alert) => alert.score)).toEqual([85, 70]);
    expect(group).toMatchObject({ corporate_tier: 3, storefront_count: 1 });
  });

  test("dismissing needs a reason and is audited; a closed alert cannot be closed again", async () => {
    const [, funding] = await open_alert_ids();
    await expect(resolve_ownership_alert(admin, funding!, { action: "dismiss", note: " " }, pool)).rejects.toBeInstanceOf(BrandChangeRejectedError);
    await resolve_ownership_alert(admin, funding!, { action: "dismiss", note: "Not an ownership change" }, pool);
    await expect(resolve_ownership_alert(admin, funding!, { action: "dismiss", note: "again" }, pool)).rejects.toBeInstanceOf(AlertNotOpenError);
    const audit = await pool.query("SELECT action, actor_email FROM admin_audit_log WHERE payload ->> 'ownership_alert_id' = $1", [funding]);
    expect(audit.rows).toEqual([{ action: "dismiss_alert", actor_email: LOCAL_DEV_ADMIN_EMAIL }]);
    // A dismissed story never comes back on the next run.
    expect(await save_watch_results(pool, brand_id, [candidate({ url: "https://news.example.com/qw-funding", title: `${NAME} raises seed round` })])).toBe(0);
  });

  test("updating the listing from an alert corrects the brand and closes the alert together", async () => {
    const [acquired] = await open_alert_ids();
    // A bad correction leaves both the brand and the alert untouched.
    await expect(
      resolve_ownership_alert(
        admin,
        acquired!,
        {
          action: "correct",
          input: {
            corporate_tier: 1,
            parent_entity: "Example Capital",
            financial_backers: [],
            ownership_source_type: "local_press",
            ownership_source_url: "https://news.example.com/qw-acquired",
            review_note: "Acquired",
          },
        },
        pool,
      ),
    ).rejects.toBeInstanceOf(BrandChangeRejectedError);
    expect(await open_alert_ids()).toContain(acquired);

    await resolve_ownership_alert(
      admin,
      acquired!,
      {
        action: "correct",
        input: {
          corporate_tier: 1,
          parent_entity: "Example Capital",
          financial_backers: ["Example Capital Fund II"],
          ownership_source_type: "reputable_news",
          ownership_source_url: "https://news.example.com/qw-acquired",
          review_note: "Acquired by Example Capital",
        },
      },
      pool,
    );
    const brand = await pool.query("SELECT corporate_tier, parent_entity, ownership_source_url FROM brands WHERE id = $1", [brand_id]);
    expect(brand.rows[0]).toEqual({ corporate_tier: 1, parent_entity: "Example Capital", ownership_source_url: "https://news.example.com/qw-acquired" });
    expect(await open_alert_ids()).toEqual([]);
    const actions = (
      await pool.query<{ action: string }>("SELECT action FROM admin_audit_log WHERE brand_id = $1 ORDER BY created_at", [brand_id])
    ).rows.map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(["correct", "apply_alert"]));
  });

  test("using an alert as fresh evidence re-verifies without changing the claim", async () => {
    await save_watch_results(pool, brand_id, [
      candidate({ url: "https://sec.example.com/filing", title: "Merger communication naming the brand", source: "sec_edgar" }),
    ]);
    const [alert] = await open_alert_ids();
    await resolve_ownership_alert(
      admin,
      alert!,
      { action: "reverify", input: { ownership_source_type: "sec_edgar", ownership_source_url: "https://sec.example.com/filing" } },
      pool,
    );
    const brand = await pool.query("SELECT corporate_tier, ownership_source_type, ownership_source_url FROM brands WHERE id = $1", [brand_id]);
    expect(brand.rows[0]).toEqual({ corporate_tier: 1, ownership_source_type: "sec_edgar", ownership_source_url: "https://sec.example.com/filing" });
    const closed = await fetch_ownership_alerts(admin, "closed", pool);
    const statuses = closed.find((group) => group.brand_id === brand_id)!.alerts.map((entry) => [entry.status, entry.resolver_email]);
    expect(statuses).toEqual(expect.arrayContaining([["applied", LOCAL_DEV_ADMIN_EMAIL], ["dismissed", LOCAL_DEV_ADMIN_EMAIL]]));
  });
});
