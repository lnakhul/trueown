import { createHash } from "node:crypto";
import { create_shared_rate_limiter } from "@/lib/rate-limit-shared";

/**
 * Server-side geocoding fallback for free-text searches that are not a tracked
 * neighborhood (e.g. a full street address).
 *
 * - Provider: Nominatim (OpenStreetMap). Its usage policy requires an identifying
 *   User-Agent, at most 1 request/second, and caching of results; all three are enforced here.
 * - Cache: Upstash Redis REST (shared across serverless instances) with a strict 30-day TTL.
 *   Keys are a SHA-256 of the normalised query, so raw addresses are never stored in Redis.
 *   Without Upstash (or when it is unreachable) a bounded in-process cache is used.
 * - Failures never throw to callers as anything but GeocoderUnavailableError.
 */

export const GEOCODE_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Unresolvable queries are remembered briefly so typos don't hammer the provider. */
export const GEOCODE_MISS_TTL_SECONDS = 24 * 60 * 60;

const DEFAULT_GEOCODER_BASE_URL = "https://nominatim.openstreetmap.org";
const DEFAULT_USER_AGENT = "TrueOwn/0.1 (+https://github.com/lnakhul/trueown)";
const GEOCODER_TIMEOUT_MS = 4000;
const REDIS_TIMEOUT_MS = 1500;
const MEMORY_CACHE_MAX_ENTRIES = 500;
const MAX_QUERY_LENGTH = 200;

export interface GeocodedPoint {
  latitude: number;
  longitude: number;
}

/** null = the provider answered but knows no such place. */
export type GeocodeResult = GeocodedPoint | null;

export class GeocoderUnavailableError extends Error {
  constructor(reason: string) {
    super(`Geocoder unavailable: ${reason}`);
    this.name = "GeocoderUnavailableError";
  }
}

/**
 * A house-number-first street address, e.g. "45-02 11th St, Long Island City, NY".
 * Anything else is tried as a neighborhood name first.
 */
export function looks_like_street_address(text: string): boolean {
  return /^\d+[a-z]?(?:-\d+)?\s+\S+/i.test(text.trim());
}

function normalise_query(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

export function geocode_cache_key(query: string): string {
  const digest = createHash("sha256").update(normalise_query(query)).digest("hex");
  return `trueown:geocode:v1:${digest}`;
}

function is_valid_point(latitude: unknown, longitude: unknown): boolean {
  return (
    typeof latitude === "number" &&
    typeof longitude === "number" &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  );
}

/* ------------------------------------------------------------------------- */
/* Cache: Upstash Redis REST with an in-process fallback                       */
/* ------------------------------------------------------------------------- */

interface RedisConfig {
  url: string;
  token: string;
}

function redis_config(): RedisConfig | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? { url: parsed.origin, token } : null;
  } catch {
    return null;
  }
}

