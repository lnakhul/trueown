import type { MarketConfig } from "@/lib/markets/config";

/**
 * Fills blank latitude/longitude in a venues CSV from the street address, for a
 * researcher to review before importing. Only exact (house-number) matches inside
 * the row's market are filled; anything vaguer is left blank and reported, because
 * a storefront pinned to the middle of a street can point people to the wrong shop.
 */

export interface GeocodeCandidate {
  latitude: number;
  longitude: number;
  display_name: string;
  /** Nominatim addresstype, e.g. "building", "house", "shop", "road", "suburb". */
  address_type: string;
  house_number: string | null;
}

export type GeocodeStatus = "kept" | "filled" | "needs_review" | "not_found" | "error";

export interface GeocodeOutcome {
  line: number;
  brand_name: string;
  address: string;
  status: GeocodeStatus;
  query: string | null;
  matched: string | null;
  latitude: number | null;
  longitude: number | null;
  note: string;
}

/** Looks up an address; `market` narrows the search to that market's area. */
export type GeocodeLookup = (query: string, market: MarketConfig | null) => Promise<GeocodeCandidate[]>;

export const MARKET_SEARCH_RADIUS_METERS = 80_467;
const EARTH_RADIUS_METERS = 6_371_000;

/** "28-01 24th Ave" -> "28-01", "186 W 4th St" -> "186", "Pier 17" -> null. */
export function leading_house_number(address: string): string | null {
  const match = /^\s*(\d+[a-z]?(?:\s*-\s*\d+[a-z]?)?)\s+\S/i.exec(address);
  return match?.[1] ? normalise_house_number(match[1]) : null;
}

