import { Pool } from "pg";
import { LOCAL_DEV_ADMIN_EMAIL, LOCAL_DEV_ADMIN_ID, type AdminIdentity } from "@/lib/auth/admin-session";
import { fetch_storefront_queue } from "@/lib/db/storefronts";
import { fetch_market_id } from "@/lib/import/boundaries";
import {
  build_registry_queries,
  fetch_candidates_to_check,
  is_professional_practice,
  looks_like_food_business,
  names_match,
  parse_shop_address,
  rank_registry_entities,
  registry_record_url,
  same_address,
  save_registry_suggestions,
  suggest_registry_entities,
  type RegistryEntity,
} from "@/lib/import/registry";
import { upsert_storefront_candidates } from "@/lib/import/storefronts";

describe("registry name matching", () => {
  test("same business, ignoring legal suffixes and generic words", () => {
    expect(names_match("Elsewhere Espresso", "ELSEWHERE ESPRESSO LLC")).toBe(true);
    expect(names_match("34th Bagels And More", "34TH BAGELS & MORE CORP")).toBe(true);
    expect(names_match("18.5 Gram Coffee", "18.5GRAM INC.")).toBe(true);
    expect(names_match("Absolute Coffee", "ABSOLUTE COFFEE LLC")).toBe(true);
  });

  test("regressions from live data: no matches on street words, single letters or numbers alone", () => {
    expect(names_match("11 Street Cafe", "WEST W11TH STREET BLOCK ASSOCIATION INC.")).toBe(false);
    expect(names_match("A Bar", "ISRL BAR LLC")).toBe(false);
    // A number-only name must lead the entity name.
    expect(names_match("18 Bakery", "18 BAKERY INC.")).toBe(true);
    expect(names_match("227", "227 & 229 BURBANC AVENUE LLC")).toBe(true);
    expect(names_match("227", "HOUSE 227 LLC")).toBe(false);
  });

  test("food keywords match whole words only", () => {
    expect(looks_like_food_business("ABSOLUTE BAGELS, INC.")).toBe(true);
    expect(looks_like_food_business("81 EAST 7TH PASTRY SHOP CORP.")).toBe(true);
    expect(looks_like_food_business("BROOKLYN BREWERY LLC")).toBe(true);
    expect(looks_like_food_business("209 BREWSTER ROAD LLC")).toBe(false);
    expect(looks_like_food_business("ARMISTEAD BEVERAGE LLC")).toBe(false);
  });

  test("professional practices are never the shop", () => {
    expect(is_professional_practice({ current_entity_name: "THOUGHTFUL FOODS DIETETICS - NUTRITION P.L.L.C." })).toBe(true);
    expect(is_professional_practice({ current_entity_name: "SMITH CPA", entity_type: "DOMESTIC PROFESSIONAL CORPORATION" })).toBe(true);
    expect(is_professional_practice({ current_entity_name: "18 BAKERY INC." })).toBe(false);
  });
});

describe("registry addresses", () => {
  const shop = parse_shop_address("335 East 6 Street, Manhattan, NY 10003")!;

  test("parses the queue's address format", () => {
    expect(shop).toEqual({ building: "335", street: "East 6 Street", zipcode: "10003" });
    expect(parse_shop_address("28-01 24 Avenue, Queens, NY 11102")).toEqual({ building: "28-01", street: "24 Avenue", zipcode: "11102" });
    expect(parse_shop_address("no zip here")).toBeNull();
  });

  test("same building on the same street and zip, numbered streets with or without a suffix", () => {
    expect(same_address(shop, "335 EAST 6TH STREET", "10003")).toBe(true);
    expect(same_address(shop, "335 E 6 ST", "10003-1234")).toBe(true);
    expect(same_address(shop, "335 EAST 16TH STREET", "10003")).toBe(false);
    expect(same_address(shop, "33 EAST 6TH STREET", "10003")).toBe(false);
    expect(same_address(shop, "335 EAST 6TH STREET", "10009")).toBe(false);
  });

  test("two lookups: the building at the zip, and the name", () => {
    const queries = build_registry_queries("Elsewhere Espresso", shop);
    expect(queries[0]).toContain("location_zip like '10003%'");
    expect(queries[0]).toContain("like '335 %'");
    expect(queries[1]).toBe("upper(current_entity_name) like 'ELSEWHERE ESPRESSO%'");
    expect(build_registry_queries("O'Brien's Cafe", null)[0]).toContain("'OBRIENS CAFE%'");
  });
});

