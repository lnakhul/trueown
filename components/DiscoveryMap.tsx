"use client";

import { useEffect, useMemo } from "react";
import L from "leaflet";
import { MapContainer, Marker, Popup, TileLayer, useMap } from "react-leaflet";
import { tile_config_from_env } from "@/lib/map-tiles";
import type { AlternativeRecommendation, NearbyCorporateResult } from "@/lib/types";

const TILE_CONFIG = tile_config_from_env();

/** Where the map rests before anything is found (the launch market). */
export const DEFAULT_MAP_CENTER: [number, number] = [40.7484, -73.9857];
const DEFAULT_ZOOM = 12;

function corporate_icon(is_selected: boolean): L.DivIcon {
  const size = is_selected ? 40 : 30;
  const c = size / 2;
  const outer = is_selected ? 15 : 12;
  const inner = is_selected ? 11 : 9;
  return L.divIcon({
    className: "trueown-marker",
    html: `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
      <rect x="${c - outer / 2}" y="${c - outer / 2}" width="${outer}" height="${outer}" rx="2.5" transform="rotate(45 ${c} ${c})" fill="#f59e0b" fill-opacity="${is_selected ? 0.32 : 0.2}"/>
      <rect x="${c - inner / 2}" y="${c - inner / 2}" width="${inner}" height="${inner}" rx="1.5" transform="rotate(45 ${c} ${c})" fill="#fbbf24" stroke="#09090b" stroke-width="1.5"/>
    </svg>`,
    iconSize: [size, size],
    iconAnchor: [c, c],
    popupAnchor: [0, -c + 4],
  });
}

function independent_icon(is_active: boolean): L.DivIcon {
  const size = is_active ? 34 : 22;
  const c = size / 2;
  return L.divIcon({
    className: "trueown-marker",
    html: `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
      ${is_active ? `<circle cx="${c}" cy="${c}" r="${c - 1}" fill="#34d399" fill-opacity="0.22"/>` : ""}
      <circle cx="${c}" cy="${c}" r="${is_active ? 8 : 6.5}" fill="#34d399" stroke="#09090b" stroke-width="2"/>
    </svg>`,
    iconSize: [size, size],
    iconAnchor: [c, c],
    popupAnchor: [0, -c + 2],
  });
}

/** Pulsing blue dot for the visitor's own position (animation lives in globals.css). */
const user_icon = L.divIcon({
  className: "trueown-marker trueown-user-dot",
  html: `<span class="trueown-user-dot__pulse"></span><span class="trueown-user-dot__core"></span>`,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

/** Neutral ring for a searched neighborhood centre or address. */
const origin_icon = L.divIcon({
  className: "trueown-marker",
  html: `<svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">
    <circle cx="14" cy="14" r="10" fill="#fafafa" fill-opacity="0.12"/>
    <circle cx="14" cy="14" r="5.5" fill="#fafafa" stroke="#09090b" stroke-width="2"/>
  </svg>`,
  iconSize: [28, 28],
  iconAnchor: [14, 14],
  popupAnchor: [0, -12],
});

const CORPORATE_ICON = corporate_icon(false);
const SELECTED_CORPORATE_ICON = corporate_icon(true);
const INDEPENDENT_ICON = independent_icon(false);
const ACTIVE_INDEPENDENT_ICON = independent_icon(true);

interface Point {
  latitude: number;
  longitude: number;
}

/** Fits the viewport to the points in focus; rests on the default center when there are none. */
function FitToPoints({ points, fit_key }: { points: Point[]; fit_key: string }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 0) {
      map.setView(DEFAULT_MAP_CENTER, DEFAULT_ZOOM);
      return;
    }
    if (points.length === 1) {
      map.setView([points[0]!.latitude, points[0]!.longitude], 15);
      return;
    }
    const bounds = L.latLngBounds(points.map((point) => [point.latitude, point.longitude] as [number, number]));
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
    // Re-fit only when the set in focus changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, fit_key]);
  return null;
}

/** Leaflet measures its box once; re-measure when the layout resizes it (breakpoints, rotation). */
function TrackSize() {
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(container);
    return () => observer.disconnect();
  }, [map]);
  return null;
}

/** Keeps the highlighted independent in view without re-fitting everything. */
function FollowActive({ active }: { active: AlternativeRecommendation | null }) {
  const map = useMap();
  useEffect(() => {
    if (!active) return;
    const position = L.latLng(active.latitude, active.longitude);
    if (!map.getBounds().pad(-0.1).contains(position)) map.panTo(position);
  }, [map, active]);
  return null;
}

