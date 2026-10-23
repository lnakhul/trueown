import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Pool } from "pg";
import { parse_boundary_geojson, to_title_case } from "@/lib/import/boundaries";
import { upsert_markets } from "@/lib/import/markets";
import { NTA_PARSE_SPEC } from "@/lib/import/nta";
import { load_market_configs, parse_market_config, type MarketConfig } from "@/lib/markets/config";

const VALID_CONFIG = {
  slug: "zz-test-city",
  city_name: "ZZ Test City",
  city_label: "ZZ Test",
  status: "coming_soon",
  center: { latitude: -33.8688, longitude: 151.2093 },
  boundaries: {
    source_id: "zz_test_areas",
    dataset: "Test areas",
    publisher: "Test publisher",
    download_url: "https://example.com/areas.geojson",
    committed_file: null,
    properties: { code: "area_id", name: "area_name", borough: null, area_type: null },
    name_case: "title",
    min_expected_features: 1,
  },
};

describe("market config files", () => {
  test("the committed configs load and keep NYC in sync with the NTA importer", () => {
    const configs = load_market_configs();
    expect(configs.map((config) => config.slug)).toEqual(["austin", "chicago", "nyc"]);
    const nyc = configs.find((config) => config.slug === "nyc")!;
    expect(nyc).toMatchObject({ city_name: "New York City", city_label: "New York", status: "active" });
    expect(nyc.boundaries?.properties).toEqual(NTA_PARSE_SPEC.properties);
    expect(nyc.boundaries?.min_expected_features).toBe(NTA_PARSE_SPEC.min_expected_features);
    // New markets ship switched off and without brand data.
    configs.filter((config) => config.slug !== "nyc").forEach((config) => expect(config.status).toBe("coming_soon"));
  });

  test("a valid config parses", () => {
    const parsed = parse_market_config(VALID_CONFIG, "zz-test-city");
    expect(parsed.valid).toBe(true);
  });

  test("invalid configs list every problem", () => {
    const parsed = parse_market_config(
      {
        ...VALID_CONFIG,
        slug: "Bad Slug",
        status: "live",
        center: { latitude: 0, longitude: 0 },
        boundaries: { ...VALID_CONFIG.boundaries, download_url: "http://insecure.example.com", committed_file: "../etc/passwd", properties: { code: "a b" } },
      },
      "zz-test-city",
    );
    expect(parsed.valid).toBe(false);
    if (parsed.valid) return;
    const joined = parsed.errors.join(" | ");
    ["slug", "status", "center", "download_url", "committed_file", "properties.code", "properties.name"].forEach((fragment) =>
      expect(joined).toContain(fragment),
    );
  });

  test("a folder whose slug does not match its config fails the whole load", () => {
    const directory = mkdtempSync(join(tmpdir(), "markets-"));
    try {
      mkdirSync(join(directory, "elsewhere"));
      writeFileSync(join(directory, "elsewhere", "market.json"), JSON.stringify(VALID_CONFIG));
      expect(() => load_market_configs(directory)).toThrow(/does not match its folder/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("boundary property mapping", () => {
  const square = { type: "Polygon", coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]] };

  test("maps configured properties, accepts numeric codes and title-cases capitalised names", () => {
    const parsed = parse_boundary_geojson(
      {
        type: "FeatureCollection",
        features: [
          { type: "Feature", properties: { area_id: 7, area_name: "NEAR NORTH SIDE" }, geometry: square },
          { type: "Feature", properties: { area_id: "8", area_name: "O'HARE" }, geometry: square },
        ],
      },
      VALID_CONFIG.boundaries as never,
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.records.map((record) => [record.source_code, record.name])).toEqual([
      ["7", "Near North Side"],
      ["8", "O'Hare"],
    ]);
  });

  test("reports missing mapped properties and duplicate codes", () => {
    const parsed = parse_boundary_geojson(
      {
        type: "FeatureCollection",
        features: [
          { type: "Feature", properties: { area_id: "1" }, geometry: square },
          { type: "Feature", properties: { area_id: "2", area_name: "A" }, geometry: square },
          { type: "Feature", properties: { area_id: "2", area_name: "B" }, geometry: square },
        ],
      },
      VALID_CONFIG.boundaries as never,
    );
    expect(parsed.errors).toEqual([
      "Feature 1: area_id and area_name are required.",
      "Feature 3 (2): duplicate boundary code.",
    ]);
  });

  test("title case handles hyphens and slashes", () => {
    expect(to_title_case("NEAR-SOUTH SIDE/LOOP")).toBe("Near-South Side/Loop");
  });
});

describe("market upsert (database)", () => {
  const database_url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/trueown";
  let pool: Pool;
  const config = parse_market_config(VALID_CONFIG) as { valid: true; config: MarketConfig };

  beforeAll(async () => {
    pool = new Pool({ connectionString: database_url, max: 2 });
    await pool.query("DELETE FROM markets WHERE slug = $1", [VALID_CONFIG.slug]);
  });
  afterAll(async () => {
    await pool.query("DELETE FROM markets WHERE slug = $1", [VALID_CONFIG.slug]);
    await pool.end();
  });

  test("creates, is idempotent, and never flips a live status unless asked", async () => {
    expect(await upsert_markets(pool, [config.config])).toEqual([
      { slug: VALID_CONFIG.slug, action: "created", status: "coming_soon", status_kept_from: null },
    ]);
    expect((await upsert_markets(pool, [config.config]))[0]?.action).toBe("unchanged");

    await pool.query("UPDATE markets SET status = 'active' WHERE slug = $1", [VALID_CONFIG.slug]);
    expect((await upsert_markets(pool, [config.config]))[0]).toMatchObject({
      action: "unchanged",
      status: "active",
      status_kept_from: "coming_soon",
    });
    expect((await upsert_markets(pool, [config.config], { apply_status: true }))[0]).toMatchObject({
      action: "updated",
      status: "coming_soon",
    });
  });

  test("dry runs save nothing", async () => {
    const renamed = { ...config.config, city_label: "ZZ Renamed" };
    await upsert_markets(pool, [renamed], { dry_run: true });
    const stored = await pool.query("SELECT city_label FROM markets WHERE slug = $1", [VALID_CONFIG.slug]);
    expect(stored.rows[0].city_label).toBe("ZZ Test");
  });
});
