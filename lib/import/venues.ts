import { parse } from "csv-parse/sync";
import type { Pool, PoolClient } from "pg";
import { INDUSTRY_VERTICALS, type IndustryVertical } from "@/lib/types";
import { validate_evidence_url } from "@/lib/validation";

/** Exact header the importer accepts; mirrored by data/templates/venues_template.csv. */
export const VENUE_CSV_COLUMNS = [
  "brand_name",
  "industry_vertical",
  "corporate_tier",
  "parent_entity",
  "unique_selling_proposition",
  "ownership_source_type",
  "ownership_source_url",
  "ownership_verified_on",
  "address",
  "neighborhood",
  "city",
  "latitude",
  "longitude",
] as const;

export type VenueCsvColumn = (typeof VENUE_CSV_COLUMNS)[number];

export { INDUSTRY_VERTICALS };

/**
 * Where each tier may be verified. Must stay in sync with the CHECK constraint on
 * brands.ownership_source_type. Tier 1/2 claims need corporate-record evidence;
 * Tier 3 claims need registry, editorial or community evidence.
 */
export const CORPORATE_SOURCE_TYPES = [
  "sec_edgar",
  "investor_press_release",
  "pitchbook",
  "crunchbase",
  "mergr",
  "reputable_news",
] as const;
export const INDEPENDENT_SOURCE_TYPES = [
  "nys_dos_corporations",
  "eater_ny",
  "community_consensus",
] as const;

export const DEFAULT_CITY = "New York";
export const MAX_CSV_ROWS = 5000;
export const MAX_CSV_BYTES = 2 * 1024 * 1024;

export interface VenueRow {
  line: number;
  brand_name: string;
  industry_vertical: IndustryVertical;
  corporate_tier: 1 | 2 | 3;
  parent_entity: string | null;
  unique_selling_proposition: string | null;
  ownership_source_type: string;
  ownership_source_url: string;
  ownership_verified_on: string;
  address: string;
  neighborhood: string | null;
  city: string;
  latitude: number;
  longitude: number;
}

export interface VenueParseResult {
  rows: VenueRow[];
  errors: string[];
}

const DECIMAL_PATTERN = /^-?\d{1,3}(\.\d+)?$/;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function collapse_whitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function is_real_past_date(value: string, today: Date): boolean {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  const is_real =
    parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
  return is_real && year >= 2000 && parsed.getTime() <= today.getTime();
}

function brand_key(row: Pick<VenueRow, "brand_name" | "industry_vertical">): string {
  return `${row.brand_name.toLowerCase()}|${row.industry_vertical}`;
}

/**
 * Parses and fully validates a venues CSV. Every problem is reported with its
 * line number so a researcher can fix the whole file in one pass; callers must
 * treat any error as "import nothing".
 */
