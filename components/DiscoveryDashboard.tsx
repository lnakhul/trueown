"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import CorrectionPanel, { type ReportedListing } from "@/components/CorrectionPanel";
import SubmissionPanel from "@/components/SubmissionPanel";
import type { AlternativeRecommendation, NearbyResponse } from "@/lib/types";
import { OWNERSHIP_TAG, summarize_names } from "@/lib/ui/ownership-labels";
import AlternativesCarousel, { type ScrollRequest } from "./discovery/AlternativesCarousel";
import CorporateProfileCard from "./discovery/CorporateProfileCard";
import CorporateTargetList from "./discovery/CorporateTargetList";
import DiscoveryShell from "./discovery/DiscoveryShell";
import FilterPills from "./discovery/FilterPills";
import ProximitySheet from "./discovery/ProximitySheet";
import SearchBar from "./discovery/SearchBar";
import { BuildingIcon, LocateIcon, RefreshIcon, SearchIcon } from "./discovery/icons";
import { use_discovery } from "./discovery/use-discovery";
import { DESKTOP_MEDIA_QUERY, use_media_query } from "./discovery/use-media-query";

const SEARCH_INPUT_ID = "discovery-search";
const MAP_SIZE_CLASSES =
  "h-[46vh] min-h-[18rem] max-h-[30rem] w-full md:h-[calc(100vh-3rem)] md:max-h-none md:rounded-2xl";

/** Leaflet touches `window`, so the map must render client-side only. */
const DiscoveryMap = dynamic(() => import("./DiscoveryMap"), {
  ssr: false,
  loading: () => <div className={`${MAP_SIZE_CLASSES} animate-pulse bg-surface-card`} />,
});

const LOCAL_ALTERNATIVES_HEADING =
  "Keep it local instead? Here are independent alternatives within a 5-minute walk.";

const LINK_BUTTON =
  "inline-flex min-h-11 items-center gap-1.5 font-semibold text-zinc-100 underline-offset-4 hover:underline";

