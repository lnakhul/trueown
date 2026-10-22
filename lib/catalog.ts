import { INDUSTRY_VERTICALS, type IndustryVertical } from "@/lib/types";

/** Display names for the vertical selector. */
export const VERTICAL_LABELS: Record<IndustryVertical, string> = {
  coffee_bakery: "Coffee & bakeries",
  restaurant: "Restaurants",
  bar_nightlife: "Bars & nightlife",
  retail_boutique: "Retail & boutiques",
  fitness_wellness: "Fitness & wellness",
};

const MAX_CITY_LENGTH = 100;

/** Returns the vertical when it is a known enum value, otherwise null. */
export function parse_vertical(raw_value: string | null): IndustryVertical | null {
  if (raw_value === null) return null;
  return (INDUSTRY_VERTICALS as readonly string[]).includes(raw_value)
    ? (raw_value as IndustryVertical)
    : null;
}

/** Trims and bounds a city name; null means missing or invalid. */
export function parse_city(raw_value: string | null): string | null {
  if (raw_value === null) return null;
  const trimmed_value = raw_value.trim();
  if (trimmed_value.length === 0 || trimmed_value.length > MAX_CITY_LENGTH) return null;
  return trimmed_value;
}
