"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  clear_cached_discovery,
  get_browser_storage,
  read_cached_discovery,
  write_cached_discovery,
} from "@/lib/geolocation-cache";
import { forget_search, get_recent_search_storage, read_recent_searches, remember_search } from "@/lib/recent-searches";
import type {
  ApiErrorResponse,
  CatalogResponse,
  IndustryVertical,
  NearbyResponse,
  NeighborhoodSuggestionsResponse,
  NeighborhoodsResponse,
  OutsideMarketResponse,
} from "@/lib/types";

/** locating: awaiting permission | located: using GPS | fallback: no device location (search instead). */
export type DiscoveryMode = "locating" | "located" | "fallback";

export type FetchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "outside_market"; payload: OutsideMarketResponse }
  | { status: "success"; payload: NearbyResponse };

const GEOLOCATION_OPTIONS: PositionOptions = {
  enableHighAccuracy: false,
  timeout: 10_000,
  maximumAge: 60_000,
};

const SUGGESTION_DEBOUNCE_MS = 200;
const POPULAR_NEIGHBORHOOD_COUNT = 6;

/** The API requires a vertical; "" for city means every city. */
export interface DiscoveryScope {
  vertical: IndustryVertical;
  city: string;
}

const DEFAULT_SCOPE: DiscoveryScope = { vertical: "coffee_bakery", city: "" };

/** Where the current results are anchored; filters are layered on top when requesting. */
type DiscoveryOrigin =
  | { kind: "coordinates"; latitude: string; longitude: string }
  | { kind: "neighborhood"; name: string };

function build_scope_params(scope: DiscoveryScope): string {
  const params = new URLSearchParams({ vertical: scope.vertical });
  if (scope.city) params.set("city", scope.city);
  return `&${params.toString()}`;
}

function build_discovery_url(origin: DiscoveryOrigin, scope: DiscoveryScope): string {
  const base =
    origin.kind === "coordinates"
      ? `/api/proximity?scope=nearest&lat=${origin.latitude}&lng=${origin.longitude}`
      : `/api/proximity?neighborhood=${encodeURIComponent(origin.name)}`;
  return base + build_scope_params(scope);
}

const is_default_scope = (scope: DiscoveryScope): boolean =>
  scope.vertical === DEFAULT_SCOPE.vertical && scope.city === DEFAULT_SCOPE.city;

/** Maps a GeolocationPositionError to a user-facing fallback explanation. */
function describe_geolocation_failure(error: GeolocationPositionError): string {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return "Location is off for this site.";
    case error.TIMEOUT:
      return "We couldn't find your location in time.";
    default:
      return "Your location is unavailable right now.";
  }
}

async function read_error_message(response: Response): Promise<string> {
  const failure = (await response.json().catch(() => null)) as ApiErrorResponse | null;
  return failure?.error ?? `Request failed (${response.status}).`;
}

/** A text-search origin: a neighborhood centroid or a geocoded street address. */
export interface TextOrigin {
  name: string;
  is_address: boolean;
  latitude: number;
  longitude: number;
}

function to_text_origin(origin: NearbyResponse["origin"]): TextOrigin | null {
  if (origin.kind === "neighborhood") {
    return { name: origin.neighborhood, is_address: false, latitude: origin.latitude, longitude: origin.longitude };
  }
  if (origin.kind === "address") {
    return { name: origin.label, is_address: true, latitude: origin.latitude, longitude: origin.longitude };
  }
  return null;
}

/**
 * All discovery state and data fetching: device location (with the 15-minute cache),
 * neighborhood fallback and lookahead, city/vertical scope, and outside-market handling.
 */