async function redis_command(config: RedisConfig, command: string[]): Promise<unknown> {
  const response = await fetch(config.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Redis responded ${response.status}`);
  const payload = (await response.json()) as { result?: unknown; error?: string };
  if (payload.error) throw new Error("Redis command failed");
  return payload.result;
}

const memory_cache = new Map<string, { value: GeocodeResult; expires_at_ms: number }>();

/** Test hook: empties the in-process fallback cache. */
export function clear_geocode_memory_cache(): void {
  memory_cache.clear();
}

function memory_get(key: string): { value: GeocodeResult } | null {
  const entry = memory_cache.get(key);
  if (!entry) return null;
  if (entry.expires_at_ms <= Date.now()) {
    memory_cache.delete(key);
    return null;
  }
  return { value: entry.value };
}

function memory_set(key: string, value: GeocodeResult, ttl_seconds: number): void {
  if (memory_cache.size >= MEMORY_CACHE_MAX_ENTRIES) {
    const oldest_key = memory_cache.keys().next().value;
    if (oldest_key !== undefined) memory_cache.delete(oldest_key);
  }
  memory_cache.set(key, { value, expires_at_ms: Date.now() + ttl_seconds * 1000 });
}

function parse_cached_value(raw_value: unknown): { value: GeocodeResult } | null {
  if (typeof raw_value !== "string") return null;
  try {
    const parsed = JSON.parse(raw_value) as { miss?: boolean; lat?: unknown; lng?: unknown };
    if (parsed.miss === true) return { value: null };
    if (is_valid_point(parsed.lat, parsed.lng)) {
      return { value: { latitude: parsed.lat as number, longitude: parsed.lng as number } };
    }
  } catch {
    // Corrupt entry: treated as a cache miss.
  }
  return null;
}

async function cache_get(key: string): Promise<{ value: GeocodeResult } | null> {
  const local = memory_get(key);
  if (local) return local;
  const config = redis_config();
  if (!config) return null;
  try {
    const hit = parse_cached_value(await redis_command(config, ["GET", key]));
    if (hit) memory_set(key, hit.value, GEOCODE_MISS_TTL_SECONDS);
    return hit;
  } catch {
    return null;
  }
}

async function cache_set(key: string, value: GeocodeResult): Promise<void> {
  const ttl_seconds = value === null ? GEOCODE_MISS_TTL_SECONDS : GEOCODE_CACHE_TTL_SECONDS;
  memory_set(key, value, ttl_seconds);
  const config = redis_config();
  if (!config) return;
  const serialised = JSON.stringify(value === null ? { miss: true } : { lat: value.latitude, lng: value.longitude });
  try {
    await redis_command(config, ["SET", key, serialised, "EX", String(ttl_seconds)]);
  } catch {
    // The in-process copy still serves this instance; the provider is simply asked again elsewhere.
  }
}

/* ------------------------------------------------------------------------- */
/* Provider                                                                    */
/* ------------------------------------------------------------------------- */

/** Provider origin (GEOCODER_BASE_URL, https only; defaults to Nominatim). Shared with the import CLI. */
export function geocoder_base_url(): string {
  const configured = process.env.GEOCODER_BASE_URL?.trim();
  if (!configured) return DEFAULT_GEOCODER_BASE_URL;
  try {
    const parsed = new URL(configured);
    return parsed.protocol === "https:" ? parsed.origin : DEFAULT_GEOCODER_BASE_URL;
  } catch {
    return DEFAULT_GEOCODER_BASE_URL;
  }
}

/** Identifying User-Agent required by the Nominatim usage policy. */
export function geocoder_user_agent(): string {
  return process.env.GEOCODER_USER_AGENT?.trim() || DEFAULT_USER_AGENT;
}

function max_provider_requests_per_second(): number {
  const configured = Number(process.env.GEOCODER_MAX_REQUESTS_PER_SECOND);
  return Number.isInteger(configured) && configured >= 1 ? configured : 1;
}

let provider_limiter: ReturnType<typeof create_shared_rate_limiter> | null = null;

async function reserve_provider_slot(): Promise<void> {
  provider_limiter ??= create_shared_rate_limiter("geocoder", max_provider_requests_per_second(), 1000);
  const decision = await provider_limiter.check("global");
  if (!decision.allowed) throw new GeocoderUnavailableError("provider rate limit reached");
}

async function query_provider(query: string): Promise<GeocodeResult> {
  await reserve_provider_slot();

  const url = new URL("/search", geocoder_base_url());
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  url.searchParams.set("countrycodes", "us");

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": geocoder_user_agent(),
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(GEOCODER_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    throw new GeocoderUnavailableError("request failed");
  }
  if (!response.ok) throw new GeocoderUnavailableError(`provider responded ${response.status}`);

  let candidates: unknown;
  try {
    candidates = await response.json();
  } catch {
    throw new GeocoderUnavailableError("malformed response");
  }
  if (!Array.isArray(candidates)) throw new GeocoderUnavailableError("malformed response");
  if (candidates.length === 0) return null;

  const first = candidates[0] as { lat?: unknown; lon?: unknown };
  const latitude = Number(first.lat);
  const longitude = Number(first.lon);
  if (!is_valid_point(latitude, longitude)) throw new GeocoderUnavailableError("malformed response");
  return { latitude, longitude };
}

/**
 * Resolves free text to a point: cache first, then the provider.
 * Resolves to null when the place is unknown; throws GeocoderUnavailableError when the
 * provider cannot answer (so callers can tell "no such place" from "try again later").
 */
export async function geocode_text(query: string): Promise<GeocodeResult> {
  const normalised = normalise_query(query);
  if (normalised.length === 0 || normalised.length > MAX_QUERY_LENGTH) return null;

  const key = geocode_cache_key(normalised);
  const cached = await cache_get(key);
  if (cached) return cached.value;

  const resolved = await query_provider(normalised);
  await cache_set(key, resolved);
  return resolved;
}
