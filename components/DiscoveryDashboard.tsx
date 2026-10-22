"use client";

import dynamic from "next/dynamic";
import { FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import SubmissionPanel from "@/components/SubmissionPanel";
import { VERTICAL_LABELS } from "@/lib/catalog";
import {
  GEOLOCATION_CACHE_TTL_MS,
  clear_cached_discovery,
  get_browser_storage,
  read_cached_discovery,
  write_cached_discovery,
} from "@/lib/geolocation-cache";
import type {
  AlternativeRecommendation,
  ApiErrorResponse,
  CatalogResponse,
  CorporateTarget,
  IndustryVertical,
  NearbyCorporateResult,
  NearbyResponse,
  NeighborhoodSuggestionsResponse,
  NeighborhoodsResponse,
  OutsideMarketResponse,
} from "@/lib/types";

/** Leaflet touches `window`, so the map must render client-side only. */
const IndependentMap = dynamic(() => import("./IndependentMap"), {
  ssr: false,
  loading: () => <div className="h-56 w-full animate-pulse rounded-xl bg-zinc-200 sm:h-72" />,
});

/** locating: awaiting permission | located: using GPS | fallback: neighborhood menu. */
type DiscoveryMode = "locating" | "located" | "fallback";

type FetchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "outside_market"; payload: OutsideMarketResponse }
  | { status: "success"; payload: NearbyResponse };

const TIER_ALERT_LABEL: Record<1 | 2, string> = {
  1: "Private Equity Owned",
  2: "Venture Capital Funded",
};

const GEOLOCATION_OPTIONS: PositionOptions = {
  enableHighAccuracy: false,
  timeout: 10_000,
  maximumAge: 60_000,
};

const SUGGESTION_DEBOUNCE_MS = 200;