export function use_discovery() {
  const [mode, set_mode] = useState<DiscoveryMode>("locating");
  const [fallback_notice, set_fallback_notice] = useState<string | null>(null);
  const [request_url, set_request_url] = useState<string | null>(null);
  const [fetch_state, set_fetch_state] = useState<FetchState>({ status: "idle" });
  const [cached_at_ms, set_cached_at_ms] = useState<number | null>(null);
  const [selected_index, set_selected_index] = useState(0);
  const [popular_neighborhoods, set_popular_neighborhoods] = useState<string[]>([]);
  const [recent_searches, set_recent_searches] = useState<string[]>([]);
  /** The visitor's own position, for the "you are here" dot (never stored server-side). */
  const [device_location, set_device_location] = useState<{ latitude: number; longitude: number } | null>(null);
  const [search_text, set_search_text] = useState("");
  const [suggestions, set_suggestions] = useState<string[]>([]);
  const [catalog, set_catalog] = useState<CatalogResponse | null>(null);
  const [scope, set_scope] = useState<DiscoveryScope>(DEFAULT_SCOPE);
  // Mirrors `scope` so stable callbacks (e.g. the location request) always read the latest value.
  const scope_ref = useRef<DiscoveryScope>(DEFAULT_SCOPE);

  const enter_fallback = useCallback((notice: string | null) => {
    set_mode("fallback");
    set_fallback_notice(notice);
    set_request_url(null);
    set_fetch_state({ status: "idle" });
    set_cached_at_ms(null);
    set_device_location(null);
  }, []);

  const request_device_location = useCallback(() => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      enter_fallback("Location isn't supported on this device.");
      return;
    }
    set_mode("locating");
    set_fallback_notice(null);
    set_cached_at_ms(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        // ~11m precision is plenty for discovery and limits what we store/transmit.
        const latitude = position.coords.latitude.toFixed(4);
        const longitude = position.coords.longitude.toFixed(4);
        set_mode("located");
        set_search_text("");
        set_device_location({ latitude: position.coords.latitude, longitude: position.coords.longitude });
        set_request_url(
          build_discovery_url({ kind: "coordinates", latitude, longitude }, scope_ref.current),
        );
      },
      (geolocation_error) => enter_fallback(describe_geolocation_failure(geolocation_error)),
      GEOLOCATION_OPTIONS,
    );
  }, [enter_fallback]);

  // On first load: serve a fresh (<15 min) cached result instantly, skipping the
  // permission prompt; otherwise ask the device for its location.
  useEffect(() => {
    const storage = get_browser_storage();
    const cached_state = storage ? read_cached_discovery(storage) : null;

    if (cached_state) {
      const { payload } = cached_state;
      set_mode(cached_state.source === "device" ? "located" : "fallback");
      set_search_text(to_text_origin(payload.origin)?.name ?? "");
      if (payload.origin.kind === "coordinates") {
        set_device_location({ latitude: payload.origin.latitude, longitude: payload.origin.longitude });
      }
      set_cached_at_ms(cached_state.saved_at_ms);
      set_selected_index(0);
      set_fetch_state({ status: "success", payload });
      return;
    }
    request_device_location();
  }, [request_device_location]);

  // Load which cities and verticals have data; drives the selectors.
  useEffect(() => {
    const abort_controller = new AbortController();
    async function fetch_catalog_options(): Promise<void> {
      try {
        const response = await fetch("/api/catalog", { signal: abort_controller.signal });
        if (!response.ok) throw new Error(await read_error_message(response));
        set_catalog((await response.json()) as CatalogResponse);
      } catch {
        // Selectors are an enhancement; without them the app searches everywhere.
      }
    }
    void fetch_catalog_options();
    return () => abort_controller.abort();
  }, []);

  // Quick picks for the search panel: the neighborhoods with the most tracked storefronts.
  useEffect(() => {
    const abort_controller = new AbortController();
    async function fetch_popular(): Promise<void> {
      try {
        const city_param = scope.city ? `&city=${encodeURIComponent(scope.city)}` : "";
        const response = await fetch(`/api/neighborhoods?popular=${POPULAR_NEIGHBORHOOD_COUNT}${city_param}`, {
          signal: abort_controller.signal,
        });
        if (!response.ok) throw new Error(await read_error_message(response));
        set_popular_neighborhoods(((await response.json()) as NeighborhoodsResponse).neighborhoods);
      } catch {
        // Quick picks are a convenience; without them the panel shows location and recents.
        if (!abort_controller.signal.aborted) set_popular_neighborhoods([]);
      }
    }
    void fetch_popular();
    return () => abort_controller.abort();
  }, [scope.city]);

  useEffect(() => {
    set_recent_searches(read_recent_searches(get_recent_search_storage()));
  }, []);

  // Debounced server-side lookahead for the neighborhood text box.
  useEffect(() => {
    const prefix = search_text.trim();
    if (prefix.length === 0) {
      set_suggestions([]);
      return;
    }
    const abort_controller = new AbortController();
    const timer_id = window.setTimeout(async () => {
      try {
        const city_param = scope.city ? `&city=${encodeURIComponent(scope.city)}` : "";
        const response = await fetch(
          `/api/proximity?suggest=${encodeURIComponent(prefix)}${city_param}`,
          { signal: abort_controller.signal },
        );
        if (!response.ok) throw new Error(await read_error_message(response));
        const payload = (await response.json()) as NeighborhoodSuggestionsResponse;
        set_suggestions(payload.suggestions);
      } catch {
        // Lookahead is a convenience; failures simply show no suggestions.
        if (!abort_controller.signal.aborted) set_suggestions([]);
      }
    }, SUGGESTION_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer_id);
      abort_controller.abort();
    };
  }, [search_text, scope.city]);

  // Fetch discovery results whenever the request URL changes, then cache them.
  useEffect(() => {
    if (request_url === null) return;
    const abort_controller = new AbortController();
    set_fetch_state({ status: "loading" });

    async function fetch_discovery_results(url: string): Promise<void> {
      try {
        const response = await fetch(url, { signal: abort_controller.signal });
        if (!response.ok) throw new Error(await read_error_message(response));
        const payload = (await response.json()) as NearbyResponse | OutsideMarketResponse;
        if ("status" in payload) {
          set_fetch_state({ status: "outside_market", payload });
          return;
        }

        const storage = get_browser_storage();
        // Only unscoped results are cached: the cache is restored without its scope.
        if (storage && is_default_scope(scope_ref.current)) {
          write_cached_discovery(
            storage,
            payload.origin.kind === "coordinates" ? "device" : "neighborhood",
            payload,
          );
        }
        set_selected_index(0);
        set_fetch_state({ status: "success", payload });
      } catch (caught_error) {
        if (abort_controller.signal.aborted) return;
        set_fetch_state({
          status: "error",
          message: caught_error instanceof Error ? caught_error.message : "Unable to load results.",
        });
      }
    }

    void fetch_discovery_results(request_url);
    return () => abort_controller.abort();
  }, [request_url]);

  /** Searches a neighborhood name or a street address (the API geocodes addresses). */
  function select_place(place: string): void {
    const text = place.replace(/\s+/g, " ").trim();
    if (!text) return;
    set_search_text(text);
    set_suggestions([]);
    set_cached_at_ms(null);
    set_recent_searches(remember_search(get_recent_search_storage(), text));
    set_request_url(build_discovery_url({ kind: "neighborhood", name: text }, scope_ref.current));
  }

  function forget_recent_search(place: string): void {
    set_recent_searches(forget_search(get_recent_search_storage(), place));
  }

  /** Changing city or vertical re-runs the current search with the new scope. */
  function apply_scope(next_scope: DiscoveryScope): void {
    scope_ref.current = next_scope;
    set_scope(next_scope);
    // Cached results were fetched without a scope, so they no longer match.
    const storage = get_browser_storage();
    if (storage) clear_cached_discovery(storage);
    set_cached_at_ms(null);

    const current_origin = fetch_state.status === "success" ? fetch_state.payload.origin : null;
    if (current_origin === null) return;
    set_request_url(
      build_discovery_url(
        current_origin.kind === "coordinates"
          ? {
              kind: "coordinates",
              latitude: current_origin.latitude.toFixed(4),
              longitude: current_origin.longitude.toFixed(4),
            }
          : { kind: "neighborhood", name: to_text_origin(current_origin)?.name ?? "" },
        next_scope,
      ),
    );
  }

  /** Drops the saved state and re-requests the device location. */
  function refresh_location(): void {
    const storage = get_browser_storage();
    if (storage) clear_cached_discovery(storage);
    set_fetch_state({ status: "idle" });
    request_device_location();
  }

  const payload = fetch_state.status === "success" ? fetch_state.payload : null;
  const results = payload?.results ?? [];
  const selected_result = results[selected_index] ?? results[0];
  const centroid_origin = payload ? to_text_origin(payload.origin) : null;
  const cache_age_minutes =
    cached_at_ms === null ? null : Math.max(0, Math.floor((Date.now() - cached_at_ms) / 60_000));

  return {
    mode,
    fallback_notice,
    fetch_state,
    payload,
    results,
    selected_index,
    selected_result,
    set_selected_index,
    centroid_origin,
    cache_age_minutes,
    catalog,
    scope,
    apply_scope,
    popular_neighborhoods,
    recent_searches,
    forget_recent_search,
    device_location,
    select_place,
    search_text,
    set_search_text,
    suggestions,
    enter_fallback,
    refresh_location,
  };
}

export type DiscoveryController = ReturnType<typeof use_discovery>;
