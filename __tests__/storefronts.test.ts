import { Pool, PoolClient } from "pg";
import { LOCAL_DEV_ADMIN_EMAIL, LOCAL_DEV_ADMIN_ID, type AdminIdentity } from "@/lib/auth/admin-session";
import {
  add_corporate_brand,
  add_independent,
  approve_storefronts,
  fetch_storefront_queue,
  reject_storefronts,
  reopen_storefronts,
  StorefrontChangeRejectedError,
} from "@/lib/db/storefronts";
import { fetch_market_id } from "@/lib/import/boundaries";
import {
  build_candidates,
  build_dohmh_where,
  dedupe_establishments,
  fetch_dohmh_establishments,
  format_dohmh_address,
  match_brand,
  normalize_business_name,
  parse_dohmh_rows,
  upsert_storefront_candidates,
  type DohmhEstablishment,
  type MatchableBrand,
  type StorefrontCandidateInput,
} from "@/lib/import/storefronts";
import {
  validate_add_corporate_brand,
  validate_add_independent,
  validate_approve_storefronts,
  validate_reject_storefronts,
  validate_reopen_storefronts,
} from "@/lib/storefront-review";

const brand = (id: string, name: string): MatchableBrand => ({ id, name, industry_vertical: "coffee_bakery" });
const BRANDS = [
  brand("dunkin", "Dunkin'"),
  brand("maman", "Maman"),
  brand("magnolia", "Magnolia Bakery"),
  brand("joe", "Joe & The Juice"),
  brand("blank", "Blank Street Coffee"),
  brand("blank-short", "Blank"),
  brand("crumbl", "Crumbl"),
];

describe("brand name matching", () => {
  test("normalization handles apostrophes, ampersands and punctuation", () => {
    expect(normalize_business_name("DUNKIN'")).toBe("DUNKIN");
    expect(normalize_business_name("Joe & The Juice (Oculus Westfield)")).toBe("JOE AND THE JUICE OCULUS WESTFIELD");
    expect(normalize_business_name("  Café   Rêve ")).toBe("CAFE REVE");
  });

  test("exact matches: the same name, or the brand followed by more words", () => {
    for (const name of ["DUNKIN", "DUNKIN' / BASKIN ROBBINS", "DUNKIN', BASKIN ROBBINS"]) {
      expect(match_brand(name, BRANDS)).toMatchObject({ kind: "exact", brand: { id: "dunkin" } });
    }
    expect(match_brand("JOE & THE JUICE BROAD ST", BRANDS)).toMatchObject({ kind: "exact", brand: { id: "joe" } });
    expect(match_brand("CRUMBL COOKIES UPPER EAST SIDE", BRANDS)).toMatchObject({ kind: "exact", brand: { id: "crumbl" } });
  });

  test("the longest brand name wins", () => {
    expect(match_brand("BLANK STREET COFFEE", BRANDS)).toMatchObject({ kind: "exact", brand: { id: "blank" } });
  });

  test("lookalikes are never exact: a brand word later in the name is no match", () => {
    expect(match_brand("PETITE MAMAN", BRANDS)).toEqual({ brand: null, kind: "none" });
    expect(match_brand("HUDSON DUNKIN", BRANDS)).toEqual({ brand: null, kind: "none" });
  });

  test("typos and glued names are possible matches for a human to confirm", () => {
    expect(match_brand("MAGNOLIA BAGERY", BRANDS)).toMatchObject({ kind: "possible", brand: { id: "magnolia" } });
    expect(match_brand("DUNKIN99", BRANDS)).toMatchObject({ kind: "possible", brand: { id: "dunkin" } });
    // A different business whose name starts with a brand name is never exact: a person decides.
    expect(match_brand("CRUMBLY CAFE & BAKERY", BRANDS)).toMatchObject({ kind: "possible", brand: { id: "crumbl" } });
    expect(match_brand("MAMANS", BRANDS)).toEqual({ brand: null, kind: "none" }); // short names never fuzzy-match
  });
});

