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

export function is_source_type(value: unknown): value is OwnershipSourceType {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(SOURCE_TYPE_LABELS, value);
}

export function source_type_fits_tier(corporate_tier: 1 | 2 | 3, source_type: string): boolean {
  return (source_types_for_tier(corporate_tier) as readonly string[]).includes(source_type);
}

/** A claim verified longer ago than this is flagged for re-verification. */
export const PROVENANCE_STALE_AFTER_DAYS = 365;

/** Where a brand's ownership claim was verified, as shown publicly. */
export interface OwnershipSource {
  source_type: string;
  source_url: string;
  /** YYYY-MM-DD */
  verified_on: string;
}

export type ProvenanceStatus = "missing" | "stale" | "current";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parse_iso_date(value: string): Date | null {
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function provenance_status(source: OwnershipSource | null, today: Date = new Date()): ProvenanceStatus {
  const verified = source ? parse_iso_date(source.verified_on) : null;
  if (!source || !verified) return "missing";
  const age_days = (today.getTime() - verified.getTime()) / 86_400_000;
  return age_days > PROVENANCE_STALE_AFTER_DAYS ? "stale" : "current";
}

/** "Oct 2026" (dates are calendar dates, so format in UTC to avoid timezone drift). */
export function format_verified_month(verified_on: string): string {
  const parsed = parse_iso_date(verified_on);
  if (!parsed) return verified_on;
  return parsed.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

export function source_type_label(source_type: string): string {
  return is_source_type(source_type) ? SOURCE_TYPE_LABELS[source_type] : source_type.replace(/_/g, " ");
}