/** The API requires a vertical; "" for city means every city. */
interface DiscoveryScope {
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

/** Explicit icon placeholder for the Navigate action. */
function NavigateIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <polygon points="3 11 22 2 13 21 11 13 3 11" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function build_directions_url(alternative: AlternativeRecommendation): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${alternative.latitude},${alternative.longitude}&travelmode=walking`;
}

/** Maps a GeolocationPositionError to a user-facing fallback explanation. */
function describe_geolocation_failure(error: GeolocationPositionError): string {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return "Location access was denied. Choose a neighborhood instead.";
    case error.TIMEOUT:
      return "We couldn't get your location in time. Choose a neighborhood instead.";
    default:
      return "Your location is unavailable right now. Choose a neighborhood instead.";
  }
}

async function read_error_message(response: Response): Promise<string> {
  const failure = (await response.json().catch(() => null)) as ApiErrorResponse | null;
  return failure?.error ?? `Request failed (${response.status}).`;
}

/* ------------------------------------------------------------------------- */
/* Horizontal, swipeable independent alternatives slider                      */
/* ------------------------------------------------------------------------- */

interface AlternativesSliderProps {
  heading: string;
  alternatives: AlternativeRecommendation[];
}

function AlternativesSlider({ heading, alternatives }: AlternativesSliderProps) {
  return (
    <section className="space-y-4">
      <h3 className="text-xl font-extrabold text-zinc-900 sm:text-2xl">{heading}</h3>

      {alternatives.length === 0 ? (
        <p className="text-sm text-zinc-600">
          No verified independent alternatives nearby yet. Know one? Submit a tip below.
        </p>
      ) : (
        <ul
          role="list"
          tabIndex={0}
          aria-label="Independent alternatives, scroll sideways to see more"
          className="-mx-4 flex snap-x snap-mandatory space-x-4 overflow-x-auto px-4 pb-4 sm:mx-0 sm:px-0"
        >
          {alternatives.map((alternative) => (
            <li
              key={alternative.location_id}
              className="flex w-64 shrink-0 snap-start flex-col justify-between rounded-xl border border-zinc-200 bg-white p-4 transition-shadow hover:shadow-md"
            >
              <div className="space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <h4 className="font-bold text-zinc-900">{alternative.brand_name}</h4>
                  <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                    {alternative.distance_meters}m away
                  </span>
                </div>
                <p className="text-sm text-zinc-500">
                  {alternative.unique_selling_proposition ?? "Independently owned"}
                </p>
                <p className="text-xs text-zinc-500">
                  {[alternative.address, alternative.neighborhood].filter(Boolean).join(" · ")}
                </p>
              </div>
              <a
                href={build_directions_url(alternative)}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-700"
              >
                <NavigateIcon />
                Navigate
                <span className="sr-only"> to {alternative.brand_name} (opens in a new tab)</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------------- */
/* City + vertical selectors                                                  */
/* ------------------------------------------------------------------------- */

interface ScopeSelectorsProps {
  catalog: CatalogResponse;
  scope: DiscoveryScope;
  on_change: (scope: DiscoveryScope) => void;
}

const SELECT_CLASSES =
  "min-h-11 w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 focus:border-zinc-900";

function ScopeSelectors({ catalog, scope, on_change }: ScopeSelectorsProps) {
  return (
    <form aria-label="Narrow results" onSubmit={(event) => event.preventDefault()} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <label className="block text-sm font-medium text-zinc-700">
        City
        <select
          value={scope.city}
          onChange={(event) => on_change({ ...scope, city: event.target.value })}
          className={`${SELECT_CLASSES} mt-1`}
        >
          <option value="">All cities</option>
          {catalog.cities.map((city) => (
            <option key={city} value={city}>
              {city}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm font-medium text-zinc-700">
        Type of business
        <select
          value={scope.vertical}
          onChange={(event) => on_change({ ...scope, vertical: event.target.value as IndustryVertical })}
          className={`${SELECT_CLASSES} mt-1`}
        >
          {catalog.verticals.map((vertical) => (
            <option key={vertical} value={vertical}>
              {VERTICAL_LABELS[vertical]}
            </option>
          ))}
        </select>
      </label>
    </form>
  );
}

/* ------------------------------------------------------------------------- */
/* Corporate profile + independent slider for one selected result             */
/* ------------------------------------------------------------------------- */

function CorporateResultView({ result }: { result: NearbyCorporateResult }) {
  const { target, alternatives } = result;

  return (
    <div className="space-y-8">
      {/* Selection view: corporate profile + alert banner */}
      <section className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 text-zinc-50 shadow-lg">
        <div role="note" className="flex items-center gap-3 bg-amber-500/10 px-5 py-3 text-amber-500">
          <AlertIcon />
          <p className="text-sm font-semibold uppercase tracking-wide">
            {TIER_ALERT_LABEL[target.corporate_tier]}
          </p>
        </div>
        <div className="space-y-1 px-5 py-5">
          <h2 className="text-2xl font-bold">{target.brand_name}</h2>
          <p className="text-sm text-zinc-400">
            {[target.address, target.neighborhood].filter(Boolean).join(" · ")}
          </p>
          {target.distance_meters !== null && (
            <p className="text-sm text-zinc-400">{target.distance_meters}m from you</p>
          )}
          <p className="pt-2 text-sm text-zinc-300">
            Ownership: <span className="font-medium">{target.parent_entity}</span>{" "}
            <span className="text-zinc-400">(Tier {target.corporate_tier})</span>
          </p>
          {target.financial_backers.length > 0 && (
            <p className="text-sm text-zinc-300">
              Backed by: <span className="font-medium">{target.financial_backers.join(", ")}</span>
            </p>
          )}
        </div>
      </section>

      <div role="region" aria-label="Map of nearby independent alternatives">
        <IndependentMap target={target} alternatives={alternatives} />
      </div>

      <AlternativesSlider
        heading="Keep it local instead? Here are independent alternatives within a 5-minute walk."
        alternatives={alternatives}
      />
    </div>
  );
}

/** Map anchor for a neighborhood centroid (no corporate brand involved). */
function build_centroid_target(origin: Extract<NearbyResponse["origin"], { kind: "neighborhood" }>): CorporateTarget {
  return {
    location_id: `centroid:${origin.neighborhood}`,
    brand_name: `${origin.neighborhood} (centre)`,
    corporate_tier: 2,
    parent_entity: "",
    financial_backers: [],
    address: origin.neighborhood,
    neighborhood: origin.neighborhood,
    latitude: origin.latitude,
    longitude: origin.longitude,
    distance_meters: null,
  };
}

/* ------------------------------------------------------------------------- */
/* Dashboard                                                                  */
/* ------------------------------------------------------------------------- */

export default function DiscoveryDashboard() {
  const [mode, set_mode] = useState<DiscoveryMode>("locating");
  const [fallback_notice, set_fallback_notice] = useState<string | null>(null);
  const [request_url, set_request_url] = useState<string | null>(null);
  const [fetch_state, set_fetch_state] = useState<FetchState>({ status: "idle" });
  const [cached_at_ms, set_cached_at_ms] = useState<number | null>(null);
  const [selected_index, set_selected_index] = useState(0);
  const [neighborhoods, set_neighborhoods] = useState<string[]>([]);
  const [neighborhoods_error, set_neighborhoods_error] = useState<string | null>(null);
  const [active_neighborhood, set_active_neighborhood] = useState<string | null>(null);
  const [search_text, set_search_text] = useState("");
  const [suggestions, set_suggestions] = useState<string[]>([]);
  const [is_panel_open, set_is_panel_open] = useState(false);
  const [catalog, set_catalog] = useState<CatalogResponse | null>(null);
  const [scope, set_scope] = useState<DiscoveryScope>(DEFAULT_SCOPE);
  // Mirrors `scope` so stable callbacks (e.g. the location request) always read the latest value.
  const scope_ref = useRef<DiscoveryScope>(DEFAULT_SCOPE);
  const [active_suggestion, set_active_suggestion] = useState(-1);

  const enter_fallback = useCallback((notice: string | null) => {
    set_mode("fallback");
    set_fallback_notice(notice);
    set_request_url(null);
    set_fetch_state({ status: "idle" });
    set_cached_at_ms(null);
    set_active_neighborhood(null);
  }, []);

  const request_device_location = useCallback(() => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      enter_fallback("Location isn't supported on this device. Choose a neighborhood instead.");
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
        set_active_neighborhood(null);
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
      set_active_neighborhood(
        payload.origin.kind === "neighborhood" ? payload.origin.neighborhood : null,
      );
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

  // Load neighborhood options for the fallback menu (narrowed to the chosen city).
  useEffect(() => {
    const abort_controller = new AbortController();
    async function fetch_neighborhood_options(): Promise<void> {
      try {
        const query = scope.city ? `?city=${encodeURIComponent(scope.city)}` : "";
        const response = await fetch(`/api/neighborhoods${query}`, { signal: abort_controller.signal });
        if (!response.ok) throw new Error(await read_error_message(response));
        const payload = (await response.json()) as NeighborhoodsResponse;
        set_neighborhoods(payload.neighborhoods);
        set_neighborhoods_error(null);
      } catch (caught_error) {
        if (abort_controller.signal.aborted) return;
        set_neighborhoods_error(
          caught_error instanceof Error ? caught_error.message : "Unable to load neighborhoods.",
        );
      }
    }
    void fetch_neighborhood_options();
    return () => abort_controller.abort();
  }, [scope.city]);

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
        set_active_suggestion(-1);
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

  function select_neighborhood(neighborhood: string): void {
    set_active_neighborhood(neighborhood);
    set_search_text(neighborhood);
    set_suggestions([]);
    set_active_suggestion(-1);
    set_cached_at_ms(null);
    set_request_url(build_discovery_url({ kind: "neighborhood", name: neighborhood }, scope_ref.current));
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
          : { kind: "neighborhood", name: current_origin.neighborhood },
        next_scope,
      ),
    );
  }

  function handle_search_submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const neighborhood = search_text.trim();
    if (neighborhood.length > 0) select_neighborhood(neighborhood);
  }

  /** Combobox keyboard support: arrows move through suggestions, Enter picks, Escape closes. */
  function handle_search_keydown(event: KeyboardEvent<HTMLInputElement>): void {
    if (suggestions.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      set_active_suggestion((index) => (index + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      set_active_suggestion((index) => (index <= 0 ? suggestions.length - 1 : index - 1));
    } else if (event.key === "Enter" && active_suggestion >= 0) {
      event.preventDefault();
      const chosen = suggestions[active_suggestion];
      if (chosen) select_neighborhood(chosen);
    } else if (event.key === "Escape") {
      set_suggestions([]);
      set_active_suggestion(-1);
    }
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
  const centroid_origin = payload?.origin.kind === "neighborhood" ? payload.origin : null;
  const suggestions_visible =
    suggestions.length > 0 && search_text.trim().toLowerCase() !== suggestions[0]?.toLowerCase();
  const cache_age_minutes =
    cached_at_ms === null ? null : Math.max(0, Math.floor((Date.now() - cached_at_ms) / 60_000));

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-6 sm:px-6">
      <header className="space-y-1">
        <h1 className="text-3xl font-extrabold text-zinc-900">TrueOwn</h1>
        <p className="text-sm text-zinc-500">
          See who really owns the shops around you — and keep it local.
        </p>
      </header>

      {catalog && (catalog.cities.length > 0 || catalog.verticals.length > 0) && (
        <ScopeSelectors catalog={catalog} scope={scope} on_change={apply_scope} />
      )}

      {mode === "locating" && (
        <p
          role="status"
          className="motion-safe:animate-pulse rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-600"
        >
          Finding corporate-backed spots near you… Please allow location access.
        </p>
      )}

      {mode === "located" && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-zinc-500">
          <span>
            {cache_age_minutes === null
              ? "Showing results near your current location."
              : `Showing saved results from ${cache_age_minutes} min ago (kept up to ${GEOLOCATION_CACHE_TTL_MS / 60_000} min).`}
          </span>
          <span className="flex flex-wrap gap-x-4">
            {cache_age_minutes !== null && (
              <button type="button" onClick={refresh_location} className="inline-flex min-h-11 items-center font-semibold text-zinc-900 underline underline-offset-2">
                Refresh my location
              </button>
            )}
            <button type="button" onClick={() => enter_fallback(null)} className="inline-flex min-h-11 items-center font-semibold text-zinc-900 underline underline-offset-2">
              Browse by neighborhood instead
            </button>
          </span>
        </div>
      )}

      {/* Search by Neighborhood fallback */}
      {mode === "fallback" && (
        <section
          aria-labelledby="neighborhood-heading"
          className="space-y-4 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
        >
          <div>
            <h2 id="neighborhood-heading" className="text-lg font-bold text-zinc-900">
              Search by Neighborhood
            </h2>
            {fallback_notice && (
              <p role="status" className="mt-1 text-sm text-zinc-500">
                {fallback_notice}
              </p>
            )}
          </div>

          <form onSubmit={handle_search_submit} className="relative" role="search">
            <div className="flex gap-2">
              <input
                type="search"
                role="combobox"
                aria-expanded={suggestions_visible}
                aria-controls="neighborhood-suggestions"
                aria-autocomplete="list"
                aria-activedescendant={active_suggestion >= 0 ? `neighborhood-suggestion-${active_suggestion}` : undefined}
                onKeyDown={handle_search_keydown}
                value={search_text}
                onChange={(event) => set_search_text(event.target.value)}
                placeholder="e.g. West Village, Astoria…"
                maxLength={100}
                autoComplete="off"
                aria-label="Neighborhood name"
                className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-base text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-zinc-900"
              />
              <button
                type="submit"
                disabled={search_text.trim().length === 0}
                className="shrink-0 rounded-xl bg-zinc-900 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-300"
              >
                Search
              </button>
            </div>
            {suggestions_visible && (
              <ul
                id="neighborhood-suggestions"
                role="listbox"
                aria-label="Neighborhood suggestions"
                className="absolute z-10 mt-1 w-full overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-lg"
              >
                {suggestions.map((suggestion, index) => (
                  <li
                    key={suggestion}
                    id={`neighborhood-suggestion-${index}`}
                    role="option"
                    aria-selected={index === active_suggestion}
                    onMouseDown={(event) => {
                      // Keep input focus so the click is not lost to a blur.
                      event.preventDefault();
                      select_neighborhood(suggestion);
                    }}
                    className={`block min-h-11 cursor-pointer px-4 py-3 text-left text-sm text-zinc-800 hover:bg-zinc-100 ${
                      index === active_suggestion ? "bg-zinc-100" : ""
                    }`}
                  >
                    {suggestion}
                  </li>
                ))}
              </ul>
            )}
            <p role="status" className="sr-only">
              {suggestions_visible ? `${suggestions.length} suggestions available. Use up and down arrows to review.` : ""}
            </p>
          </form>

          {neighborhoods_error && (
            <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700">
              {neighborhoods_error}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            {neighborhoods.map((neighborhood) => (
              <button
                key={neighborhood}
                type="button"
                onClick={() => select_neighborhood(neighborhood)}
                aria-pressed={active_neighborhood === neighborhood}
                className={`min-h-11 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
                  active_neighborhood === neighborhood
                    ? "border-zinc-900 bg-zinc-900 text-white"
                    : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-900"
                }`}
              >
                {neighborhood}
              </button>
            ))}
          </div>

          <button type="button" onClick={refresh_location} className="inline-flex min-h-11 items-center text-sm font-semibold text-zinc-900 underline underline-offset-2">
            Try my location again
          </button>
        </section>
      )}

      {/* Reserve vertical space so late-arriving results don't shift the layout (CLS). */}
      <div className="min-h-[32rem] space-y-8">
        {fetch_state.status === "loading" && (
          <p className="text-sm text-zinc-600" role="status">
            Finding independent alternatives…
          </p>
        )}
        {fetch_state.status === "outside_market" && (
          <div role="status" className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-4 text-sm text-zinc-700">
            <p className="font-medium text-zinc-900">TrueOwn isn&apos;t available at your location yet.</p>
            <p className="mt-1">
              {fetch_state.payload.closest_active_market
                ? `The closest active city is ${fetch_state.payload.closest_active_market.city_name}, about ${Math.round(
                    fetch_state.payload.closest_active_market.distance_meters / 1609.344,
                  ).toLocaleString()} miles away. Try a neighborhood there instead.`
                : "No cities are active yet."}
            </p>
          </div>
        )}
        {fetch_state.status === "error" && (
          <p role="alert" className="rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-700">
            {fetch_state.message}
          </p>
        )}

        {payload && results.length === 0 && payload.origin_alternatives.length === 0 && (
          <p className="rounded-xl border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500">
            {centroid_origin
              ? `No tracked Tier 1 or Tier 2 brands, or independents, near ${centroid_origin.neighborhood} yet.`
              : "No tracked corporate-backed brands near you yet. Try a neighborhood instead."}
          </p>
        )}

        {results.length > 1 && (
          <nav aria-label="Nearby corporate locations" className="-mx-4 flex space-x-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
            {results.map((result, index) => (
              <button
                key={result.target.location_id}
                type="button"
                onClick={() => set_selected_index(index)}
                aria-current={index === selected_index ? "true" : undefined}
                className={`min-h-11 shrink-0 rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
                  index === selected_index
                    ? "border-zinc-900 bg-zinc-900 text-white"
                    : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-900"
                }`}
              >
                {result.target.brand_name}
                {result.target.distance_meters !== null && ` · ${result.target.distance_meters}m`}
              </button>
            ))}
          </nav>
        )}

        {selected_result && (
          <CorporateResultView key={selected_result.target.location_id} result={selected_result} />
        )}

        {/* Neighborhood with no corporate brands: still offer independents around its centre. */}
        {centroid_origin && results.length === 0 && payload && payload.origin_alternatives.length > 0 && (
          <div className="space-y-8">
            <div role="region" aria-label="Map of nearby independent alternatives">
              <IndependentMap
                target={build_centroid_target(centroid_origin)}
                alternatives={payload.origin_alternatives}
              />
            </div>
            <AlternativesSlider
              heading={`Independent spots within 1500m of the centre of ${centroid_origin.neighborhood}.`}
              alternatives={payload.origin_alternatives}
            />
          </div>
        )}
      </div>

      {/* Crowdsourced pipeline */}
      <section className="flex justify-center border-t border-zinc-200 pt-6">
        <button
          type="button"
          onClick={() => set_is_panel_open(true)}
          className="min-h-11 rounded-xl border border-zinc-200 px-5 py-3 text-sm font-semibold text-zinc-900 transition-colors hover:border-zinc-900"
        >
          Know of an ownership change? Submit a tip
        </button>
      </section>

      <SubmissionPanel is_open={is_panel_open} on_close={() => set_is_panel_open(false)} />
    </div>
  );
}