function record(overrides: Partial<DohmhEstablishment> = {}): DohmhEstablishment {
  return {
    camis: "1",
    dba: "BEAN THERE",
    boro: "Manhattan",
    building: "186",
    street: "WEST 4 STREET",
    zipcode: "10014",
    latitude: 40.7324,
    longitude: -74.0021,
    cuisine_description: "Coffee/Tea",
    last_inspection_on: "2026-09-01",
    ...overrides,
  };
}

describe("NYC Open Data records", () => {
  test("the query covers the categories plus every tracked brand's first word", () => {
    const where = build_dohmh_where([brand("a", "Pret A Manger"), brand("b", "Joe & The Juice"), brand("c", "Dunkin'")]);
    expect(where).toContain("cuisine_description in ('Coffee/Tea', 'Bakery Products/Desserts', 'Donuts', 'Bagels/Pretzels')");
    expect(where).toContain("upper(dba) like 'PRET%'");
    expect(where).toContain("upper(dba) like 'JOE%'");
    expect(where).toContain("upper(dba) like 'DUNKIN%'");
  });

  test("rows are parsed defensively; 0 coordinates mean not geocoded", () => {
    expect(
      parse_dohmh_rows([
        { camis: "9", dba: "X", latitude: "0", longitude: "0", last_inspection: "2026-01-02T00:00:00.000" },
        { dba: "missing id" },
      ]),
    ).toEqual([
      expect.objectContaining({ camis: "9", latitude: null, longitude: null, last_inspection_on: "2026-01-02" }),
    ]);
    expect(() => parse_dohmh_rows({ error: true })).toThrow();
  });

  test("one record per establishment, the latest one", () => {
    const deduped = dedupe_establishments([
      record({ last_inspection_on: "2025-01-01", dba: "OLD NAME" }),
      record({ last_inspection_on: "2026-01-01", dba: "NEW NAME" }),
      record({ camis: "2" }),
    ]);
    expect(deduped).toHaveLength(2);
    expect(deduped.find((entry) => entry.camis === "1")?.dba).toBe("NEW NAME");
  });

  test("addresses are readable", () => {
    expect(format_dohmh_address(record())).toBe("186 West 4 Street, Manhattan, NY 10014");
  });

  test("scope: tracked brands in any category, unmatched shops only in coffee/bakery categories", () => {
    const candidates = build_candidates(
      [
        record({ camis: "1", dba: "PRET A MANGER", cuisine_description: "Sandwiches" }),
        record({ camis: "2", dba: "CORNER DELI", cuisine_description: "Sandwiches" }),
        record({ camis: "3", dba: "BEAN THERE", cuisine_description: "Coffee/Tea" }),
        record({ camis: "4", dba: "NO ADDRESS", building: "" }),
        record({ camis: "5", dba: "NEW SHOP", last_inspection_on: "1900-01-01" }),
      ],
      [brand("pret", "Pret A Manger")],
    );
    expect(candidates.map((candidate) => [candidate.source_record_id, candidate.match_kind])).toEqual([
      ["1", "exact"],
      ["3", "none"],
      ["5", "none"],
    ]);
    expect(candidates[0]).toMatchObject({ name: "Pret A Manger", matched_brand_id: "pret" });
    expect(candidates[2]?.source_updated_on).toBeNull(); // 1900-01-01 = not yet inspected
  });

  test("pages through the dataset until a short page", async () => {
    const pages = [
      Array.from({ length: 20_000 }, (_, index) => ({ camis: String(index), dba: "A", latitude: "40.7", longitude: "-74" })),
      [{ camis: "x", dba: "B", latitude: "40.7", longitude: "-74" }],
    ];
    const requested: string[] = [];
    const fake_fetch = (async (url: URL) => {
      requested.push(url.searchParams.get("$offset") ?? "");
      return new Response(JSON.stringify(pages[requested.length - 1] ?? []), { status: 200 });
    }) as unknown as typeof fetch;
    const records = await fetch_dohmh_establishments([], { fetch_impl: fake_fetch });
    expect(requested).toEqual(["0", "20000"]);
    expect(records).toHaveLength(20_001);
  });
});

