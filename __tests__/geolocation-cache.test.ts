import {
  GEOLOCATION_CACHE_KEY,
  GEOLOCATION_CACHE_TTL_MS,
  clear_cached_discovery,
  read_cached_discovery,
  write_cached_discovery,
  type KeyValueStorage,
} from "@/lib/geolocation-cache";
import type { NearbyResponse } from "@/lib/types";

/** In-memory Storage double. */
function create_storage(): KeyValueStorage & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
  };
}

const PAYLOAD: NearbyResponse = {
  origin: { kind: "coordinates", latitude: 40.7324, longitude: -74.0021 },
  radius_meters: 5000,
  results: [],
  origin_alternatives: [],
};

const SAVED_AT_MS = 1_000_000;

describe("geolocation cache (15 minute TTL)", () => {
  test("returns the cached payload inside the TTL window", () => {
    const storage = create_storage();
    write_cached_discovery(storage, "device", PAYLOAD, SAVED_AT_MS);
    const cached = read_cached_discovery(storage, SAVED_AT_MS + GEOLOCATION_CACHE_TTL_MS - 1);
    expect(cached?.source).toBe("device");
    expect(cached?.payload).toEqual(PAYLOAD);
  });

  test("expires exactly at 15 minutes and evicts the entry", () => {
    const storage = create_storage();
    write_cached_discovery(storage, "device", PAYLOAD, SAVED_AT_MS);
    expect(read_cached_discovery(storage, SAVED_AT_MS + GEOLOCATION_CACHE_TTL_MS)).toBeNull();
    expect(storage.entries.has(GEOLOCATION_CACHE_KEY)).toBe(false);
  });

  test("treats future-dated, corrupt, or malformed entries as a miss and evicts them", () => {
    const future = create_storage();
    write_cached_discovery(future, "device", PAYLOAD, SAVED_AT_MS + 60_000);
    expect(read_cached_discovery(future, SAVED_AT_MS)).toBeNull();

    for (const raw_value of [
      "not json",
      "null",
      JSON.stringify({ saved_at_ms: SAVED_AT_MS, source: "device" }),
      JSON.stringify({ saved_at_ms: SAVED_AT_MS, source: "evil", payload: PAYLOAD }),
      JSON.stringify({
        saved_at_ms: SAVED_AT_MS,
        source: "device",
        payload: { ...PAYLOAD, origin: { kind: "coordinates", latitude: "x", longitude: 1 } },
      }),
    ]) {
      const storage = create_storage();
      storage.setItem(GEOLOCATION_CACHE_KEY, raw_value);
      expect(read_cached_discovery(storage, SAVED_AT_MS + 1)).toBeNull();
      expect(storage.entries.has(GEOLOCATION_CACHE_KEY)).toBe(false);
    }
  });

  test("never throws when storage is unavailable", () => {
    const broken: KeyValueStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(read_cached_discovery(broken)).toBeNull();
    expect(() => write_cached_discovery(broken, "device", PAYLOAD)).not.toThrow();
    expect(() => clear_cached_discovery(broken)).not.toThrow();
  });

  test("clear removes the saved state", () => {
    const storage = create_storage();
    write_cached_discovery(storage, "neighborhood", PAYLOAD, SAVED_AT_MS);
    clear_cached_discovery(storage);
    expect(read_cached_discovery(storage, SAVED_AT_MS + 1)).toBeNull();
  });
});
