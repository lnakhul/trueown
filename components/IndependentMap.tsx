"use client";

import { useEffect } from "react";
import L from "leaflet";
import { CircleMarker, MapContainer, Marker, Popup, TileLayer, useMap } from "react-leaflet";
import type { AlternativeRecommendation, SelectedLocation } from "@/lib/types";

/** Bundlers break Leaflet's default icon URLs; use a CDN-hosted icon explicitly. */
const independent_marker_icon = L.icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
});

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

export interface IndependentMapProps {
  target: SelectedLocation;
  alternatives: AlternativeRecommendation[];
}

export default function IndependentMap({ target, alternatives }: IndependentMapProps) {
  return (
    <MapContainer
      center={[target.latitude, target.longitude]}
      zoom={15}
      scrollWheelZoom={false}
      className="h-56 w-full rounded-xl sm:h-72"
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <CircleMarker
        center={[target.latitude, target.longitude]}
        radius={10}
        pathOptions={{ color: "#f59e0b", fillColor: "#f59e0b", fillOpacity: 0.6 }}
      >
        <Popup>{target.brand_name}</Popup>
      </CircleMarker>
      {alternatives.map((alternative) => (
        <Marker
          key={alternative.location_id}
          position={[alternative.latitude, alternative.longitude]}
          icon={independent_marker_icon}
        >
          <Popup>{alternative.brand_name}</Popup>
        </Marker>
      ))}
      <FitToMarkers target={target} alternatives={alternatives} />
    </MapContainer>
  );
}