function normalise_house_number(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

export function distance_meters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const to_radians = (degrees: number) => (degrees * Math.PI) / 180;
  const d_lat = to_radians(b.latitude - a.latitude);
  const d_lng = to_radians(b.longitude - a.longitude);
  const h =
    Math.sin(d_lat / 2) ** 2 +
    Math.cos(to_radians(a.latitude)) * Math.cos(to_radians(b.latitude)) * Math.sin(d_lng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}

/**
 * Exact = the result carries the same house number the row asked for. A result
 * without one (a street, neighborhood or city centroid) is never good enough.
 */
export function is_exact_match(address: string, candidate: GeocodeCandidate): boolean {
  const wanted = leading_house_number(address);
  if (!wanted || !candidate.house_number) return false;
  return normalise_house_number(candidate.house_number) === wanted;
}

/** Adds the market's city when the address does not already name it. */
export function build_geocode_query(address: string, market: MarketConfig | null): string {
  const trimmed = address.replace(/\s+/g, " ").trim();
  if (!market) return trimmed;
  const mentions_city = [market.city_label, market.city_name].some((name) =>
    trimmed.toLowerCase().includes(name.toLowerCase()),
  );
  return mentions_city ? trimmed : `${trimmed}, ${market.city_label}`;
}

export interface CsvTable {
  header: string[];
  records: Array<{ line: number; cells: string[] }>;
}

function cell(table: CsvTable, cells: string[], column: string): string {
  const index = table.header.indexOf(column);
  return index === -1 ? "" : (cells[index] ?? "").trim();
}

/**
 * Geocodes every row whose latitude AND longitude are blank. Rows that already have
 * coordinates are kept untouched. Returns the updated rows and one outcome per row.
 */
export async function geocode_venue_table(
  table: CsvTable,
  markets: MarketConfig[],
  lookup: GeocodeLookup,
): Promise<{ table: CsvTable; outcomes: GeocodeOutcome[] }> {
  const latitude_index = table.header.indexOf("latitude");
  const longitude_index = table.header.indexOf("longitude");
  if (latitude_index === -1 || longitude_index === -1 || !table.header.includes("address")) {
    throw new Error("The CSV needs address, latitude and longitude columns (see data/templates/venues_template.csv).");
  }

  const outcomes: GeocodeOutcome[] = [];
  const records: CsvTable["records"] = [];

  for (const record of table.records) {
    const cells = [...record.cells];
    const brand_name = cell(table, cells, "brand_name");
    const address = cell(table, cells, "address");
    const base = { line: record.line, brand_name, address };
    const has_latitude = (cells[latitude_index] ?? "").trim() !== "";
    const has_longitude = (cells[longitude_index] ?? "").trim() !== "";

    if (has_latitude || has_longitude) {
      outcomes.push({
        ...base,
        status: has_latitude && has_longitude ? "kept" : "needs_review",
        query: null,
        matched: null,
        latitude: null,
        longitude: null,
        note: has_latitude && has_longitude ? "Already has coordinates." : "Only one of latitude/longitude is filled.",
      });
      records.push({ line: record.line, cells });
      continue;
    }

    const market_slug = cell(table, cells, "market").toLowerCase();
    const market = market_slug ? (markets.find((candidate) => candidate.slug === market_slug) ?? null) : null;
    if (market_slug && !market) {
      outcomes.push({ ...base, status: "needs_review", query: null, matched: null, latitude: null, longitude: null, note: `Unknown market "${market_slug}".` });
      records.push({ line: record.line, cells });
      continue;
    }
    if (!address) {
      outcomes.push({ ...base, status: "needs_review", query: null, matched: null, latitude: null, longitude: null, note: "No address to look up." });
      records.push({ line: record.line, cells });
      continue;
    }
    if (!leading_house_number(address)) {
      outcomes.push({
        ...base,
        status: "needs_review",
        query: null,
        matched: null,
        latitude: null,
        longitude: null,
        note: "Address has no house number, so it cannot be matched exactly. Add coordinates by hand.",
      });
      records.push({ line: record.line, cells });
      continue;
    }

    const query = build_geocode_query(address, market);
    let candidates: GeocodeCandidate[];
    try {
      candidates = await lookup(query, market);
    } catch (caught_error) {
      outcomes.push({
        ...base,
        status: "error",
        query,
        matched: null,
        latitude: null,
        longitude: null,
        note: caught_error instanceof Error ? caught_error.message : "Lookup failed.",
      });
      records.push({ line: record.line, cells });
      continue;
    }

    const exact = candidates.find((candidate) => is_exact_match(address, candidate)) ?? null;
    const best = exact ?? candidates[0] ?? null;
    if (!best) {
      outcomes.push({ ...base, status: "not_found", query, matched: null, latitude: null, longitude: null, note: "No match." });
      records.push({ line: record.line, cells });
      continue;
    }

    const outside_market =
      market !== null && distance_meters(best, market.center) > MARKET_SEARCH_RADIUS_METERS;
    if (!exact || outside_market) {
      outcomes.push({
        ...base,
        status: "needs_review",
        query,
        matched: best.display_name,
        latitude: best.latitude,
        longitude: best.longitude,
        note: outside_market
          ? `Best match is outside ${market!.city_name}; check the address.`
          : `Only a ${best.address_type || "partial"} match (no exact house number); check it on a map before using.`,
      });
      records.push({ line: record.line, cells });
      continue;
    }

    cells[latitude_index] = exact.latitude.toFixed(6);
    cells[longitude_index] = exact.longitude.toFixed(6);
    outcomes.push({
      ...base,
      status: "filled",
      query,
      matched: exact.display_name,
      latitude: exact.latitude,
      longitude: exact.longitude,
      note: "Exact house-number match.",
    });
    records.push({ line: record.line, cells });
  }

  return { table: { header: table.header, records }, outcomes };
}

/** RFC 4180 CSV cell. */
export function csv_cell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function to_csv(rows: Array<Array<string | number | null>>): string {
  return `${rows.map((row) => row.map(csv_cell).join(",")).join("\n")}\n`;
}

/* ------------------------------------------------------------------------- */
/* Nominatim                                                                    */
/* ------------------------------------------------------------------------- */

interface NominatimResult {
  lat?: unknown;
  lon?: unknown;
  display_name?: unknown;
  addresstype?: unknown;
  address?: { house_number?: unknown };
}

/** A bounding box around the market (about its 50-mile radius) that results must fall in. */
export function market_viewbox(market: MarketConfig): string {
  const lat_delta = MARKET_SEARCH_RADIUS_METERS / 111_320;
  const lng_delta = lat_delta / Math.cos((market.center.latitude * Math.PI) / 180);
  const { latitude, longitude } = market.center;
  return [longitude - lng_delta, latitude + lat_delta, longitude + lng_delta, latitude - lat_delta]
    .map((value) => value.toFixed(5))
    .join(",");
}

export function parse_nominatim_results(payload: unknown): GeocodeCandidate[] {
  if (!Array.isArray(payload)) throw new Error("Geocoder returned a malformed response.");
  return payload.flatMap((raw: NominatimResult) => {
    const latitude = Number(raw.lat);
    const longitude = Number(raw.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
    const house_number = raw.address?.house_number;
    return [
      {
        latitude,
        longitude,
        display_name: typeof raw.display_name === "string" ? raw.display_name : "",
        address_type: typeof raw.addresstype === "string" ? raw.addresstype : "",
        house_number: typeof house_number === "string" || typeof house_number === "number" ? String(house_number) : null,
      },
    ];
  });
}

export function nominatim_search_url(base_url: string, query: string, market: MarketConfig | null): URL {
  const url = new URL("/search", base_url);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "3");
  url.searchParams.set("countrycodes", "us");
  if (market) {
    url.searchParams.set("viewbox", market_viewbox(market));
    url.searchParams.set("bounded", "1");
  }
  return url;
}
