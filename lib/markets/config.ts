import { existsSync, readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import type { MarketStatus } from "@/lib/types";

/**
 * Per-market configuration, one file per market at data/markets/<slug>/market.json.
 * It is the hook for adding a city: center + status for the `markets` table and,
 * optionally, where its official neighborhood polygons come from.
 */
export const MARKETS_DIRECTORY = resolve("data/markets");
export const MARKET_CONFIG_FILE = "market.json";

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PROPERTY_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MARKET_STATUSES: readonly MarketStatus[] = ["active", "coming_soon"];

/** Which GeoJSON feature properties hold each boundary field. */
export interface BoundaryPropertyMap {
  code: string;
  name: string;
  borough: string | null;
  area_type: string | null;
}

export interface BoundarySourceConfig {
  /** Stable id stored in neighborhood_boundaries.source (with source_code, makes re-imports idempotent). */
  source_id: string;
  dataset: string;
  publisher: string;
  download_url: string;
  /** Repo-relative path of a committed, normalized copy; null = must be downloaded first. */
  committed_file: string | null;
  properties: BoundaryPropertyMap;
  /** Some portals publish names in capitals ("ROGERS PARK"); "title" turns them into "Rogers Park". */
  name_case: "as_is" | "title";
  /** A file with fewer features than this is treated as truncated. */
  min_expected_features: number;
}

export interface MarketConfig {
  slug: string;
  /** Display name of the market ("New York City"). */
  city_name: string;
  /** Canonical locality label stored on every storefront in the market ("New York"). */
  city_label: string;
  status: MarketStatus;
  center: { latitude: number; longitude: number };
  boundaries: BoundarySourceConfig | null;
}

export type MarketConfigParse =
  | { valid: true; config: MarketConfig }
  | { valid: false; errors: string[] };

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bounded_text(value: unknown, max_length: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max_length ? trimmed : null;
}

function https_url(value: unknown): string | null {
  const text = bounded_text(value, 500);
  if (!text) return null;
  try {
    return new URL(text).protocol === "https:" ? text : null;
  } catch {
    return null;
  }
}

function parse_boundaries(raw: unknown, errors: string[]): BoundarySourceConfig | null {
  if (raw === undefined || raw === null) return null;
  if (!is_record(raw)) {
    errors.push("boundaries must be an object or null.");
    return null;
  }
  const source_id = bounded_text(raw.source_id, 64);
  if (!source_id || !/^[a-z0-9_]+$/.test(source_id)) errors.push("boundaries.source_id must be lowercase snake_case.");
  const dataset = bounded_text(raw.dataset, 200);
  if (!dataset) errors.push("boundaries.dataset is required.");
  const publisher = bounded_text(raw.publisher, 200);
  if (!publisher) errors.push("boundaries.publisher is required.");
  const download_url = https_url(raw.download_url);
  if (!download_url) errors.push("boundaries.download_url must be an https URL.");

  let committed_file: string | null = null;
  if (raw.committed_file !== undefined && raw.committed_file !== null) {
    committed_file = bounded_text(raw.committed_file, 300);
    if (!committed_file || !committed_file.startsWith("data/") || committed_file.includes("..")) {
      errors.push("boundaries.committed_file must be a path inside data/.");
      committed_file = null;
    }
  }

  const properties_raw = is_record(raw.properties) ? raw.properties : {};
  const property = (key: keyof BoundaryPropertyMap, required: boolean): string | null => {
    const value = properties_raw[key];
    if (value === undefined || value === null) {
      if (required) errors.push(`boundaries.properties.${key} is required.`);
      return null;
    }
    if (typeof value !== "string" || !PROPERTY_KEY_PATTERN.test(value)) {
      errors.push(`boundaries.properties.${key} must be a property name.`);
      return null;
    }
    return value;
  };
  const code = property("code", true);
  const name = property("name", true);
  const borough = property("borough", false);
  const area_type = property("area_type", false);

  const name_case = raw.name_case ?? "as_is";
  if (name_case !== "as_is" && name_case !== "title") errors.push('boundaries.name_case must be "as_is" or "title".');

  const min_expected_features = raw.min_expected_features;
  if (typeof min_expected_features !== "number" || !Number.isInteger(min_expected_features) || min_expected_features < 1) {
    errors.push("boundaries.min_expected_features must be a positive integer.");
  }

  if (!source_id || !dataset || !publisher || !download_url || !code || !name) return null;
  return {
    source_id,
    dataset,
    publisher,
    download_url,
    committed_file,
    properties: { code, name, borough, area_type },
    name_case: name_case as BoundarySourceConfig["name_case"],
    min_expected_features: min_expected_features as number,
  };
}

/** Strictly validates one market.json document. */
export function parse_market_config(raw: unknown, expected_slug?: string): MarketConfigParse {
  const errors: string[] = [];
  if (!is_record(raw)) return { valid: false, errors: ["market config must be a JSON object."] };

  const slug = bounded_text(raw.slug, 40);
  if (!slug || !SLUG_PATTERN.test(slug)) errors.push("slug must be lowercase letters, digits and single hyphens.");
  if (slug && expected_slug && slug !== expected_slug) {
    errors.push(`slug "${slug}" does not match its folder "${expected_slug}".`);
  }
  const city_name = bounded_text(raw.city_name, 100);
  if (!city_name) errors.push("city_name is required (max 100 characters).");
  const city_label = bounded_text(raw.city_label, 100);
  if (!city_label) errors.push("city_label is required (max 100 characters).");

  const status = raw.status;
  if (!MARKET_STATUSES.includes(status as MarketStatus)) errors.push('status must be "active" or "coming_soon".');

  const center = is_record(raw.center) ? raw.center : {};
  const latitude = center.latitude;
  const longitude = center.longitude;
  const valid_center =
    typeof latitude === "number" && typeof longitude === "number" &&
    Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 && !(latitude === 0 && longitude === 0);
  if (!valid_center) errors.push("center.latitude and center.longitude must be valid decimal degrees.");

  const boundaries = parse_boundaries(raw.boundaries, errors);

  if (errors.length > 0 || !slug || !city_name || !city_label || !valid_center) return { valid: false, errors };
  return {
    valid: true,
    config: {
      slug,
      city_name,
      city_label,
      status: status as MarketStatus,
      center: { latitude: latitude as number, longitude: longitude as number },
      boundaries,
    },
  };
}

/** Reads and validates every data/markets/<slug>/market.json. Any invalid file fails the whole load. */
export function load_market_configs(directory: string = MARKETS_DIRECTORY): MarketConfig[] {
  if (!existsSync(directory)) return [];
  const configs: MarketConfig[] = [];
  const problems: string[] = [];
  readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .forEach((folder) => {
      const file_path = join(directory, folder, MARKET_CONFIG_FILE);
      if (!existsSync(file_path)) return;
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(file_path, "utf8"));
      } catch {
        problems.push(`${folder}/${MARKET_CONFIG_FILE}: not valid JSON.`);
        return;
      }
      const parsed = parse_market_config(raw, folder);
      if (parsed.valid) configs.push(parsed.config);
      else parsed.errors.forEach((error) => problems.push(`${folder}/${MARKET_CONFIG_FILE}: ${error}`));
    });
  if (problems.length > 0) throw new Error(`Invalid market configuration:\n  ${problems.join("\n  ")}`);
  return configs;
}

export function find_market_config(slug: string, directory: string = MARKETS_DIRECTORY): MarketConfig {
  const config = load_market_configs(directory).find((candidate) => candidate.slug === slug);
  if (!config) throw new Error(`No market config for "${slug}" in ${directory}.`);
  return config;
}
