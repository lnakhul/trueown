import { source_type_fits_tier, is_source_type, type OwnershipSourceType } from "@/lib/provenance";
import { validate_evidence_url } from "@/lib/validation";

/** Admin payloads for re-verifying or correcting a live brand claim. */

export const MAX_CORRECTION_NOTE_LENGTH = 500;
export const MAX_FINANCIAL_BACKERS = 20;
export const MAX_BACKER_LENGTH = 120;

export interface ReverifyInput {
  ownership_source_type: OwnershipSourceType;
  ownership_source_url: string;
}

export interface CorrectionInput extends ReverifyInput {
  corporate_tier: 1 | 2 | 3;
  parent_entity: string | null;
  financial_backers: string[];
  review_note: string;
}

type Validation<T> = { valid: true; input: T } | { valid: false; reason: string };

function as_record(raw_body: unknown): Record<string, unknown> | null {
  return typeof raw_body === "object" && raw_body !== null && !Array.isArray(raw_body)
    ? (raw_body as Record<string, unknown>)
    : null;
}

function read_source(fields: Record<string, unknown>): Validation<ReverifyInput> {
  if (!is_source_type(fields.ownership_source_type)) {
    return { valid: false, reason: "ownership_source_type is invalid." };
  }
  const url = validate_evidence_url(fields.ownership_source_url);
  if (!url.valid) return { valid: false, reason: `ownership_source_url: ${url.reason}` };
  return {
    valid: true,
    input: { ownership_source_type: fields.ownership_source_type, ownership_source_url: url.normalized_url },
  };
}

/** Re-verification keeps the claim; the database checks the source type fits the brand's tier. */
export function validate_reverify_input(raw_body: unknown): Validation<ReverifyInput> {
  const fields = as_record(raw_body);
  if (!fields) return { valid: false, reason: "Request body must be a JSON object." };
  return read_source(fields);
}

/** Accepts a list of names or a comma/semicolon-separated string. */
function read_backers(raw_value: unknown): string[] | null {
  if (raw_value === undefined || raw_value === null || raw_value === "") return [];
  const parts = Array.isArray(raw_value)
    ? raw_value
    : typeof raw_value === "string"
      ? raw_value.split(/[;,]/)
      : null;
  if (!parts || !parts.every((part) => typeof part === "string")) return null;
  const names = (parts as string[]).map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (names.length > MAX_FINANCIAL_BACKERS || names.some((name) => name.length > MAX_BACKER_LENGTH)) return null;
  return [...new Set(names)];
}

export function validate_correction_input(raw_body: unknown): Validation<CorrectionInput> {
  const fields = as_record(raw_body);
  if (!fields) return { valid: false, reason: "Request body must be a JSON object." };

  const corporate_tier = Number(fields.corporate_tier);
  if (corporate_tier !== 1 && corporate_tier !== 2 && corporate_tier !== 3) {
    return { valid: false, reason: "corporate_tier must be 1, 2, or 3." };
  }

  const raw_parent = typeof fields.parent_entity === "string" ? fields.parent_entity.trim() : "";
  if (raw_parent.length > 200) return { valid: false, reason: "parent_entity is longer than 200 characters." };
  if (corporate_tier !== 3 && !raw_parent) {
    return { valid: false, reason: "parent_entity is required for Tier 1 and Tier 2 brands." };
  }

  const financial_backers = read_backers(fields.financial_backers);
  if (financial_backers === null) {
    return {
      valid: false,
      reason: `financial_backers must list at most ${MAX_FINANCIAL_BACKERS} names of up to ${MAX_BACKER_LENGTH} characters.`,
    };
  }

  const source = read_source(fields);
  if (!source.valid) return source;
  if (!source_type_fits_tier(corporate_tier, source.input.ownership_source_type)) {
    return { valid: false, reason: `ownership_source_type does not fit Tier ${corporate_tier}.` };
  }

  const review_note = typeof fields.review_note === "string" ? fields.review_note.trim() : "";
  if (!review_note) return { valid: false, reason: "review_note is required: say why the claim is changing." };
  if (review_note.length > MAX_CORRECTION_NOTE_LENGTH) {
    return { valid: false, reason: `review_note is longer than ${MAX_CORRECTION_NOTE_LENGTH} characters.` };
  }

  return {
    valid: true,
    input: {
      corporate_tier,
      // Independents never carry a parent or backers.
      parent_entity: corporate_tier === 3 ? null : raw_parent,
      financial_backers: corporate_tier === 3 ? [] : financial_backers,
      review_note,
      ...source.input,
    },
  };
}