describe("review payloads", () => {
  const id = "5b0d8a1e-7c2f-4e93-a6d1-3f8e2c9b7a40";
  test("batches, reasons and independent evidence are validated", () => {
    expect(validate_approve_storefronts({ candidate_ids: [id, id] })).toEqual({ valid: true, input: { candidate_ids: [id], brand_id: null } });
    expect(validate_approve_storefronts({ candidate_ids: [] })).toMatchObject({ valid: false });
    expect(validate_approve_storefronts({ candidate_ids: ["nope"] })).toMatchObject({ valid: false });
    expect(validate_reject_storefronts({ candidate_ids: [id], note: " " })).toMatchObject({ valid: false });
    expect(
      validate_add_independent({ candidate_id: id, brand_name: "Bean There", ownership_source_type: "sec_edgar", ownership_source_url: "https://x.io" }),
    ).toMatchObject({ valid: false });
    expect(
      validate_add_independent({
        candidate_id: id,
        brand_name: " Bean  There ",
        ownership_source_type: "state_business_registry",
        ownership_source_url: "https://apps.dos.ny.gov/publicInquiry/",
      }),
    ).toMatchObject({ valid: true, input: { brand_name: "Bean There" } });
  });
});

/* ------------------------------------------------------------------------- */
/* Database                                                                    */
/* ------------------------------------------------------------------------- */

const database_url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/trueown";
const SOURCE = "zz_test_source";
const admin: AdminIdentity = {
  actor_id: LOCAL_DEV_ADMIN_ID,
  email: LOCAL_DEV_ADMIN_EMAIL,
  mode: "local_basic",
  claims: { role: "authenticated", sub: LOCAL_DEV_ADMIN_ID, email: LOCAL_DEV_ADMIN_EMAIL, app_metadata: { role: "admin" } },
};

