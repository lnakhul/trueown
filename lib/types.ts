/**
 * Shared domain types. Names mirror the database taxonomy exactly.
 */

/** 1 = Majority PE buyout, 2 = VC / growth equity, 3 = True independent. */
export type CorporateTier = 1 | 2 | 3;

export type IndustryVertical =
  | "coffee_bakery"
  | "restaurant"
  | "bar_nightlife"
  | "retail_boutique"
  | "fitness_wellness";

/** The corporate storefront currently being viewed. */
export interface SelectedLocation {
  brand_name: string;
  corporate_tier: 1 | 2;
  parent_entity: string;
  address: string;
  latitude: number;
  longitude: number;
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

export interface ApiErrorResponse {
  error: string;
}

export interface CrowdsourcedSubmissionInput {
  business_name: string;
  street_address: string;
  evidence_url: string;
}