export interface DiscoveryMapProps {
  results: NearbyCorporateResult[];
  /** Independents around a searched point that has no corporate storefronts. */
  origin_alternatives: AlternativeRecommendation[];
  /** Searched neighborhood centre or address (not the device position). */
  search_origin: (Point & { name: string }) | null;
  user_location: Point | null;
  /** When set, the map focuses on that storefront and its independents. */
  focused_target_id: string | null;
  selected_target_id: string | null;
  active_alternative_id: string | null;
  on_select_target: (location_id: string) => void;
  on_select_alternative: (location_id: string) => void;
  className?: string;
}

/**
 * Overview map: the visitor, every corporate-backed storefront nearby (amber
 * diamonds) and every independent (green dots). Tapping a diamond opens it.
 */
export default function DiscoveryMap({
  results,
  origin_alternatives,
  search_origin,
  user_location,
  focused_target_id,
  selected_target_id,
  active_alternative_id,
  on_select_target,
  on_select_alternative,
  className = "h-72 w-full",
}: DiscoveryMapProps) {
  // The same independent can be near several corporate storefronts: show it once.
  const alternatives = useMemo(() => {
    const by_id = new Map<string, AlternativeRecommendation>();
    for (const alternative of [...results.flatMap((result) => result.alternatives), ...origin_alternatives]) {
      if (!by_id.has(alternative.location_id)) by_id.set(alternative.location_id, alternative);
    }
    return [...by_id.values()];
  }, [results, origin_alternatives]);

  const focused = focused_target_id ? results.find((result) => result.target.location_id === focused_target_id) ?? null : null;
  const focus_points: Point[] = focused
    ? [focused.target, ...focused.alternatives]
    : [
        ...(user_location ? [user_location] : []),
        ...(search_origin ? [search_origin] : []),
        ...results.map((result) => result.target),
        ...alternatives,
      ];
  const fit_key = focused
    ? `focus:${focused.target.location_id}`
    : `all:${focus_points.length}:${focus_points.map((point) => `${point.latitude.toFixed(4)},${point.longitude.toFixed(4)}`).join("|")}`;
  const active = alternatives.find((alternative) => alternative.location_id === active_alternative_id) ?? null;

  return (
    <MapContainer center={DEFAULT_MAP_CENTER} zoom={DEFAULT_ZOOM} scrollWheelZoom={false} zoomControl={false} className={className}>
      <TileLayer
        attribution={TILE_CONFIG.attribution}
        url={TILE_CONFIG.url}
        subdomains={TILE_CONFIG.subdomains}
        maxZoom={TILE_CONFIG.max_zoom}
        className={TILE_CONFIG.needs_dark_filter ? "trueown-tiles-darkened" : undefined}
      />
      {user_location && (
        <Marker position={[user_location.latitude, user_location.longitude]} icon={user_icon} title="You are here" alt="You are here" zIndexOffset={200} interactive={false} />
      )}
      {search_origin && (
        <Marker position={[search_origin.latitude, search_origin.longitude]} icon={origin_icon} title={search_origin.name} alt={search_origin.name}>
          <Popup>{search_origin.name}</Popup>
        </Marker>
      )}
      {alternatives.map((alternative) => {
        const is_active = alternative.location_id === active_alternative_id;
        return (
          <Marker
            key={alternative.location_id}
            position={[alternative.latitude, alternative.longitude]}
            icon={is_active ? ACTIVE_INDEPENDENT_ICON : INDEPENDENT_ICON}
            title={alternative.brand_name}
            alt={`${alternative.brand_name}, independent`}
            zIndexOffset={is_active ? 900 : 0}
            eventHandlers={{ click: () => on_select_alternative(alternative.location_id) }}
          >
            <Popup>
              <span className="font-semibold">{alternative.brand_name}</span>
              <br />
              Independent
            </Popup>
          </Marker>
        );
      })}
      {results.map((result) => {
        const is_selected = result.target.location_id === selected_target_id;
        return (
          <Marker
            key={result.target.location_id}
            position={[result.target.latitude, result.target.longitude]}
            icon={is_selected ? SELECTED_CORPORATE_ICON : CORPORATE_ICON}
            title={result.target.brand_name}
            alt={`${result.target.brand_name}, corporate-backed`}
            zIndexOffset={is_selected ? 1000 : 500}
            eventHandlers={{ click: () => on_select_target(result.target.location_id) }}
          />
        );
      })}
      <TrackSize />
      <FitToPoints points={focus_points} fit_key={fit_key} />
      <FollowActive active={active} />
    </MapContainer>
  );
}
