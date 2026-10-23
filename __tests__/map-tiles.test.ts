import { DEFAULT_TILE_CONFIG, resolve_tile_config } from "@/lib/map-tiles";

describe("map tile source", () => {
  test("defaults to keyless OpenStreetMap tiles, darkened by CSS", () => {
    expect(resolve_tile_config({})).toEqual(DEFAULT_TILE_CONFIG);
    expect(DEFAULT_TILE_CONFIG.url).toBe("https://tile.openstreetmap.org/{z}/{x}/{y}.png");
    expect(DEFAULT_TILE_CONFIG.needs_dark_filter).toBe(true);
    // CARTO now answers keyless requests with an "API KEY REQUIRED" image.
    expect(DEFAULT_TILE_CONFIG.url).not.toContain("cartocdn");
  });

  test("a keyed provider can be configured, already-dark styles skip the filter", () => {
    const config = resolve_tile_config({
      url: "https://tiles.example.com/dark/{z}/{x}/{y}.png?api_key=abc",
      attribution: "&copy; Example Maps",
      subdomains: "",
      max_zoom: "20",
      is_dark: "true",
    });
    expect(config).toEqual({
      url: "https://tiles.example.com/dark/{z}/{x}/{y}.png?api_key=abc",
      attribution: "&copy; Example Maps",
      subdomains: DEFAULT_TILE_CONFIG.subdomains,
      max_zoom: 20,
      needs_dark_filter: false,
    });
  });

  test("invalid settings fall back safely", () => {
    for (const url of ["http://insecure.example.com/{z}/{x}/{y}.png", "https://example.com/tiles.png", "not a url {z}{x}{y}", "  "]) {
      expect(resolve_tile_config({ url })).toEqual(DEFAULT_TILE_CONFIG);
    }
    const config = resolve_tile_config({ url: "https://t.example.com/{z}/{x}/{y}.png", max_zoom: "99", attribution: " " });
    expect(config.max_zoom).toBe(DEFAULT_TILE_CONFIG.max_zoom);
    expect(config.attribution).toBe(DEFAULT_TILE_CONFIG.attribution);
    expect(config.needs_dark_filter).toBe(true);
  });
});