describe("storefront queue (database)", () => {
  let pool: Pool;
  let market_id: string;
  let blank_street_id: string;

  const candidate = (id: string, overrides: Partial<StorefrontCandidateInput> = {}): StorefrontCandidateInput => ({
    source: SOURCE,
    source_record_id: id,
    name: `ZZ Shop ${id}`,
    address: `${id} Test Lane, Manhattan, NY 10014`,
    borough: "Manhattan",
    category: "Coffee/Tea",
    industry_vertical: "coffee_bakery",
    latitude: 40.735,
    longitude: -73.995,
    matched_brand_id: null,
    match_kind: "none",
    source_updated_on: "2026-09-01",
    ...overrides,
  });

  async function cleanup(): Promise<void> {
    await pool.query(
      "DELETE FROM admin_audit_log WHERE payload ->> 'storefront_candidate_id' IN (SELECT id::text FROM storefront_candidates WHERE source = $1) OR payload ? 'storefront_candidate_ids'",
      [SOURCE],
    );
    await pool.query("DELETE FROM locations WHERE address LIKE '% Test Lane, Manhattan, NY 10014'");
    await pool.query("DELETE FROM storefront_candidates WHERE source = $1", [SOURCE]);
    await pool.query("DELETE FROM brands WHERE name LIKE 'ZZ Indie%'");
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: database_url, max: 2 });
    market_id = await fetch_market_id(pool, "nyc");
    blank_street_id = (await pool.query<{ id: string }>("SELECT id FROM brands WHERE name = 'Blank Street Coffee'")).rows[0]!.id;
  });
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  test("import upserts, detects storefronts already on the map, and keeps decisions on re-import", async () => {
    // Blank Street's seed storefront is at 40.7324,-74.0021: a candidate 10m away is the same shop.
    const first = await upsert_storefront_candidates(
      pool,
      market_id,
      [
        candidate("1", { matched_brand_id: blank_street_id, match_kind: "exact", latitude: 40.73245, longitude: -74.0021 }),
        candidate("2", { matched_brand_id: blank_street_id, match_kind: "exact" }),
        candidate("3"),
      ],
      3,
    );
    expect(first).toMatchObject({ inserted: 3, already_listed: 1, exact: 2, unmatched: 1 });

    await reject_storefronts(admin, [(await id_of("3"))], "Not a café", pool);
    const again = await upsert_storefront_candidates(pool, market_id, [candidate("3", { name: "ZZ Renamed" })], 1);
    expect(again).toMatchObject({ inserted: 0, updated: 1 });
    const row = await pool.query("SELECT status, name FROM storefront_candidates WHERE source = $1 AND source_record_id = '3'", [SOURCE]);
    expect(row.rows[0]).toEqual({ status: "rejected", name: "ZZ Renamed" });
  });

  async function id_of(record_id: string): Promise<string> {
    return (await pool.query<{ id: string }>("SELECT id FROM storefront_candidates WHERE source = $1 AND source_record_id = $2", [SOURCE, record_id])).rows[0]!.id;
  }

  test("approving chain matches publishes storefronts for the brand, audited", async () => {
    await upsert_storefront_candidates(pool, market_id, [candidate("10", { matched_brand_id: blank_street_id, match_kind: "exact" }), candidate("11", { matched_brand_id: blank_street_id, match_kind: "possible" })], 2);
    expect(await approve_storefronts(admin, [await id_of("10")], null, pool)).toBe(1);
    const location = await pool.query(
      "SELECT b.name, l.city, l.neighborhood FROM locations l JOIN brands b ON b.id = l.brand_id WHERE l.address = '10 Test Lane, Manhattan, NY 10014'",
    );
    expect(location.rows[0]).toMatchObject({ name: "Blank Street Coffee", city: "New York" });
    expect(location.rows[0].neighborhood).toBeTruthy();

    // A possible match needs an explicit brand.
    await expect(approve_storefronts(admin, [await id_of("11")], null, pool)).rejects.toMatchObject({ status: 422 });
    expect(await approve_storefronts(admin, [await id_of("11")], blank_street_id, pool)).toBe(1);
    // Already decided.
    await expect(approve_storefronts(admin, [await id_of("10")], null, pool)).rejects.toMatchObject({ status: 409 });

    const audit = await pool.query("SELECT count(*)::int AS n FROM admin_audit_log WHERE action = 'approve_storefront' AND payload ->> 'source' = $1", [SOURCE]);
    expect(audit.rows[0].n).toBe(2);
  });

  test("storefronts without coordinates cannot be placed", async () => {
    await upsert_storefront_candidates(pool, market_id, [candidate("20", { matched_brand_id: blank_street_id, match_kind: "exact", latitude: null, longitude: null })], 1);
    await expect(approve_storefronts(admin, [await id_of("20")], null, pool)).rejects.toMatchObject({ status: 422 });
  });

  test("a new independent needs Tier 3 evidence, and same-named shops then match it", async () => {
    await upsert_storefront_candidates(pool, market_id, [candidate("30", { name: "ZZ Indie Beans" }), candidate("31", { name: "ZZ Indie Beans" })], 2);
    await expect(
      add_independent(admin, { candidate_id: await id_of("30"), brand_name: "ZZ Indie Beans", ownership_source_type: "sec_edgar" as never, ownership_source_url: "https://x.io" }, pool),
    ).rejects.toMatchObject({ status: 422 });
    await add_independent(
      admin,
      { candidate_id: await id_of("30"), brand_name: "ZZ Indie Beans", ownership_source_type: "state_business_registry", ownership_source_url: "https://apps.dos.ny.gov/publicInquiry/" },
      pool,
    );
    const created = await pool.query(
      "SELECT corporate_tier, ownership_source_type, (SELECT slug FROM markets WHERE id = home_market_id) AS home FROM brands WHERE name = 'ZZ Indie Beans'",
    );
    expect(created.rows[0]).toEqual({ corporate_tier: 3, ownership_source_type: "state_business_registry", home: "nyc" });
    const sibling = await pool.query("SELECT match_kind, status FROM storefront_candidates WHERE id = $1", [await id_of("31")]);
    expect(sibling.rows[0]).toEqual({ match_kind: "exact", status: "pending" });

    await upsert_storefront_candidates(pool, market_id, [candidate("32", { name: "Blank Street Coffee" })], 1);
    await expect(
      add_independent(admin, { candidate_id: await id_of("32"), brand_name: "Blank Street Coffee", ownership_source_type: "local_press", ownership_source_url: "https://x.io/a" }, pool),
    ).rejects.toMatchObject({ status: 409 });
  });

  test("rejections need a reason", async () => {
    await upsert_storefront_candidates(pool, market_id, [candidate("40")], 1);
    await expect(reject_storefronts(admin, [await id_of("40")], " ", pool)).rejects.toBeInstanceOf(StorefrontChangeRejectedError);
  });

  test("the queue groups chains by brand and independents by name", async () => {
    await upsert_storefront_candidates(
      pool,
      market_id,
      [
        candidate("50", { matched_brand_id: blank_street_id, match_kind: "exact" }),
        candidate("51", { name: "ZZ Indie Twins" }),
        candidate("52", { name: "ZZ Indie Twins" }),
      ],
      3,
    );
    const queue = await fetch_storefront_queue(admin, "nyc", "zz ", pool);
    expect(queue.counts).toEqual({ chains: 1, possible: 0, independents: 2, rejected: 0 });
    expect(queue.independents).toEqual([expect.objectContaining({ name: "ZZ Indie Twins", location_count: 2 })]);
    const by_brand = await fetch_storefront_queue(admin, "nyc", "blank street", pool);
    expect(by_brand.chains.find((group) => group.brand_id === blank_street_id)?.candidates.length).toBeGreaterThan(0);
  });

  test("only admins can see or act on the queue", async () => {
    await upsert_storefront_candidates(pool, market_id, [candidate("60")], 1);
    const client: PoolClient = await pool.connect();
    try {
      for (const [role, claims] of [["anon", ""], ["authenticated", JSON.stringify({ role: "authenticated", sub: LOCAL_DEV_ADMIN_ID })]] as const) {
        await client.query("BEGIN");
        await client.query(`SET LOCAL ROLE ${role}`);
        await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims]);
        if (role === "anon") {
          await expect(client.query("SELECT 1 FROM storefront_candidates")).rejects.toThrow(/permission denied/);
        } else {
          expect((await client.query("SELECT 1 FROM storefront_candidates")).rowCount).toBe(0);
          await expect(client.query("SELECT approve_storefront_candidates(ARRAY[gen_random_uuid()], NULL)")).rejects.toThrow(/not_admin/);
        }
        await client.query("ROLLBACK");
      }
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });
});