export function parse_venue_csv(text: string, today: Date = new Date()): VenueParseResult {
  const errors: string[] = [];
  const rows: VenueRow[] = [];

  if (text.length > MAX_CSV_BYTES) {
    return { rows, errors: [`File is larger than ${MAX_CSV_BYTES / 1024 / 1024} MB.`] };
  }

  let records: Array<{ record: string[]; info: { lines: number } }>;
  try {
    records = parse(text, {
      bom: true,
      skip_empty_lines: true,
      trim: true,
      info: true,
      relax_column_count: false,
    }) as unknown as Array<{ record: string[]; info: { lines: number } }>;
  } catch (caught_error) {
    const message = caught_error instanceof Error ? caught_error.message : "unreadable file";
    return { rows, errors: [`CSV could not be parsed: ${message}`] };
  }

  const header = records[0]?.record;
  if (!header) return { rows, errors: ["File is empty: header row is missing."] };

  const header_problems: string[] = [];
  VENUE_CSV_COLUMNS.forEach((column) => {
    if (!header.includes(column)) header_problems.push(`missing column "${column}"`);
  });
  header.forEach((column) => {
    if (!(VENUE_CSV_COLUMNS as readonly string[]).includes(column)) {
      header_problems.push(`unknown column "${column}"`);
    }
  });
  if (new Set(header).size !== header.length) header_problems.push("duplicate column names");
  if (header_problems.length > 0) {
    return { rows, errors: [`Header does not match the template: ${header_problems.join("; ")}.`] };
  }

  const data_records = records.slice(1);
  if (data_records.length > MAX_CSV_ROWS) {
    return { rows, errors: [`File has ${data_records.length} rows; the limit is ${MAX_CSV_ROWS}.`] };
  }

  const first_row_by_brand = new Map<string, VenueRow>();
  const first_line_by_location = new Map<string, number>();

  data_records.forEach(({ record, info }) => {
    const line = info.lines;
    const cell = (column: VenueCsvColumn): string => collapse_whitespace(record[header.indexOf(column)] ?? "");
    const row_errors: string[] = [];
    const fail = (message: string): void => {
      row_errors.push(`Line ${line}: ${message}`);
    };

    const brand_name = cell("brand_name");
    if (!brand_name) fail("brand_name is required.");
    if (brand_name.length > 200) fail("brand_name is longer than 200 characters.");

    const industry_vertical = cell("industry_vertical");
    if (!(INDUSTRY_VERTICALS as readonly string[]).includes(industry_vertical)) {
      fail(`industry_vertical must be one of: ${INDUSTRY_VERTICALS.join(", ")}.`);
    }

    const tier_text = cell("corporate_tier");
    if (!/^[123]$/.test(tier_text)) fail("corporate_tier must be 1, 2 or 3.");
    const corporate_tier = Number(tier_text) as 1 | 2 | 3;

    const parent_entity = cell("parent_entity");
    if (corporate_tier === 3 && parent_entity) {
      fail("parent_entity must be blank for Tier 3 independents.");
    }
    if ((corporate_tier === 1 || corporate_tier === 2) && !parent_entity) {
      fail("parent_entity is required for Tier 1 and Tier 2 brands.");
    }
    if (parent_entity.length > 200) fail("parent_entity is longer than 200 characters.");

    const unique_selling_proposition = cell("unique_selling_proposition");
    if (unique_selling_proposition.length > 300) {
      fail("unique_selling_proposition is longer than 300 characters.");
    }

    const source_type = cell("ownership_source_type");
    const allowed_sources: readonly string[] =
      corporate_tier === 3 ? INDEPENDENT_SOURCE_TYPES : CORPORATE_SOURCE_TYPES;
    if (/^[123]$/.test(tier_text) && !allowed_sources.includes(source_type)) {
      fail(
        `ownership_source_type for Tier ${corporate_tier} must be one of: ${allowed_sources.join(", ")}.`,
      );
    }

    const source_url = validate_evidence_url(cell("ownership_source_url"));
    if (!source_url.valid) fail(`ownership_source_url: ${source_url.reason}`);

    const verified_on = cell("ownership_verified_on");
    if (!is_real_past_date(verified_on, today)) {
      fail("ownership_verified_on must be a real past date formatted YYYY-MM-DD.");
    }

    const address = cell("address");
    if (!address) fail("address is required.");
    if (address.length > 300) fail("address is longer than 300 characters.");

    const neighborhood = cell("neighborhood");
    if (neighborhood.length > 100) fail("neighborhood is longer than 100 characters.");

    const city = cell("city") || DEFAULT_CITY;
    if (city.length > 100) fail("city is longer than 100 characters.");

    const latitude_text = cell("latitude");
    const longitude_text = cell("longitude");
    const latitude = Number(latitude_text);
    const longitude = Number(longitude_text);
    if (!DECIMAL_PATTERN.test(latitude_text) || Math.abs(latitude) > 90) {
      fail("latitude must be a decimal between -90 and 90.");
    }
    if (!DECIMAL_PATTERN.test(longitude_text) || Math.abs(longitude) > 180) {
      fail("longitude must be a decimal between -180 and 180.");
    }
    if (latitude === 0 && longitude === 0) fail("coordinates 0,0 are a geocoder failure, not a location.");

    if (row_errors.length > 0) {
      errors.push(...row_errors);
      return;
    }

    const row: VenueRow = {
      line,
      brand_name,
      industry_vertical: industry_vertical as IndustryVertical,
      corporate_tier,
      parent_entity: parent_entity || null,
      unique_selling_proposition: unique_selling_proposition || null,
      ownership_source_type: source_type,
      ownership_source_url: source_url.valid ? source_url.normalized_url : "",
      ownership_verified_on: verified_on,
      address,
      neighborhood: neighborhood || null,
      city,
      latitude,
      longitude,
    };

    // Every row of a brand must agree, otherwise the dataset contradicts itself.
    const brand_id = brand_key(row);
    const first_for_brand = first_row_by_brand.get(brand_id);
    if (first_for_brand) {
      const compared: Array<keyof VenueRow> = [
        "corporate_tier",
        "parent_entity",
        "unique_selling_proposition",
        "ownership_source_type",
        "ownership_source_url",
        "ownership_verified_on",
      ];
      compared.forEach((field) => {
        if (first_for_brand[field] !== row[field]) {
          errors.push(
            `Line ${line}: ${field} for "${brand_name}" conflicts with line ${first_for_brand.line}.`,
          );
        }
      });
    } else {
      first_row_by_brand.set(brand_id, row);
    }

    const location_id = `${brand_id}|${address.toLowerCase()}`;
    const first_line = first_line_by_location.get(location_id);
    if (first_line !== undefined) {
      errors.push(`Line ${line}: duplicate storefront "${brand_name}" at "${address}" (first on line ${first_line}).`);
    } else {
      first_line_by_location.set(location_id, line);
    }
    rows.push(row);
  });

  if (errors.length === 0 && rows.length === 0) errors.push("File has a header but no data rows.");
  return { rows, errors };
}

