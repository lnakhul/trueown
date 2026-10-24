"use client";

import dynamic from "next/dynamic";
import type { MapPoint } from "./LocationsMap";

/** Leaflet touches `window`, so the map loads in the browser only. */
const LocationsMap = dynamic(() => import("./LocationsMap"), {
  ssr: false,
  loading: () => <div className="h-72 w-full animate-pulse bg-surface-card md:h-96" />,
});

export default function LocationsMapClient({ points }: { points: MapPoint[] }) {
  return <LocationsMap points={points} className="h-72 w-full md:h-96" />;
}
