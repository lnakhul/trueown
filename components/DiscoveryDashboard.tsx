"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import CorrectionPanel, { type ReportedListing } from "@/components/CorrectionPanel";
import SubmissionPanel from "@/components/SubmissionPanel";
import { GEOLOCATION_CACHE_TTL_MS } from "@/lib/geolocation-cache";
import type { AlternativeRecommendation } from "@/lib/types";
import AlternativesCarousel, { type ScrollRequest } from "./discovery/AlternativesCarousel";
import CorporateProfileCard from "./discovery/CorporateProfileCard";
import CorporateTargetList from "./discovery/CorporateTargetList";
import DiscoveryShell from "./discovery/DiscoveryShell";
import NeighborhoodSearch from "./discovery/NeighborhoodSearch";
import ProximitySheet from "./discovery/ProximitySheet";
import ScopeSelectors from "./discovery/ScopeSelectors";
import { LocateIcon, StorefrontIcon } from "./discovery/icons";
import { build_centroid_target, use_discovery } from "./discovery/use-discovery";
import { DESKTOP_MEDIA_QUERY, use_media_query } from "./discovery/use-media-query";

const MAP_HEIGHT_CLASSES = "h-56 w-full rounded-2xl sm:h-72 md:h-[calc(100vh-5.5rem)] md:max-h-[52rem]";

/** Leaflet touches `window`, so the map must render client-side only. */
const IndependentMap = dynamic(() => import("./IndependentMap"), {
  ssr: false,
  loading: () => <div className={`${MAP_HEIGHT_CLASSES} animate-pulse bg-surface-card`} />,
});

const LOCAL_ALTERNATIVES_HEADING =
  "Keep it local instead? Here are independent alternatives within a 5-minute walk.";

function MapLegend() {
  return (
    <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-zinc-400" aria-label="Map legend">
      <li className="flex items-center gap-2">
        <span aria-hidden="true" className="h-2.5 w-2.5 rotate-45 rounded-[2px] bg-corporate" />
        Corporate-backed
      </li>
      <li className="flex items-center gap-2">
        <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-independent" />
        Independent
      </li>
    </ul>
  );
}

