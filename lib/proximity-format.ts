/** Standard average walking pace (~4.8 km/h) used for the display estimate only. */
export const WALKING_METERS_PER_MINUTE = 80;

/** Alternatives are only returned within this radius (meters); badges show distance as a share of it. */
export const PROXIMITY_RADIUS_METERS = 1500;

export interface ProximityEstimate {
  /** Whole minutes on foot, rounded up, never less than 1. */
  minutes: number;
  /** Straight-line distance, rounded to the nearest meter. */
  meters: number;
  /** e.g. "3 min walk • 140m away". */
  label: string;
}

/** Whole walking minutes for a distance: rounded up, with a 1-minute floor. */
export function estimate_walking_minutes(distance_meters: number): number {
  const meters = Math.max(0, Math.round(distance_meters));
  return Math.max(1, Math.ceil(meters / WALKING_METERS_PER_MINUTE));
}

/** The single walking formula shared by the API and the UI. */
export function format_proximity(distance_meters: number): ProximityEstimate {
  const meters = Math.max(0, Math.round(Number(distance_meters)));
  const minutes = estimate_walking_minutes(meters);
  return { minutes, meters, label: `${minutes} min walk • ${meters}m away` };
}

/** Distance as a 0–1 share of the search radius, for the badge's radial arc. */
export function proximity_share(distance_meters: number, radius_meters = PROXIMITY_RADIUS_METERS): number {
  if (!(radius_meters > 0) || !Number.isFinite(distance_meters)) return 0;
  return Math.min(1, Math.max(0, distance_meters / radius_meters));
}
