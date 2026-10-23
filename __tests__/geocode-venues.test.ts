import { parse_venue_csv, VENUE_TEMPLATE_COLUMNS } from "@/lib/import/venues";
import {
  build_geocode_query,
  geocode_venue_table,
  is_exact_match,
  leading_house_number,
  market_viewbox,
  nominatim_search_url,
  parse_nominatim_results,
  to_csv,
  type CsvTable,
  type GeocodeCandidate,
  type GeocodeLookup,
} from "@/lib/import/geocode-venues";
import { load_market_configs } from "@/lib/markets/config";

const markets = load_market_configs();
const nyc = markets.find((market) => market.slug === "nyc")!;
const HEADER = [...VENUE_TEMPLATE_COLUMNS];

function row(address: string, market: string, latitude = "", longitude = "", name = "Sample Cafe"): string[] {
  const values: Record<string, string> = {
      brand_name: name,
      industry_vertical: "coffee_bakery",
      corporate_tier: "3",
      ownership_source_type: "state_business_registry",
      ownership_source_url: "https://example.com/a",
      ownership_verified_on: "2026-10-01",
      address,
      market,
      latitude,
      longitude,
  };
  return HEADER.map((column) => values[column] ?? "");
}

function table(...rows: string[][]): CsvTable {
  return { header: HEADER, records: rows.map((cells, index) => ({ line: index + 2, cells })) };
}

function candidate(overrides: Partial<GeocodeCandidate> = {}): GeocodeCandidate {
  return { latitude: 40.7359, longitude: -74.0048, display_name: "401, Bleecker Street, New York", address_type: "building", house_number: "401", ...overrides };
}

describe("address matching rules", () => {
  test("house numbers, including Queens hyphenated ones", () => {
    expect(leading_house_number("401 Bleecker St")).toBe("401");
    expect(leading_house_number("28-01 24th Ave, Astoria")).toBe("28-01");
    expect(leading_house_number("28 - 01 24th Ave")).toBe("28-01");
    expect(leading_house_number("12A Main St")).toBe("12a");
    expect(leading_house_number("Bleecker St")).toBeNull();
    expect(leading_house_number("Pier 17")).toBeNull();
  });

  test("only a result with the same house number is exact", () => {
    expect(is_exact_match("401 Bleecker St", candidate())).toBe(true);
    expect(is_exact_match("401 Bleecker St", candidate({ house_number: "403" }))).toBe(false);
    expect(is_exact_match("401 Bleecker St", candidate({ house_number: null, address_type: "road" }))).toBe(false);
    expect(is_exact_match("28-01 24th Ave", candidate({ house_number: "28-01" }))).toBe(true);
  });

  test("the market's city is added only when the address lacks it", () => {
    expect(build_geocode_query("401 Bleecker St", nyc)).toBe("401 Bleecker St, New York");
    expect(build_geocode_query("401  Bleecker St, New York, NY", nyc)).toBe("401 Bleecker St, New York, NY");
    expect(build_geocode_query("401 Bleecker St", null)).toBe("401 Bleecker St");
  });

  test("searches are bounded to the market and ask for address details", () => {
    const url = nominatim_search_url("https://nominatim.openstreetmap.org", "401 Bleecker St, New York", nyc);
    expect(url.searchParams.get("bounded")).toBe("1");
    expect(url.searchParams.get("addressdetails")).toBe("1");
    expect(url.searchParams.get("viewbox")).toBe(market_viewbox(nyc));
    const [west, north, east, south] = market_viewbox(nyc).split(",").map(Number);
    expect(west!).toBeLessThan(nyc.center.longitude);
    expect(east!).toBeGreaterThan(nyc.center.longitude);
    expect(north!).toBeGreaterThan(nyc.center.latitude);
    expect(south!).toBeLessThan(nyc.center.latitude);
  });

  test("provider results are parsed defensively", () => {
    expect(
      parse_nominatim_results([
        { lat: "40.1", lon: "-73.9", display_name: "A", addresstype: "building", address: { house_number: "5" } },
        { lat: "nope", lon: "-73.9" },
        { lat: "40.2", lon: "-73.8", address: { house_number: 7 } },
      ]),
    ).toEqual([
      { latitude: 40.1, longitude: -73.9, display_name: "A", address_type: "building", house_number: "5" },
      { latitude: 40.2, longitude: -73.8, display_name: "", address_type: "", house_number: "7" },
    ]);
    expect(() => parse_nominatim_results({ error: "x" })).toThrow();
  });
});

describe("geocoding a venues file", () => {
  test("fills exact matches and reports everything else without guessing", async () => {
    const answers: Record<string, GeocodeCandidate[] | Error> = {
      "401 Bleecker St, New York": [candidate({ house_number: "399" }), candidate()],
      "1 Vague Pl, New York": [candidate({ house_number: null, address_type: "road", display_name: "Vague Place" })],
      "5 Far Away Rd, New York": [candidate({ house_number: "5", latitude: 34.05, longitude: -118.24 })],
      "9 Nowhere St, New York": [],
      "7 Broken Ave, New York": new Error("Geocoder responded with HTTP 503."),
    };
    const queries: string[] = [];
    const lookup: GeocodeLookup = async (query) => {
      queries.push(query);
      const answer = answers[query];
      if (answer instanceof Error) throw answer;
      return answer ?? [];
    };

    const result = await geocode_venue_table(
      table(
        row("401 Bleecker St", "nyc"),
        row("1 Vague Pl", "nyc"),
        row("5 Far Away Rd", "nyc"),
        row("9 Nowhere St", "nyc"),
        row("7 Broken Ave", "nyc"),
        row("239 E 5th St", "nyc", "40.7271", "-73.9897"),
        row("2 Half St", "nyc", "40.7"),
        row("Bleecker St", "nyc"),
        row("3 Unknown Market St", "atlantis"),
      ),
      markets,
      lookup,
    );

    expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
      "filled",
      "needs_review",
      "needs_review",
      "not_found",
      "error",
      "kept",
      "needs_review",
      "needs_review",
      "needs_review",
    ]);
    // Only rows with a house number and a known market reach the provider.
    expect(queries).toHaveLength(5);

    const latitude_index = HEADER.indexOf("latitude");
    const cells = result.table.records.map((record) => record.cells[latitude_index]);
    expect(cells[0]).toBe("40.735900"); // the exact candidate, not the first one returned
    expect(cells.slice(1, 5)).toEqual(["", "", "", ""]); // nothing guessed
    expect(cells[5]).toBe("40.7271"); // untouched
    expect(result.outcomes[2]?.note).toMatch(/outside New York City/);
    expect(result.outcomes[1]?.note).toMatch(/no exact house number/);
  });

  test("the importer explains what to do with blank coordinates, once", () => {
    const csv = [HEADER.join(","), row("401 Bleecker St", "nyc").map((value) => (value.includes(",") ? `"${value}"` : value)).join(",")].join("\n");
    const parsed = parse_venue_csv(csv, new Date("2026-11-01T00:00:00Z"));
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toMatch(/db:geocode:venues/);
  });

  test("CSV output quotes commas, quotes and newlines", () => {
    expect(to_csv([["a", 'say "hi"', "x,y", null, 1.5]])).toBe('a,"say ""hi""","x,y",,1.5\n');
  });
});
