"use client";

import { useEffect, useMemo } from "react";
import L from "leaflet";
import { MapContainer, Marker, Popup, TileLayer, useMap } from "react-leaflet";
import type { AlternativeRecommendation, SelectedLocation } from "@/lib/types";

const DARK_TILE_URL = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
const DARK_TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

/** Amber diamond for the corporate storefront. */
const corporate_marker_icon = L.divIcon({
  className: "trueown-marker",
  html: `<svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">
    <rect x="9" y="9" width="14" height="14" rx="2.5" transform="rotate(45 16 16)" fill="#f59e0b" fill-opacity="0.22"/>
    <rect x="11" y="11" width="10" height="10" rx="1.5" transform="rotate(45 16 16)" fill="#fbbf24" stroke="#09090b" stroke-width="1.5"/>
  </svg>`,
  iconSize: [32, 32],
  iconAnchor: [16, 16],
  popupAnchor: [0, -14],
});

/** Neutral ring for a searched point (neighborhood centre or address). */
const origin_marker_icon = L.divIcon({
  className: "trueown-marker",
  html: `<svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">
    <circle cx="14" cy="14" r="10" fill="#fafafa" fill-opacity="0.12"/>
    <circle cx="14" cy="14" r="5.5" fill="#fafafa" stroke="#09090b" stroke-width="2"/>
  </svg>`,
  iconSize: [28, 28],
  iconAnchor: [14, 14],
  popupAnchor: [0, -12],
});

function build_independent_icon(is_active: boolean): L.DivIcon {
  const size = is_active ? 34 : 22;
  const center = size / 2;
  return L.divIcon({
    className: "trueown-marker",
    html: `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
      ${is_active ? `<circle cx="${center}" cy="${center}" r="${center - 1}" fill="#34d399" fill-opacity="0.22"/>` : ""}
      <circle cx="${center}" cy="${center}" r="${is_active ? 8 : 6.5}" fill="#34d399" stroke="#09090b" stroke-width="2"/>
    </svg>`,
    iconSize: [size, size],
    iconAnchor: [center, center],
    popupAnchor: [0, -center + 2],
  });
}

const independent_marker_icon = build_independent_icon(false);
const active_independent_marker_icon = build_independent_icon(true);

/** Re-fits the viewport whenever the recommendation set changes. */
function FitToMarkers({
  target,
  alternatives,
}: {
  target: SelectedLocation;
  alternatives: AlternativeRecommendation[];
}) {
  const map = useMap();
  useEffect(() => {
    const bounds = L.latLngBounds([[target.latitude, target.longitude]]);
    alternatives.forEach((alternative) =>
      bounds.extend([alternative.latitude, alternative.longitude]),
    );
    map.fitBounds(bounds, { padding: [32, 32], maxZoom: 16 });
  }, [map, target, alternatives]);
  return null;
}

/** Keeps the highlighted alternative in view without re-fitting the whole set. */
function FollowActiveMarker({ active_alternative }: { active_alternative: AlternativeRecommendation | null }) {
  const map = useMap();
  useEffect(() => {
    if (!active_alternative) return;
    const position = L.latLng(active_alternative.latitude, active_alternative.longitude);
    if (!map.getBounds().pad(-0.1).contains(position)) map.panTo(position);
  }, [map, active_alternative]);
  return null;
}

export interface IndependentMapProps {
  target: SelectedLocation;
  alternatives: AlternativeRecommendation[];
  /** "origin" marks a searched point rather than a corporate storefront. */
  target_kind?: "corporate" | "origin";
  active_alternative_id?: string | null;
  on_select_alternative?: (location_id: string) => void;
  className?: string;
}

export default function IndependentMap({
  target,
  alternatives,
  target_kind = "corporate",
  active_alternative_id = null,
  on_select_alternative,
  className = "h-56 w-full rounded-2xl sm:h-72",
}: IndependentMapProps) {
  const active_alternative = useMemo(
    () => alternatives.find((alternative) => alternative.location_id === active_alternative_id) ?? null,
    [alternatives, active_alternative_id],
  );

  return (
    <MapContainer
      center={[target.latitude, target.longitude]}
      zoom={15}
      scrollWheelZoom={false}
      className={className}
    >
      <TileLayer attribution={DARK_TILE_ATTRIBUTION} url={DARK_TILE_URL} subdomains="abcd" maxZoom={20} />
      <Marker
        position={[target.latitude, target.longitude]}
        icon={target_kind === "corporate" ? corporate_marker_icon : origin_marker_icon}
        title={target.brand_name}
        alt={target.brand_name}
        zIndexOffset={500}
      >
        <Popup>{target.brand_name}</Popup>
      </Marker>
      {alternatives.map((alternative) => {
        const is_active = alternative.location_id === active_alternative_id;
        return (
          <Marker
            key={alternative.location_id}
            position={[alternative.latitude, alternative.longitude]}
            icon={is_active ? active_independent_marker_icon : independent_marker_icon}
            title={alternative.brand_name}
            alt={`${alternative.brand_name}, independent`}
            zIndexOffset={is_active ? 1000 : 0}
            eventHandlers={{ click: () => on_select_alternative?.(alternative.location_id) }}
          >
            <Popup>{alternative.brand_name}</Popup>
          </Marker>
        );
      })}
      <FitToMarkers target={target} alternatives={alternatives} />
      <FollowActiveMarker active_alternative={active_alternative} />
    </MapContainer>
  );
}
