import type { CorporateTier } from "@/lib/types";

/** Short ownership tags for compact rows (search results, chips). */
export const OWNERSHIP_TAG: Record<CorporateTier, string> = {
  1: "Private equity owned",
  2: "Venture capital funded",
  3: "Independent",
};

/** "150m" under a kilometre, then "1.2 km", then whole kilometres. */
export function format_distance(meters: number): string {
  if (meters < 1000) return `${Math.max(0, Math.round(meters / 10) * 10)}m`;
  const km = meters / 1000;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

/** "Blank Street Coffee" / "Blank Street Coffee and Maman" / "A, B and 3 more". */
export function summarize_names(names: string[], max_shown = 2): string {
  if (names.length <= max_shown) return names.length === 2 ? `${names[0]} and ${names[1]}` : (names[0] ?? "");
  const rest = names.length - max_shown;
  return `${names.slice(0, max_shown).join(", ")} and ${rest} more`;
}