function MapLegend() {
  return (
    <ul
      className="pointer-events-none absolute bottom-3 left-3 z-[500] flex gap-3 rounded-full bg-surface-page/80 px-3 py-1.5 text-xs text-zinc-300 shadow-hairline backdrop-blur"
      aria-label="Map legend"
    >
      <li className="flex items-center gap-1.5">
        <span aria-hidden="true" className="h-2 w-2 rotate-45 rounded-[1px] bg-corporate" />
        Corporate-backed
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-independent" />
        Independent
      </li>
    </ul>
  );
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

type CollectionView = Extract<NearbyResponse["origin"], { kind: "brand" } | { kind: "owner" }>;

function as_collection(origin: NearbyResponse["origin"] | undefined): CollectionView | null {
  return origin && (origin.kind === "brand" || origin.kind === "owner") ? origin : null;
}

/** "All 4 locations" or "The 10 nearest of 312 locations". */
function describe_shown(shown: number, total: number, measured: boolean): string {
  if (shown >= total) return total === 1 ? "1 location" : `All ${total} locations`;
  return `${measured ? "The" : "First"} ${shown} ${measured ? "nearest " : ""}of ${total} locations`;
}

function CollectionHeading({ view, shown }: { view: CollectionView; shown: number }) {
  const measured = view.anchor === "user";
  if (view.kind === "brand") {
    const { brand } = view;
    return (
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-zinc-50">{brand.name}</h2>
        <p className="text-sm">
          <span className={brand.corporate_tier === 3 ? "font-medium text-independent" : "font-medium text-corporate"}>
            {OWNERSHIP_TAG[brand.corporate_tier]}
          </span>
          <span className="text-zinc-400"> · {describe_shown(shown, view.total_locations, measured)}</span>
        </p>
      </div>
    );
  }
  const { owner } = view;
  return (
    <div className="space-y-1">
      <h2 className="flex items-center gap-2 text-base font-semibold text-zinc-50">
        <BuildingIcon className="h-4 w-4 shrink-0 text-corporate" />
        {owner.name}
      </h2>
      <p className="text-sm text-zinc-400">
        Owns or backs {owner.brand_names.length === 1 ? "" : `${owner.brand_names.length} brands: `}
        <span className="text-zinc-200">{summarize_names(owner.brand_names, 3)}</span>
        {" · "}
        {describe_shown(shown, view.total_locations, measured).toLowerCase()}
      </p>
    </div>
  );
}

export default function DiscoveryDashboard() {
  const discovery = use_discovery();
  const {
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
    select_brand,
    select_owner,
    select_recent,
    brand_suggestions,
    owner_suggestions,
    search_text,
    set_search_text,
    suggestions,
    refresh_location,
  } = discovery;

  const is_desktop = use_media_query(DESKTOP_MEDIA_QUERY);
  const [is_panel_open, set_is_panel_open] = useState(false);
  const [reported_listing, set_reported_listing] = useState<ReportedListing | null>(null);
  const [is_sheet_open, set_is_sheet_open] = useState(false);
  /** A storefront the visitor picked; the map zooms to it. Null shows the overview. */
  const [focused_target_id, set_focused_target_id] = useState<string | null>(null);
  const [active_alternative_id, set_active_alternative_id] = useState<string | null>(null);
  const [scroll_request, set_scroll_request] = useState<ScrollRequest | null>(null);

  const selected_target_id = selected_result?.target.location_id ?? null;
  const is_loading = mode === "locating" || fetch_state.status === "loading";
  const is_near_me = payload?.origin.kind === "coordinates";
  const collection = as_collection(payload?.origin);

  // A new target (or result set) starts with no highlighted alternative.
  useEffect(() => {
    set_active_alternative_id(null);
    set_scroll_request(null);
  }, [selected_target_id, payload]);

  // New results, or growing into the desktop layout, return to the overview.
  useEffect(() => {
    set_is_sheet_open(false);
    set_focused_target_id(null);
  }, [payload, is_desktop]);

  const handle_select_target = useCallback(
    (index: number) => {
      set_selected_index(index);
      set_focused_target_id(results[index]?.target.location_id ?? null);
      if (!is_desktop) set_is_sheet_open(true);
    },
    [is_desktop, results, set_selected_index],
  );

  const handle_marker_target = useCallback(
    (location_id: string) => {
      const index = results.findIndex((result) => result.target.location_id === location_id);
      if (index >= 0) handle_select_target(index);
    },
    [results, handle_select_target],
  );

  /** A marker tap highlights its card and scrolls the carousel to it. */
  const handle_marker_alternative = useCallback((location_id: string) => {
    set_active_alternative_id(location_id);
    set_scroll_request((previous) => ({ location_id, request_key: (previous?.request_key ?? 0) + 1 }));
  }, []);

  const close_sheet = useCallback(() => {
    set_is_sheet_open(false);
    set_focused_target_id(null);
  }, []);

  const origin_alternatives: AlternativeRecommendation[] = payload?.origin_alternatives ?? [];
  const show_origin_view = centroid_origin !== null && results.length === 0 && origin_alternatives.length > 0;
  // An independent brand's own locations (no corporate storefronts in the view).
  const independent_brand = collection?.kind === "brand" && collection.brand.corporate_tier === 3 ? collection : null;
  const independent_count = useMemo(() => {
    const ids = new Set<string>();
    for (const result of results) for (const alternative of result.alternatives) ids.add(alternative.location_id);
    for (const alternative of origin_alternatives) ids.add(alternative.location_id);
    return ids.size;
  }, [results, origin_alternatives]);

  function report_error_for(target: { location_id: string; brand_name: string; address: string }): void {
    set_reported_listing({ location_id: target.location_id, brand_name: target.brand_name, address: target.address });
  }

  function focus_search(): void {
    document.getElementById(SEARCH_INPUT_ID)?.focus();
  }

  /* ---------------------------------------------------------------------- */

  const search = (
    <SearchBar
      input_id={SEARCH_INPUT_ID}
      search_text={search_text}
      set_search_text={set_search_text}
      suggestions={suggestions}
      brands={brand_suggestions}
      owners={owner_suggestions}
      recent_searches={recent_searches}
      popular_neighborhoods={popular_neighborhoods}
      on_select_place={select_place}
      on_select_brand={select_brand}
      on_select_owner={select_owner}
      on_select_recent={select_recent}
      on_use_location={refresh_location}
      on_forget_recent={forget_recent_search}
      is_locating={mode === "locating"}
      is_near_me={is_near_me}
    />
  );

  let status: React.ReactNode = null;
  if (is_loading && !payload) {
    status = (
      <span className="flex items-center gap-2 py-2">
        <LocateIcon className="h-3.5 w-3.5 text-independent motion-safe:animate-pulse" />
        {mode === "locating" ? "Finding your location…" : "Finding spots…"}
      </span>
    );
  } else if (is_near_me) {
    status = (
      <>
        <span className="flex items-center gap-2 py-2">
          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-blue-500 shadow-[0_0_0_3px_rgb(59_130_246/0.25)]" />
          Near you{cache_age_minutes !== null && cache_age_minutes > 0 ? ` · updated ${cache_age_minutes} min ago` : ""}
        </span>
        <button type="button" onClick={refresh_location} className={LINK_BUTTON} aria-label="Refresh my location">
          <RefreshIcon /> Refresh
        </button>
      </>
    );
  } else if (collection) {
    status = (
      <>
        <span className="min-w-0 truncate py-2">
          {collection.anchor === "user" ? "Nearest to you" : "Turn on location to sort by distance"}
        </span>
        <button type="button" onClick={refresh_location} className={`${LINK_BUTTON} shrink-0`}>
          <LocateIcon className="h-3.5 w-3.5" /> Near me
        </button>
      </>
    );
  } else if (centroid_origin) {
    status = (
      <>
        <span className="min-w-0 truncate py-2">
          Around <span className="font-medium text-zinc-100">{centroid_origin.name}</span>
        </span>
        <button type="button" onClick={refresh_location} className={`${LINK_BUTTON} shrink-0`}>
          <LocateIcon className="h-3.5 w-3.5" /> Near me
        </button>
      </>
    );
  } else if (mode === "fallback" && fallback_notice) {
    status = (
      <>
        <span className="py-2">{fallback_notice}</span>
        <button type="button" onClick={refresh_location} className={LINK_BUTTON}>
          Try again
        </button>
      </>
    );
  }

  const controls = (
    <>
      <FilterPills catalog={catalog} scope={scope} on_change={apply_scope} />
      {status && (
        <div role="status" className="flex items-center justify-between gap-3 text-sm text-zinc-400">
          {status}
        </div>
      )}
    </>
  );

  const map = (
    <div role="region" aria-label="Map of corporate-backed and independent spots" className="relative overflow-hidden md:rounded-2xl md:shadow-hairline">
      <DiscoveryMap
        results={results}
        origin_alternatives={origin_alternatives}
        search_origin={centroid_origin}
        user_location={device_location}
        focused_target_id={focused_target_id}
        selected_target_id={focused_target_id ?? (is_desktop ? selected_target_id : null)}
        active_alternative_id={active_alternative_id}
        on_select_target={handle_marker_target}
        on_select_alternative={handle_marker_alternative}
        className={MAP_SIZE_CLASSES}
      />
      {is_loading && (
        <p
          role="status"
          className="absolute left-1/2 top-3 z-[500] flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full bg-surface-page/85 px-4 py-2 text-sm font-medium text-zinc-100 shadow-lift backdrop-blur"
        >
          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-independent motion-safe:animate-ping" />
          {mode === "locating" ? "Finding spots near you…" : "Finding spots…"}
        </p>
      )}
      {focused_target_id && is_desktop && (
        <button
          type="button"
          onClick={() => set_focused_target_id(null)}
          className="absolute right-3 top-3 z-[500] inline-flex min-h-11 items-center rounded-full bg-surface-page/85 px-4 text-sm font-semibold text-zinc-100 shadow-lift backdrop-blur hover:bg-surface-raised"
        >
          Show all on map
        </button>
      )}
      {(results.length > 0 || origin_alternatives.length > 0) && <MapLegend />}
    </div>
  );

  const show_empty_state = !payload && !is_loading && fetch_state.status !== "outside_market" && fetch_state.status !== "error";

  const results_view = (
    <div className="space-y-6">
      {show_empty_state && (
        <div className="rounded-2xl bg-surface-card px-5 py-6 shadow-hairline">
          <p className="text-base font-semibold text-zinc-50">Who owns the shops around you?</p>
          <p className="mt-1 text-sm text-zinc-400">
            Share your location or search a neighborhood or address to see corporate-backed spots and the independents
            nearby.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={refresh_location}
              className="inline-flex min-h-11 items-center gap-2 rounded-full bg-zinc-50 px-5 text-sm font-semibold text-zinc-950 hover:bg-white"
            >
              <LocateIcon className="h-4 w-4" /> Use my location
            </button>
            <button
              type="button"
              onClick={focus_search}
              className="inline-flex min-h-11 items-center gap-2 rounded-full bg-white/[0.06] px-5 text-sm font-semibold text-zinc-100 shadow-hairline hover:bg-white/[0.1]"
            >
              <SearchIcon className="h-4 w-4" /> Search instead
            </button>
          </div>
        </div>
      )}

      {fetch_state.status === "outside_market" && (
        <div role="status" className="rounded-2xl bg-surface-card px-4 py-4 text-sm text-zinc-300 shadow-hairline">
          <p className="font-medium text-zinc-50">TrueOwn isn&apos;t available here yet.</p>
          <p className="mt-1">
            {fetch_state.payload.closest_active_market
              ? `The closest active city is ${fetch_state.payload.closest_active_market.city_name}, about ${Math.round(
                  fetch_state.payload.closest_active_market.distance_meters / 1609.344,
                ).toLocaleString()} miles away. Search a neighborhood there instead.`
              : "No cities are active yet."}
          </p>
        </div>
      )}
      {fetch_state.status === "error" && (
        <p role="alert" className="rounded-2xl bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {fetch_state.message}
        </p>
      )}

      {fetch_state.status === "loading" && !payload && (
        <ul aria-hidden="true" className="space-y-2">
          {[0, 1, 2].map((key) => (
            <li key={key} className="h-[4.5rem] animate-pulse rounded-2xl bg-surface-card" />
          ))}
        </ul>
      )}

      {payload && results.length === 0 && origin_alternatives.length === 0 && (
        <p className="rounded-2xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-zinc-400">
          {centroid_origin
            ? `No tracked corporate-backed brands or independents near ${centroid_origin.name} yet.`
            : "No tracked corporate-backed brands near you yet. Try searching a neighborhood."}
        </p>
      )}

      {collection && <CollectionHeading view={collection} shown={results.length || origin_alternatives.length} />}

      {results.length > 0 && (
        <div className="space-y-3">
          <h2 className={collection ? "sr-only" : "text-sm text-zinc-400"}>
            <span className="font-semibold text-zinc-50">{plural(results.length, "corporate-backed spot", "corporate-backed spots")}</span>
            {" "}
            {centroid_origin ? `around ${centroid_origin.name}` : "near you"}
            {independent_count > 0 && ` · ${plural(independent_count, "independent", "independents")} nearby`}
          </h2>
          <CorporateTargetList
            results={results}
            selected_index={selected_index}
            on_select={handle_select_target}
            opens_dialog={!is_desktop}
            variant={collection?.kind ?? "nearby"}
          />
        </div>
      )}

      {/* Desktop: the selected profile and its alternatives render inline. */}
      {is_desktop && selected_result && (
        <div key={selected_result.target.location_id} className="space-y-6">
          <CorporateProfileCard target={selected_result.target} on_report_error={() => report_error_for(selected_result.target)} />
          <AlternativesCarousel
            heading={LOCAL_ALTERNATIVES_HEADING}
            heading_id="alternatives-heading"
            alternatives={selected_result.alternatives}
            active_alternative_id={active_alternative_id}
            on_activate={set_active_alternative_id}
            scroll_request={scroll_request}
            layout="inline"
          />
        </div>
      )}

      {independent_brand && (
        <AlternativesCarousel
          heading={`${independent_brand.brand.name} is independently owned. ${
            origin_alternatives.length === 1 ? "Support them here." : "Support them at any of these locations."
          }`}
          heading_id="brand-locations-heading"
          alternatives={origin_alternatives}
          active_alternative_id={active_alternative_id}
          on_activate={set_active_alternative_id}
          scroll_request={scroll_request}
          layout={is_desktop ? "inline" : "sheet"}
          show_distance={independent_brand.anchor === "user"}
        />
      )}

      {/* A searched place with no corporate brands still lists the independents around it. */}
      {show_origin_view && centroid_origin && (
        <AlternativesCarousel
          heading={`Independent spots within 1500m of ${centroid_origin.is_address ? "" : "the centre of "}${centroid_origin.name}.`}
          heading_id="origin-alternatives-heading"
          alternatives={origin_alternatives}
          active_alternative_id={active_alternative_id}
          on_activate={set_active_alternative_id}
          scroll_request={scroll_request}
          layout={is_desktop ? "inline" : "sheet"}
        />
      )}
    </div>
  );

  const footer = (
    <div className="flex flex-col items-center gap-3">
      <button
        type="button"
        onClick={() => set_is_panel_open(true)}
        className="min-h-11 rounded-xl bg-white/[0.04] px-5 py-3 text-sm font-semibold text-zinc-100 shadow-hairline transition-colors hover:bg-white/[0.08]"
      >
        Know of an ownership change? Submit a tip
      </button>
      <Link
        href="/how-we-classify"
        className="inline-flex min-h-11 items-center text-sm font-medium text-zinc-400 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-100"
      >
        How we classify businesses
      </Link>
    </div>
  );

  return (
    <>
      <DiscoveryShell search={search} controls={controls} map={map} results={results_view} footer={footer} />

      {/* Phones: the selected profile and its alternatives open in a bottom sheet. */}
      {!is_desktop && selected_result && (
        <ProximitySheet
          is_open={is_sheet_open}
          on_close={close_sheet}
          title={selected_result.target.brand_name}
          subtitle={[
            selected_result.target.address,
            selected_result.target.distance_meters !== null ? `${selected_result.target.distance_meters}m from you` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          <div key={selected_result.target.location_id} className="space-y-5">
            <CorporateProfileCard
              target={selected_result.target}
              variant="summary"
              on_report_error={() => report_error_for(selected_result.target)}
            />
            <AlternativesCarousel
              heading={LOCAL_ALTERNATIVES_HEADING}
              heading_id="sheet-alternatives-heading"
              alternatives={selected_result.alternatives}
              active_alternative_id={active_alternative_id}
              on_activate={set_active_alternative_id}
              scroll_request={scroll_request}
              layout="sheet"
            />
          </div>
        </ProximitySheet>
      )}

      <SubmissionPanel is_open={is_panel_open} on_close={() => set_is_panel_open(false)} />
      <CorrectionPanel listing={reported_listing} on_close={() => set_reported_listing(null)} />
    </>
  );
}