describe("PE/VC brand from the queue and undoing rejections", () => {
  const id = "5b0d8a1e-7c2f-4e93-a6d1-3f8e2c9b7a40";
  const corporate = {
    candidate_id: id,
    brand_name: "ZZ Chain Tea",
    corporate_tier: 1,
    parent_entity: "Example Partners (majority)",
    financial_backers: "Example Partners; Example Capital, Example Partners",
    ownership_source_type: "investor_press_release",
    ownership_source_url: "https://example.com/deal",
  };

  test("a PE/VC brand needs a tier 1 or 2, an owner and corporate-record evidence", () => {
    expect(validate_add_corporate_brand(corporate)).toMatchObject({
      valid: true,
      input: { corporate_tier: 1, financial_backers: ["Example Partners", "Example Capital"] },
    });
    for (const broken of [
      { corporate_tier: 3 },
      { parent_entity: " " },
      { ownership_source_type: "community_consensus" },
      { ownership_source_url: "not a link" },
      { financial_backers: [1, 2] },
    ]) {
      expect(validate_add_corporate_brand({ ...corporate, ...broken })).toMatchObject({ valid: false });
    }
    expect(validate_reopen_storefronts({ candidate_ids: [id] })).toEqual({ valid: true, input: { candidate_ids: [id], note: null } });
    expect(validate_reopen_storefronts({ candidate_ids: [] })).toMatchObject({ valid: false });
  });

  describe("database", () => {
    let pool: Pool;
    let market_id: string;
    const SOURCE_B = "zz_test_chain_source";

    const row = (record_id: string, name: string): StorefrontCandidateInput => ({
      source: SOURCE_B,
      source_record_id: record_id,
      name,
      address: `${record_id} Chain Lane, Manhattan, NY 10014`,
      borough: "Manhattan",
      category: "Coffee/Tea",
      industry_vertical: "coffee_bakery",
      latitude: 40.736,
      longitude: -73.994,
      matched_brand_id: null,
      match_kind: "none",
      source_updated_on: null,
    });
    const id_of = async (record_id: string) =>
      (await pool.query<{ id: string }>("SELECT id FROM storefront_candidates WHERE source = $1 AND source_record_id = $2", [SOURCE_B, record_id])).rows[0]!.id;

    async function cleanup(): Promise<void> {
      await pool.query(
        `DELETE FROM admin_audit_log
          WHERE brand_id IN (SELECT id FROM brands WHERE name LIKE 'ZZ Chain%')
             OR payload ->> 'storefront_candidate_id' IN (SELECT id::text FROM storefront_candidates WHERE source = $1)
             OR payload ? 'storefront_candidate_ids'`,
        [SOURCE_B],
      );
      await pool.query("DELETE FROM locations WHERE address LIKE '% Chain Lane, Manhattan, NY 10014'");
      await pool.query("DELETE FROM storefront_candidates WHERE source = $1", [SOURCE_B]);
      await pool.query("DELETE FROM brands WHERE name LIKE 'ZZ Chain%'");
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: database_url, max: 2 });
      market_id = await fetch_market_id(pool, "nyc");
    });
    beforeEach(cleanup);
    afterAll(async () => {
      await cleanup();
      await pool.end();
    });

    test("adds the brand with its evidence and moves all its shops to chain matches, then approve all publishes them", async () => {
      await upsert_storefront_candidates(pool, market_id, [row("1", "ZZ Chain Tea"), row("2", "ZZ Chain Tea"), row("3", "ZZ Chain Tea"), row("4", "ZZ Other")], 4);
      const result = await add_corporate_brand(
        admin,
        {
          candidate_id: await id_of("1"),
          brand_name: "ZZ Chain Tea",
          corporate_tier: 1,
          parent_entity: "Example Partners (majority)",
          financial_backers: ["Example Partners"],
          ownership_source_type: "investor_press_release",
          ownership_source_url: "https://example.com/deal",
        },
        pool,
      );
      expect(result.moved_to_chain_matches).toBe(3);

      const brand = await pool.query(
        "SELECT corporate_tier, parent_entity, financial_backers, ownership_source_type, ownership_source_url, home_market_id FROM brands WHERE id = $1",
        [result.brand_id],
      );
      expect(brand.rows[0]).toEqual({
        corporate_tier: 1,
        parent_entity: "Example Partners (majority)",
        financial_backers: ["Example Partners"],
        ownership_source_type: "investor_press_release",
        ownership_source_url: "https://example.com/deal",
        home_market_id: null,
      });
      // Nothing is published until the storefronts are approved.
      expect((await pool.query("SELECT count(*)::int AS n FROM locations WHERE brand_id = $1", [result.brand_id])).rows[0].n).toBe(0);

      const queue = await fetch_storefront_queue(admin, "nyc", "zz chain", pool);
      const group = queue.chains.find((chain) => chain.brand_id === result.brand_id);
      expect(group?.candidates).toHaveLength(3);
      expect(await approve_storefronts(admin, group!.candidates.map((candidate) => candidate.id), null, pool)).toBe(3);
      expect((await pool.query("SELECT count(*)::int AS n FROM locations WHERE brand_id = $1", [result.brand_id])).rows[0].n).toBe(3);

      const audit = await pool.query("SELECT payload FROM admin_audit_log WHERE action = 'add_corporate_brand' AND brand_id = $1", [result.brand_id]);
      expect(audit.rows[0].payload).toMatchObject({ corporate_tier: 1, moved_to_chain_matches: 3, evidence_url: "https://example.com/deal" });
    });

    test("refuses an existing brand name and evidence that does not fit the tier", async () => {
      await upsert_storefront_candidates(pool, market_id, [row("10", "Blank Street Coffee"), row("11", "ZZ Chain Two")], 2);
      const base = {
        corporate_tier: 2 as const,
        parent_entity: "Somebody",
        financial_backers: [],
        ownership_source_type: "crunchbase" as const,
        ownership_source_url: "https://example.com/x",
      };
      await expect(
        add_corporate_brand(admin, { ...base, candidate_id: await id_of("10"), brand_name: "Blank Street Coffee" }, pool),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        add_corporate_brand(admin, { ...base, candidate_id: await id_of("11"), brand_name: "ZZ Chain Two", ownership_source_type: "local_press" as never }, pool),
      ).rejects.toMatchObject({ status: 422 });
    });

    test("rejections can be undone, and reopened shops match a brand added since", async () => {
      await upsert_storefront_candidates(pool, market_id, [row("20", "ZZ Chain Late"), row("21", "ZZ Chain Late")], 2);
      const ids = [await id_of("20"), await id_of("21")];
      await reject_storefronts(admin, ids, "A chain we don't track", pool);

      let queue = await fetch_storefront_queue(admin, "nyc", "zz chain late", pool);
      expect(queue.rejected).toEqual([expect.objectContaining({ name: "ZZ Chain Late", reason: "A chain we don't track" })]);
      expect(queue.rejected[0]?.candidates).toHaveLength(2);

      // The brand is added later (e.g. through the brands import) ...
      await pool.query(
        `INSERT INTO brands (name, corporate_tier, industry_vertical, parent_entity, ownership_source_type, ownership_source_url, ownership_verified_on)
         VALUES ('ZZ Chain Late', 1, 'coffee_bakery', 'Late Capital', 'sec_edgar', 'https://www.sec.gov/x', current_date)`,
      );
      // ... and reopening brings the shops back as chain matches for it.
      expect(await reopen_storefronts(admin, ids, null, pool)).toBe(2);
      queue = await fetch_storefront_queue(admin, "nyc", "zz chain late", pool);
      expect(queue.rejected).toEqual([]);
      expect(queue.chains.find((chain) => chain.brand_name === "ZZ Chain Late")?.candidates).toHaveLength(2);

      // Only rejected shops can be reopened.
      await expect(reopen_storefronts(admin, ids, null, pool)).rejects.toMatchObject({ status: 409 });
      const audit = await pool.query("SELECT count(*)::int AS n FROM admin_audit_log WHERE action = 'reopen_storefront' AND payload -> 'storefront_candidate_ids' ? $1", [ids[0]]);
      expect(audit.rows[0].n).toBe(1);
    });

    test("only admins can call the new routines", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE authenticated");
        await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", sub: LOCAL_DEV_ADMIN_ID })]);
        await expect(client.query("SELECT reopen_storefront_candidates(ARRAY[gen_random_uuid()], NULL)")).rejects.toThrow(/not_admin/);
        await client.query("ROLLBACK");
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE anon");
        await expect(
          client.query("SELECT * FROM add_corporate_brand_from_candidates(gen_random_uuid(), 'x', 1, 'y', '{}', 'sec_edgar', 'https://x.io')"),
        ).rejects.toThrow(/permission denied/);
        await client.query("ROLLBACK");
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    });
  });
});