export default function DiscoveryDashboard() {
  const discovery = use_discovery();
  const {
    mode,
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
    enter_fallback,
    refresh_location,
  } = discovery;

  const is_desktop = use_media_query(DESKTOP_MEDIA_QUERY);
  const [is_panel_open, set_is_panel_open] = useState(false);
  const [reported_listing, set_reported_listing] = useState<ReportedListing | null>(null);
  const [is_sheet_open, set_is_sheet_open] = useState(false);
  const [active_alternative_id, set_active_alternative_id] = useState<string | null>(null);
  const [scroll_request, set_scroll_request] = useState<ScrollRequest | null>(null);

  const selected_target_id = selected_result?.target.location_id ?? null;

  // A new target (or result set) starts with no highlighted alternative.
  useEffect(() => {
    set_active_alternative_id(null);
    set_scroll_request(null);
  }, [selected_target_id, payload]);

  // New results, or growing into the desktop layout, retire the mobile sheet.
  useEffect(() => {
    set_is_sheet_open(false);
  }, [payload, is_desktop]);

  const handle_select_target = useCallback(
    (index: number) => {
      set_selected_index(index);
      if (!is_desktop) set_is_sheet_open(true);
    },
    [is_desktop, set_selected_index],
  );

  /** A marker tap highlights its card and scrolls the carousel to it. */
  const handle_marker_select = useCallback((location_id: string) => {
    set_active_alternative_id(location_id);
    set_scroll_request((previous) => ({ location_id, request_key: (previous?.request_key ?? 0) + 1 }));
  }, []);

  const close_sheet = useCallback(() => set_is_sheet_open(false), []);

  const centroid_alternatives: AlternativeRecommendation[] =
    centroid_origin && results.length === 0 && payload ? payload.origin_alternatives : [];
  const show_centroid_view = centroid_alternatives.length > 0 && centroid_origin !== null;
  const carousel_layout = is_desktop ? "inline" : "sheet";

  const map_props = selected_result
    ? { target: selected_result.target, alternatives: selected_result.alternatives, target_kind: "corporate" as const }
    : show_centroid_view && centroid_origin
      ? { target: build_centroid_target(centroid_origin), alternatives: centroid_alternatives, target_kind: "origin" as const }
      : null;

  /* ---------------------------------------------------------------------- */

  const controls = (
    <>
      {catalog && (catalog.cities.length > 0 || catalog.verticals.length > 0) && (
        <ScopeSelectors catalog={catalog} scope={scope} on_change={apply_scope} />
      )}

      {mode === "locating" && (
        <p
          role="status"
          className="flex items-center gap-3 rounded-2xl bg-surface-card px-4 py-3 text-sm text-zinc-300 shadow-hairline"
        >
          <LocateIcon className="h-4 w-4 shrink-0 text-zinc-400 motion-safe:animate-pulse" />
          Finding corporate-backed spots near you… Please allow location access.
        </p>
      )}

      {mode === "located" && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 text-sm text-zinc-400">
          <span className="py-2">
            {cache_age_minutes === null
              ? "Showing results near your current location."
              : `Showing saved results from ${cache_age_minutes} min ago (kept up to ${GEOLOCATION_CACHE_TTL_MS / 60_000} min).`}
          </span>
          <span className="flex flex-wrap gap-x-4">
            {cache_age_minutes !== null && (
              <button
                type="button"
                onClick={refresh_location}
                className="inline-flex min-h-11 items-center font-semibold text-zinc-100 underline-offset-4 hover:underline"
              >
                Refresh my location
              </button>
            )}
            <button
              type="button"
              onClick={() => enter_fallback(null)}
              className="inline-flex min-h-11 items-center font-semibold text-zinc-100 underline-offset-4 hover:underline"
            >
              Browse by neighborhood instead
            </button>
          </span>
        </div>
      )}

      {mode === "fallback" && <NeighborhoodSearch {...discovery} />}
    </>
  );

  const map = map_props ? (
    <div>
      <div role="region" aria-label="Map of nearby independent alternatives" className="overflow-hidden rounded-2xl shadow-hairline">
        <IndependentMap
          {...map_props}
          active_alternative_id={active_alternative_id}
          on_select_alternative={handle_marker_select}
          className={MAP_HEIGHT_CLASSES}
        />
      </div>
      <MapLegend />
    </div>
  ) : (
    // Desktop keeps the map column's shape before results arrive; phones skip it.
    <div
      aria-hidden="true"
      className={`hidden items-center justify-center bg-surface-card text-sm text-zinc-500 shadow-hairline md:flex ${MAP_HEIGHT_CLASSES}`}
    >
      <span className="flex items-center gap-2">
        <StorefrontIcon /> The map appears once results load
      </span>
    </div>
  );

  const results_view = (
    // Reserve vertical space so late-arriving results don't shift the layout (CLS).
    <div className="min-h-[32rem] space-y-6">
      {fetch_state.status === "loading" && (
        <p className="text-sm text-zinc-400 motion-safe:animate-pulse" role="status">
          Finding independent alternatives…
        </p>
      )}
      {fetch_state.status === "outside_market" && (
        <div role="status" className="rounded-2xl bg-surface-card px-4 py-4 text-sm text-zinc-300 shadow-hairline">
          <p className="font-medium text-zinc-50">TrueOwn isn&apos;t available at your location yet.</p>
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
        <p role="alert" className="rounded-2xl bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {fetch_state.message}
        </p>
      )}

      {payload && results.length === 0 && payload.origin_alternatives.length === 0 && (
        <p className="rounded-2xl border border-dashed border-white/10 px-4 py-8 text-center text-sm text-zinc-400">
          {centroid_origin
            ? `No tracked Tier 1 or Tier 2 brands, or independents, near ${centroid_origin.name} yet.`
            : "No tracked corporate-backed brands near you yet. Try a neighborhood instead."}
        </p>
      )}

      {results.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-xs font-medium uppercase tracking-wider text-zinc-500">
            Corporate-backed near {centroid_origin ? centroid_origin.name : "you"}
          </h2>
          <CorporateTargetList
            results={results}
            selected_index={selected_index}
            on_select={handle_select_target}
            opens_dialog={!is_desktop}
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
            layout={carousel_layout}
          />
        </div>
      )}

      {/* Neighborhood with no corporate brands: still offer independents around its centre. */}
      {show_centroid_view && centroid_origin && (
        <AlternativesCarousel
          heading={`Independent spots within 1500m of ${centroid_origin.is_address ? "" : "the centre of "}${centroid_origin.name}.`}
          heading_id="centroid-alternatives-heading"
          alternatives={centroid_alternatives}
          active_alternative_id={active_alternative_id}
          on_activate={set_active_alternative_id}
          scroll_request={scroll_request}
          layout={carousel_layout}
        />
      )}
    </div>
  );

  function report_error_for(target: { location_id: string; brand_name: string; address: string }): void {
    set_reported_listing({ location_id: target.location_id, brand_name: target.brand_name, address: target.address });
  }

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
      <DiscoveryShell controls={controls} map={map} results={results_view} footer={footer} />

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
