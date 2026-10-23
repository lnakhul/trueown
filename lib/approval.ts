import { source_types_for_tier, type OwnershipSourceType } from "@/lib/provenance";
import type { IndustryVertical } from "@/lib/types";

/** Admin-supplied facts required to promote a submission into live tables. */
export interface ApprovalInput {
  corporate_tier: 1 | 2 | 3;
  parent_entity: string | null;
  industry_vertical: IndustryVertical;
  unique_selling_proposition: string | null;
  /** Where the tier was verified; the submission's evidence URL becomes the audit link. */
  ownership_source_type: OwnershipSourceType;
  latitude: number;
  longitude: number;
}

export type ApprovalValidation =
  | { valid: true; input: ApprovalInput }
  | { valid: false; reason: string };

const INDUSTRY_VERTICALS: readonly IndustryVertical[] = [
  "coffee_bakery",
  "restaurant",
  "bar_nightlife",
  "retail_boutique",
  "fitness_wellness",
];

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function optional_text(raw_value: unknown, max_length: number): string | null | undefined {
  if (raw_value === undefined || raw_value === null) return null;
  if (typeof raw_value !== "string") return undefined;
  const trimmed_value = raw_value.trim();
  if (trimmed_value.length > max_length) return undefined;
  return trimmed_value.length === 0 ? null : trimmed_value;
}

function finite_in_range(raw_value: unknown, min: number, max: number): number | null {
  const parsed_value =
    typeof raw_value === "number" ? raw_value : typeof raw_value === "string" && raw_value.trim() !== "" ? Number(raw_value) : NaN;
  return Number.isFinite(parsed_value) && parsed_value >= min && parsed_value <= max
    ? parsed_value
    : null;
}

/** Strictly validates the approval payload; mirrors DB constraints for friendly errors. */
export function validate_approval_input(raw_body: unknown): ApprovalValidation {
  if (typeof raw_body !== "object" || raw_body === null) {
    return { valid: false, reason: "Request body must be a JSON object." };
  }
  const fields = raw_body as Record<string, unknown>;

  const corporate_tier = Number(fields.corporate_tier);
  if (corporate_tier !== 1 && corporate_tier !== 2 && corporate_tier !== 3) {
    return { valid: false, reason: "corporate_tier must be 1, 2, or 3." };
  }

  const parent_entity = optional_text(fields.parent_entity, 200);
  if (parent_entity === undefined) {
    return { valid: false, reason: "parent_entity is invalid." };
  }
  if (corporate_tier !== 3 && parent_entity === null) {
    return { valid: false, reason: "parent_entity is required for Tier 1 and Tier 2 brands." };
  }
  if (corporate_tier === 3 && parent_entity !== null) {
    return { valid: false, reason: "Tier 3 independents must not have a parent_entity." };
  }

  if (
    typeof fields.industry_vertical !== "string" ||
    !INDUSTRY_VERTICALS.includes(fields.industry_vertical as IndustryVertical)
  ) {
    return { valid: false, reason: "industry_vertical is invalid." };
  }

  const unique_selling_proposition = optional_text(fields.unique_selling_proposition, 300);
  if (unique_selling_proposition === undefined) {
    return { valid: false, reason: "unique_selling_proposition is invalid." };
  }

  const latitude = finite_in_range(fields.latitude, -90, 90);
  const longitude = finite_in_range(fields.longitude, -180, 180);
  if (latitude === null || longitude === null) {
    return { valid: false, reason: "latitude and longitude must be valid coordinates." };
  }

  const allowed_source_types = source_types_for_tier(corporate_tier);
  if (
    typeof fields.ownership_source_type !== "string" ||
    !(allowed_source_types as readonly string[]).includes(fields.ownership_source_type)
  ) {
    return {
      valid: false,
      reason: `ownership_source_type for Tier ${corporate_tier} must be one of: ${allowed_source_types.join(", ")}.`,
    };
  }

  return {
    valid: true,
    input: {
      corporate_tier,
      parent_entity,
      industry_vertical: fields.industry_vertical as IndustryVertical,
      unique_selling_proposition,
      ownership_source_type: fields.ownership_source_type as OwnershipSourceType,
      latitude,
      longitude,
    },
  };
}

export const MAX_REVIEW_NOTE_LENGTH = 500;

export type ReviewNoteValidation = { valid: true; review_note: string | null } | { valid: false; reason: string };

/** Optional note recorded with a rejection (empty body or blank note = none). */
export function validate_review_note(raw_body: unknown): ReviewNoteValidation {
  if (raw_body === undefined || raw_body === null) return { valid: true, review_note: null };
  if (typeof raw_body !== "object") return { valid: false, reason: "Request body must be a JSON object." };
  const review_note = optional_text((raw_body as Record<string, unknown>).review_note, MAX_REVIEW_NOTE_LENGTH);
  if (review_note === undefined) {
    return { valid: false, reason: `review_note must be text of at most ${MAX_REVIEW_NOTE_LENGTH} characters.` };
  }
  return { valid: true, review_note };
}
