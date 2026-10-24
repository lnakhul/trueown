/**
 * Shared domain types. Names mirror the database taxonomy exactly.
 */
import type { OwnershipSource } from "@/lib/provenance";

/** 1 = Majority PE buyout, 2 = VC / growth equity, 3 = True independent. */
export type CorporateTier = 1 | 2 | 3;

/** Mirrors the `industry_vertical` Postgres enum; keep both in sync. */
export const INDUSTRY_VERTICALS = [
  "coffee_bakery",
  "restaurant",
  "bar_nightlife",
  "retail_boutique",
  "fitness_wellness",
] as const;

export type IndustryVertical = (typeof INDUSTRY_VERTICALS)[number];

/** The corporate storefront currently being viewed. */
export interface SelectedLocation {
  brand_name: string;
  corporate_tier: 1 | 2;
  parent_entity: string;
  /** Named investors; empty when none are recorded. */
  financial_backers: string[];
  /** Public evidence for the ownership claim; null when none is recorded yet. */
  ownership_source: OwnershipSource | null;
  address: string;
  latitude: number;
  longitude: number;
}

/** A corporate storefront surfaced by location or neighborhood discovery. */
export interface CorporateTarget extends SelectedLocation {
  location_id: string;
  neighborhood: string | null;
  /** Straight-line meters from the user; null for neighborhood browsing. */
  distance_meters: number | null;
}

/** A single independent (Tier 3) recommendation returned by the proximity API. */
export interface AlternativeRecommendation {
  location_id: string;
  brand_name: string;
  address: string;
  neighborhood: string | null;
  unique_selling_proposition: string | null;
  distance_meters: number;
  latitude: number;
  longitude: number;
}

export interface ProximityResponse {
  target_brand_name: string;
  target_corporate_tier: CorporateTier;
  industry_vertical: IndustryVertical;
  radius_meters: number;
  alternatives: AlternativeRecommendation[];
}

export interface NearbyCorporateResult {
  target: CorporateTarget;
  alternatives: AlternativeRecommendation[];
}

/** Response for `scope=nearest` (user coordinates) and `neighborhood=` lookups. */
export interface NearbyResponse {
  origin:
    | { kind: "coordinates"; latitude: number; longitude: number }
    | { kind: "neighborhood"; neighborhood: string; latitude: number; longitude: number }
    /** A street address resolved by the geocoder; `label` is the text the user typed. */
    | { kind: "address"; label: string; latitude: number; longitude: number }
    /** Every location of one brand (nearest to `anchor` first when it is the user). */
    | ({ kind: "brand"; brand: BrandSuggestion } & CollectionOrigin)
    /** Every corporate-backed location whose parent or a named backer is `owner`. */
    | ({ kind: "owner"; owner: OwnerSuggestion } & CollectionOrigin);
  radius_meters: number;
  results: NearbyCorporateResult[];
  /**
   * Tier 3 independents within 1500m of the neighborhood centroid, closest first.
   * Always empty for coordinate origins.
   */
  origin_alternatives: AlternativeRecommendation[];
}

/** Where a brand or owner view is measured from, and how much of it is shown. */
export interface CollectionOrigin {
  /** "user": distances are from the visitor; "none": no position was given, so distances are not meaningful. */
  anchor: "user" | "none";
  /** Map centre for the view: the visitor, or the first location shown. */
  latitude: number;
  longitude: number;
  /** All matching locations in active markets; at most MAX_COLLECTION_LOCATIONS are returned. */
  total_locations: number;
}

/** A published brand that matches the search text. */
export interface BrandSuggestion {
  brand_id: string;
  name: string;
  corporate_tier: CorporateTier;
  industry_vertical: IndustryVertical;
  /** Locations in active markets (within the city filter, when set). */
  location_count: number;
  /** Straight-line meters to the closest location when the visitor's position was given. */
  nearest_distance_meters: number | null;
}

/** A parent company or named backer of at least one corporate-backed brand. */
export interface OwnerSuggestion {
  name: string;
  /** The brands it owns or backs, alphabetical. */
  brand_names: string[];
}

export type MarketStatus = "active" | "coming_soon";

/** A regional market (city) and its straight-line distance from a queried point. */
export interface MarketSummary {
  id: string;
  city_name: string;
  status: MarketStatus;
  latitude: number;
  longitude: number;
  distance_meters: number;
}

/**
 * Returned (HTTP 200) when the coordinates are not within 50 miles of any active
 * market. `closest_active_market` is null only when no market is active at all.
 */
export interface OutsideMarketResponse {
  status: "outside_active_market";
  message: string;
  closest_active_market: MarketSummary | null;
}

/** Cities and verticals that currently have tracked storefronts, for the selectors. */
export interface CatalogResponse {
  cities: string[];
  verticals: IndustryVertical[];
}

export interface NeighborhoodsResponse {
  neighborhoods: string[];
}

export interface NeighborhoodSuggestionsResponse {
  /** Neighborhood names. */
  suggestions: string[];
  brands: BrandSuggestion[];
  owners: OwnerSuggestion[];
}

export interface ApiErrorResponse {
  error: string;
}

export interface CrowdsourcedSubmissionInput {
  business_name: string;
  street_address: string;
  evidence_url: string;
}
