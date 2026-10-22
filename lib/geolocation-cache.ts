import type { NearbyResponse } from "@/lib/types";

/** Strict 15-minute expiry for the cached discovery state. */
export const GEOLOCATION_CACHE_TTL_MS = 15 * 60 * 1000;
/** Bump the version whenever the cached payload shape changes (v2: financial_backers). */
export const GEOLOCATION_CACHE_KEY = "trueown:discovery:v2";

/** Where the cached payload came from; decides whether we skip the permission prompt. */
export type CachedDiscoverySource = "device" | "neighborhood";

export interface CachedDiscoveryState {
  saved_at_ms: number;
  source: CachedDiscoverySource;
  payload: NearbyResponse;
}

/** Minimal Storage surface so the cache can be tested without a browser. */
export type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function is_finite_number(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Structural guard: never trust data read back from localStorage. */
function is_cached_discovery_state(value: unknown): value is CachedDiscoveryState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (!is_finite_number(candidate.saved_at_ms)) return false;
  if (candidate.source !== "device" && candidate.source !== "neighborhood") return false;

  const payload = candidate.payload as Record<string, unknown> | null;
  if (typeof payload !== "object" || payload === null) return false;
  if (!Array.isArray(payload.results) || !Array.isArray(payload.origin_alternatives)) return false;

  const origin = payload.origin as Record<string, unknown> | null;
  if (typeof origin !== "object" || origin === null) return false;
  return (
    (origin.kind === "coordinates" || origin.kind === "neighborhood") &&
    is_finite_number(origin.latitude) &&
    is_finite_number(origin.longitude)
  );
}

/**
 * Returns the cached state if present, well-formed, and younger than the TTL.
 * Expired, corrupt, or future-dated entries are deleted and treated as a miss.
 * Any storage failure (privacy mode, disabled storage) is a miss, never a crash.
 */
export function read_cached_discovery(
  storage: KeyValueStorage,
  now_ms: number = Date.now(),
): CachedDiscoveryState | null {
  try {
    const raw_value = storage.getItem(GEOLOCATION_CACHE_KEY);
    if (raw_value === null) return null;

    const parsed_value: unknown = JSON.parse(raw_value);
    if (!is_cached_discovery_state(parsed_value)) {
      storage.removeItem(GEOLOCATION_CACHE_KEY);
      return null;
    }

    const age_ms = now_ms - parsed_value.saved_at_ms;
    if (age_ms < 0 || age_ms >= GEOLOCATION_CACHE_TTL_MS) {
      storage.removeItem(GEOLOCATION_CACHE_KEY);
      return null;
    }
    return parsed_value;
  } catch {
    // Unparseable or inaccessible entry: drop it best-effort and treat as a miss.
    clear_cached_discovery(storage);
    return null;
  }
}

/** Best-effort write; quota or privacy-mode errors are swallowed on purpose. */
export function write_cached_discovery(
  storage: KeyValueStorage,
  source: CachedDiscoverySource,
  payload: NearbyResponse,
  now_ms: number = Date.now(),
): void {
  try {
    const state: CachedDiscoveryState = { saved_at_ms: now_ms, source, payload };
    storage.setItem(GEOLOCATION_CACHE_KEY, JSON.stringify(state));
  } catch {
    // Caching is a performance optimisation only.
  }
}

export function clear_cached_discovery(storage: KeyValueStorage): void {
  try {
    storage.removeItem(GEOLOCATION_CACHE_KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

/** Resolves window.localStorage safely (it can throw when access is blocked). */
export function get_browser_storage(): KeyValueStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
