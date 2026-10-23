/**
 * Where an ownership claim may be verified. Must stay in sync with the CHECK
 * constraint on brands.ownership_source_type and with approve_submission().
 * Tier 1/2 claims need corporate-record evidence; Tier 3 claims need registry,
 * editorial or community evidence.
 */
export const CORPORATE_SOURCE_TYPES = [
  "sec_edgar",
  "investor_press_release",
  "pitchbook",
  "crunchbase",
  "mergr",
  "reputable_news",
] as const;

export const INDEPENDENT_SOURCE_TYPES = [
  "state_business_registry",
  "local_press",
  "community_consensus",
  // Legacy NYC-specific values, still accepted.
  "nys_dos_corporations",
  "eater_ny",
] as const;

export type CorporateSourceType = (typeof CORPORATE_SOURCE_TYPES)[number];
export type IndependentSourceType = (typeof INDEPENDENT_SOURCE_TYPES)[number];
export type OwnershipSourceType = CorporateSourceType | IndependentSourceType;

/** Human labels for the admin console. */
export const SOURCE_TYPE_LABELS: Record<OwnershipSourceType, string> = {
  sec_edgar: "SEC EDGAR filing",
  investor_press_release: "Investor press release",
  pitchbook: "PitchBook profile",
  crunchbase: "Crunchbase profile",
  mergr: "Mergr deal record",
  reputable_news: "Major news outlet",
  state_business_registry: "State business registry",
  local_press: "Local press",
  community_consensus: "Community consensus",
  nys_dos_corporations: "NYS DOS corporations (legacy)",
  eater_ny: "Eater NY (legacy)",
};

export function source_types_for_tier(corporate_tier: 1 | 2 | 3): readonly OwnershipSourceType[] {
  return corporate_tier === 3 ? INDEPENDENT_SOURCE_TYPES : CORPORATE_SOURCE_TYPES;
}