export interface VenueImportSummary {
  brands_created: number;
  brands_updated: number;
  locations_created: number;
  locations_skipped: number;
  warnings: string[];
  errors: string[];
}

type Queryable = Pick<PoolClient, "query">;

async function has_boundaries(client: Queryable, city: string, cache: Map<string, boolean>): Promise<boolean> {
  const cached = cache.get(city);
  if (cached !== undefined) return cached;
  const result = await client.query<{ present: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM neighborhood_boundaries WHERE city = $1) AS present",
    [city],
  );
  const present = result.rows[0]?.present === true;
  cache.set(city, present);
  return present;
}

/**
 * Loads validated rows in a single transaction: all brands and storefronts are
 * written, or none are. dry_run runs every statement (so constraints and
 * coordinate checks are real) and then rolls back.
 */
export async function import_venues(
  pool: Pool,
  rows: VenueRow[],
  options: { dry_run?: boolean } = {},
): Promise<VenueImportSummary> {
  const summary: VenueImportSummary = {
    brands_created: 0,
    brands_updated: 0,
    locations_created: 0,
    locations_skipped: 0,
    warnings: [],
    errors: [],
  };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const boundary_cache = new Map<string, boolean>();
    const market_warnings = new Set<string>();
    const brand_ids = new Map<string, string | null>();

    for (const row of rows) {
      const key = brand_key(row);
      if (!brand_ids.has(key)) {
        // The WHERE clause refuses to rewrite a live brand whose tier differs.
        const brand_result = await client.query<{ id: string; inserted: boolean }>(
          `INSERT INTO brands (name, corporate_tier, industry_vertical, parent_entity,
                               unique_selling_proposition, ownership_source_type,
                               ownership_source_url, ownership_verified_on)
           VALUES ($1, $2, $3::industry_vertical, $4, $5, $6, $7, $8)
           ON CONFLICT (lower(btrim(name)), industry_vertical) DO UPDATE
             SET parent_entity = EXCLUDED.parent_entity,
                 unique_selling_proposition =
                   COALESCE(EXCLUDED.unique_selling_proposition, brands.unique_selling_proposition),
                 ownership_source_type = EXCLUDED.ownership_source_type,
                 ownership_source_url = EXCLUDED.ownership_source_url,
                 ownership_verified_on = EXCLUDED.ownership_verified_on
             WHERE brands.corporate_tier = EXCLUDED.corporate_tier
           RETURNING id, (xmax = 0) AS inserted`,
          [
            row.brand_name,
            row.corporate_tier,
            row.industry_vertical,
            row.parent_entity,
            row.unique_selling_proposition,
            row.ownership_source_type,
            row.ownership_source_url,
            row.ownership_verified_on,
          ],
        );
        const brand_row = brand_result.rows[0];
        if (!brand_row) {
          summary.errors.push(
            `Line ${row.line}: "${row.brand_name}" already exists with a different corporate tier; resolve it manually before importing.`,
          );
          brand_ids.set(key, null);
          continue;
        }
        brand_ids.set(key, brand_row.id);
        if (brand_row.inserted) summary.brands_created += 1;
        else summary.brands_updated += 1;
      }

      const brand_id = brand_ids.get(key);
      if (!brand_id) continue;

      let neighborhood = row.neighborhood;
      if (await has_boundaries(client, row.city, boundary_cache)) {
        const resolved = await client.query<{ name: string; distance_meters: number }>(
          "SELECT name, distance_meters FROM resolve_neighborhood($1, $2, $3)",
          [row.longitude, row.latitude, row.city],
        );
        const match = resolved.rows[0];
        if (!match) {
          summary.errors.push(
            `Line ${row.line}: (${row.latitude}, ${row.longitude}) is not inside any ${row.city} neighborhood boundary. Are latitude and longitude swapped?`,
          );
          continue;
        }
        if (!neighborhood) {
          neighborhood = match.name;
        } else if (!match.name.toLowerCase().includes(neighborhood.toLowerCase())) {
          summary.warnings.push(
            `Line ${row.line}: neighborhood "${neighborhood}" differs from the boundary containing the point ("${match.name}"); kept the CSV value.`,
          );
        }
      } else {
        summary.warnings.push(
          `Line ${row.line}: no neighborhood boundaries are loaded for "${row.city}", so coordinates were not sanity-checked.`,
        );
      }

      const market_result = await client.query<{ city_name: string; status: string }>(
        `SELECT city_name, status FROM markets
          WHERE ST_DWithin(geographic_center::geography,
                           ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 80467.2)
          ORDER BY ST_Distance(geographic_center::geography,
                               ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography)
          LIMIT 1`,
        [row.longitude, row.latitude],
      );
      const market = market_result.rows[0];
      if (!market) {
        summary.errors.push(
          `Line ${row.line}: (${row.latitude}, ${row.longitude}) is not within 50 miles of any market. Add the city to the markets table first.`,
        );
        continue;
      }
      if (market.status !== "active" && !market_warnings.has(market.city_name)) {
        market_warnings.add(market.city_name);
        summary.warnings.push(
          `Market "${market.city_name}" is '${market.status}': rows are stored but not served until it is set to 'active'.`,
        );
      }

      const location_result = await client.query(
        `INSERT INTO locations (brand_id, address, neighborhood, city, coordinates)
         VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326))
         ON CONFLICT (brand_id, lower(btrim(address))) DO NOTHING`,
        [brand_id, row.address, neighborhood, row.city, row.longitude, row.latitude],
      );
      if (location_result.rowCount === 1) summary.locations_created += 1;
      else summary.locations_skipped += 1;
    }

    const should_commit = summary.errors.length === 0 && !options.dry_run;
    await client.query(should_commit ? "COMMIT" : "ROLLBACK");
    return summary;
  } catch (caught_error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw caught_error;
  } finally {
    client.release();
  }
}
