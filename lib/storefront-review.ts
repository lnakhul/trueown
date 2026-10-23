import { UUID_PATTERN } from "@/lib/approval";
import { source_type_fits_tier, type OwnershipSourceType } from "@/lib/provenance";
import { validate_evidence_url } from "@/lib/validation";

/** Admin payloads for the storefront review queue. */

export const MAX_STOREFRONT_BATCH = 500;

type Validation<T> = { valid: true; input: T } | { valid: false; reason: string };

function as_record(raw_body: unknown): Record<string, unknown> | null {
  return typeof raw_body === "object" && raw_body !== null && !Array.isArray(raw_body)
    ? (raw_body as Record<string, unknown>)
    : null;
}

function read_ids(raw_value: unknown): string[] | null {
  if (!Array.isArray(raw_value) || raw_value.length === 0 || raw_value.length > MAX_STOREFRONT_BATCH) return null;
  if (!raw_value.every((value) => typeof value === "string" && UUID_PATTERN.test(value))) return null;
  return [...new Set(raw_value as string[])];
}

export function validate_approve_storefronts(raw_body: unknown): Validation<{ candidate_ids: string[]; brand_id: string | null }> {
  const fields = as_record(raw_body);
  if (!fields) return { valid: false, reason: "Request body must be a JSON object." };
  const candidate_ids = read_ids(fields.candidate_ids);
  if (!candidate_ids) return { valid: false, reason: `candidate_ids must list 1 to ${MAX_STOREFRONT_BATCH} ids.` };
  const brand_id = fields.brand_id ?? null;
  if (brand_id !== null && (typeof brand_id !== "string" || !UUID_PATTERN.test(brand_id))) {
    return { valid: false, reason: "brand_id is invalid." };
  }
  return { valid: true, input: { candidate_ids, brand_id: brand_id as string | null } };
}

export function validate_reject_storefronts(raw_body: unknown): Validation<{ candidate_ids: string[]; note: string }> {
  const fields = as_record(raw_body);
  if (!fields) return { valid: false, reason: "Request body must be a JSON object." };
  const candidate_ids = read_ids(fields.candidate_ids);
  if (!candidate_ids) return { valid: false, reason: `candidate_ids must list 1 to ${MAX_STOREFRONT_BATCH} ids.` };
  const note = typeof fields.note === "string" ? fields.note.trim() : "";
  if (!note) return { valid: false, reason: "Give a reason (for example: a chain we don't track, closed, not a café)." };
  if (note.length > 500) return { valid: false, reason: "The reason is longer than 500 characters." };
  return { valid: true, input: { candidate_ids, note } };
}

export interface AddIndependentInput {
  candidate_id: string;
  brand_name: string;
  ownership_source_type: OwnershipSourceType;
  ownership_source_url: string;
}

/** A new independent is an ownership claim: it needs Tier 3 evidence. */
export function validate_add_independent(raw_body: unknown): Validation<AddIndependentInput> {
  const fields = as_record(raw_body);
  if (!fields) return { valid: false, reason: "Request body must be a JSON object." };
  if (typeof fields.candidate_id !== "string" || !UUID_PATTERN.test(fields.candidate_id)) {
    return { valid: false, reason: "candidate_id is invalid." };
  }
  const brand_name = typeof fields.brand_name === "string" ? fields.brand_name.replace(/\s+/g, " ").trim() : "";
  if (!brand_name || brand_name.length > 200) return { valid: false, reason: "Enter the business name (max 200 characters)." };
  const source_type = fields.ownership_source_type;
  if (typeof source_type !== "string" || !source_type_fits_tier(3, source_type)) {
    return { valid: false, reason: "Choose evidence that the business is independent." };
  }
  const url = validate_evidence_url(fields.ownership_source_url);
  if (!url.valid) return { valid: false, reason: `Evidence link: ${url.reason}` };
  return {
    valid: true,
    input: {
      candidate_id: fields.candidate_id,
      brand_name,
      ownership_source_type: source_type as OwnershipSourceType,
      ownership_source_url: url.normalized_url,
    },
  };
}