describe("ranking", () => {
  const shop = parse_shop_address("335 East 6 Street, Manhattan, NY 10003");
  const entity = (overrides: Partial<RegistryEntity>): RegistryEntity => ({
    dos_id: "1",
    current_entity_name: "X",
    jurisdiction: "New York",
    county: "New York",
    location_address_1: "335 EAST 6TH STREET",
    location_zip: "10003",
    initial_dos_filing_date: "2012-01-01T00:00:00.000",
    ...overrides,
  });

  test("same name at the address beats a food business at the address beats the name elsewhere", () => {
    const ranked = rank_registry_entities("Elsewhere Espresso", shop, [
      entity({ dos_id: "a", current_entity_name: "LUMINANCE INC." }),
      entity({ dos_id: "b", current_entity_name: "EAST 6TH COFFEE CORP" }),
      entity({ dos_id: "c", current_entity_name: "ELSEWHERE ESPRESSO LLC", location_address_1: "1 OTHER ST", location_zip: "11211", county: "Kings" }),
      entity({ dos_id: "d", current_entity_name: "ELSEWHERE ESPRESSO LLC" }),
    ]);
    expect(ranked.map((suggestion) => [suggestion.entity_id, suggestion.match_reason, suggestion.score])).toEqual([
      ["d", "name_at_address", 90],
      ["b", "business_at_address", 60],
      ["c", "name_elsewhere", 35],
    ]);
    expect(ranked[0]?.record_url).toBe(registry_record_url("d"));
    expect(ranked[0]?.filed_on).toBe("2012-01-01");
  });

  test("out-of-state registrations rank lower; unrelated tenants are dropped", () => {
    const ranked = rank_registry_entities("Elsewhere Espresso", shop, [
      entity({ dos_id: "de", current_entity_name: "ELSEWHERE ESPRESSO LLC", jurisdiction: "Delaware" }),
      entity({ dos_id: "x", current_entity_name: "BLACKFRIAR PRODUCTIONS, LLC" }),
    ]);
    expect(ranked).toEqual([expect.objectContaining({ entity_id: "de", score: 75 })]);
  });

  test("looks a shop up with both queries and ranks the combined results", async () => {
    const seen: string[] = [];
    const fake_fetch = (async (url: URL) => {
      const where = url.searchParams.get("$where") ?? "";
      seen.push(where);
      const body = where.startsWith("upper(current_entity_name)")
        ? [{ dos_id: "n", current_entity_name: "ELSEWHERE ESPRESSO LLC", jurisdiction: "New York", county: "Kings" }]
        : [{ dos_id: "a", current_entity_name: "ELSEWHERE ESPRESSO LLC", jurisdiction: "New York", location_address_1: "335 EAST 6TH STREET", location_zip: "10003" }];
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const suggestions = await suggest_registry_entities(
      { id: "c", name: "Elsewhere Espresso", address: "335 East 6 Street, Manhattan, NY 10003" },
      { fetch_impl: fake_fetch },
    );
    expect(seen).toHaveLength(2);
    expect(suggestions.map((suggestion) => suggestion.entity_id)).toEqual(["a", "n"]);
  });
});

describe("registry suggestions (database)", () => {
  const database_url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/trueown";
  const SOURCE = "zz_registry_test";
  const admin: AdminIdentity = {
    actor_id: LOCAL_DEV_ADMIN_ID,
    email: LOCAL_DEV_ADMIN_EMAIL,
    mode: "local_basic",
    claims: { role: "authenticated", sub: LOCAL_DEV_ADMIN_ID, email: LOCAL_DEV_ADMIN_EMAIL, app_metadata: { role: "admin" } },
  };
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: database_url, max: 2 });
    await pool.query("DELETE FROM storefront_candidates WHERE source = $1", [SOURCE]);
  });
  afterAll(async () => {
    await pool.query("DELETE FROM storefront_candidates WHERE source = $1", [SOURCE]);
    await pool.end();
  });

  test("saved suggestions appear on queue items, and the queue can sort by them", async () => {
    const market_id = await fetch_market_id(pool, "nyc");
    const row = (record_id: string, name: string) => ({
      source: SOURCE,
      source_record_id: record_id,
      name,
      address: `${record_id} Registry Row, Manhattan, NY 10003`,
      borough: "Manhattan",
      category: "Coffee/Tea",
      industry_vertical: "coffee_bakery" as const,
      latitude: 40.73,
      longitude: -73.99,
      matched_brand_id: null,
      match_kind: "none" as const,
      source_updated_on: null,
    });
    await upsert_storefront_candidates(pool, market_id, [row("1", "ZZ Registry Big"), row("2", "ZZ Registry Big"), row("3", "ZZ Registry Lead")], 3);
    const to_check = await fetch_candidates_to_check(pool, "nyc", { limit: 100_000 });
    const lead = to_check.find((candidate) => candidate.name === "ZZ Registry Lead")!;
    await save_registry_suggestions(pool, lead.id, [
      {
        entity_id: "999",
        entity_name: "ZZ REGISTRY LEAD LLC",
        entity_type: "DOMESTIC LIMITED LIABILITY COMPANY",
        jurisdiction: "New York",
        filed_on: "2015-03-02",
        entity_address: "3 REGISTRY ROW 10003",
        match_reason: "name_at_address",
        score: 90,
        record_url: registry_record_url("999"),
      },
    ]);
    // Checked shops are skipped on the next run.
    expect((await fetch_candidates_to_check(pool, "nyc", { limit: 100_000 })).some((candidate) => candidate.id === lead.id)).toBe(false);

    const by_size = await fetch_storefront_queue(admin, "nyc", "zz registry", pool);
    expect(by_size.independents.map((group) => group.name)).toEqual(["ZZ Registry Big", "ZZ Registry Lead"]);
    const by_registry = await fetch_storefront_queue(admin, "nyc", "zz registry", pool, { independent_sort: "registry" });
    expect(by_registry.independents.map((group) => group.name)).toEqual(["ZZ Registry Lead", "ZZ Registry Big"]);
    expect(by_registry.independents[0]?.candidates[0]?.registry).toEqual([
      expect.objectContaining({ entity_name: "ZZ REGISTRY LEAD LLC", match_reason: "name_at_address", filed_on: "2015-03-02" }),
    ]);
  });
});
