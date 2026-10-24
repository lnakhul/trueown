"use client";

import { useEffect } from "react";
import L from "leaflet";
import { MapContainer, Marker, Popup, TileLayer, useMap } from "react-leaflet";
import { tile_config_from_env } from "@/lib/map-tiles";

const TILE_CONFIG = tile_config_from_env();

export interface MapPoint {
  id: string;
  latitude: number;
  longitude: number;
  label: string;
  detail?: string;
  href?: string;
  kind: "corporate" | "independent";
}

function icon(kind: MapPoint["kind"]): L.DivIcon {
  const svg =
    kind === "corporate"
      ? `<svg viewBox="0 0 26 26" width="26" height="26" aria-hidden="true"><rect x="8" y="8" width="10" height="10" rx="1.8" transform="rotate(45 13 13)" fill="#fbbf24" stroke="#09090b" stroke-width="1.5"/></svg>`
      : `<svg viewBox="0 0 22 22" width="22" height="22" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="#34d399" stroke="#09090b" stroke-width="2"/></svg>`;
  const size = kind === "corporate" ? 26 : 22;
  return L.divIcon({ className: "trueown-marker", html: svg, iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2] });
}
const ICONS = { corporate: icon("corporate"), independent: icon("independent") };

function Fit({ points }: { points: MapPoint[] }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 1) map.setView([points[0]!.latitude, points[0]!.longitude], 15);
    else if (points.length > 1) map.fitBounds(L.latLngBounds(points.map((point) => [point.latitude, point.longitude] as [number, number])), { padding: [32, 32], maxZoom: 16 });
  }, [map, points]);
  useEffect(() => {
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(map.getContainer());
    return () => observer.disconnect();
  }, [map]);
  return null;
}

/** A small static-feeling map of a brand's or owner's locations. */
export default function LocationsMap({ points, className = "h-72 w-full" }: { points: MapPoint[]; className?: string }) {
  const first = points[0];
  return (
    <MapContainer
      center={first ? [first.latitude, first.longitude] : [40.7484, -73.9857]}
      zoom={13}
      scrollWheelZoom={false}
      className={className}
    >
      <TileLayer
        attribution={TILE_CONFIG.attribution}
        url={TILE_CONFIG.url}
        subdomains={TILE_CONFIG.subdomains}
        maxZoom={TILE_CONFIG.max_zoom}
        className={TILE_CONFIG.needs_dark_filter ? "trueown-tiles-darkened" : undefined}
      />
      {points.map((point) => (
        <Marker
          key={point.id}
          position={[point.latitude, point.longitude]}
          icon={ICONS[point.kind]}
          title={point.label}
          alt={point.label}
          zIndexOffset={point.kind === "corporate" ? 500 : 0}
        >
          <Popup>
            {point.href ? (
              <a href={point.href} className="font-semibold underline">
                {point.label}
              </a>
            ) : (
              <span className="font-semibold">{point.label}</span>
            )}
            {point.detail && (
              <>
                <br />
                {point.detail}
              </>
            )}
          </Popup>
        </Marker>
      ))}
      <Fit points={points} />
    </MapContainer>
  );
}
