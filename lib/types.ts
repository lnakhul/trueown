/**
 * Shared domain types. Names mirror the database taxonomy exactly.
 */

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
    | { kind: "neighborhood"; neighborhood: string; latitude: number; longitude: number };
  radius_meters: number;
  results: NearbyCorporateResult[];
  /**
   * Tier 3 independents within 1500m of the neighborhood centroid, closest first.
   * Always empty for coordinate origins.
   */
  origin_alternatives: AlternativeRecommendation[];
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
  suggestions: string[];
}

export interface ApiErrorResponse {
  error: string;
}

export interface CrowdsourcedSubmissionInput {
  business_name: string;
  street_address: string;
  evidence_url: string;
}
