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

export interface AddCorporateBrandInput {
  candidate_id: string;
  brand_name: string;
  corporate_tier: 1 | 2;
  parent_entity: string;
  financial_backers: string[];
  ownership_source_type: OwnershipSourceType;
  ownership_source_url: string;
}

const MAX_BACKERS = 20;
const MAX_BACKER_LENGTH = 120;

/** A PE/VC claim needs a parent, corporate-record evidence and (optionally) named backers. */
export function validate_add_corporate_brand(raw_body: unknown): Validation<AddCorporateBrandInput> {
  const fields = as_record(raw_body);
  if (!fields) return { valid: false, reason: "Request body must be a JSON object." };
  if (typeof fields.candidate_id !== "string" || !UUID_PATTERN.test(fields.candidate_id)) {
    return { valid: false, reason: "candidate_id is invalid." };
  }
  const brand_name = typeof fields.brand_name === "string" ? fields.brand_name.replace(/\s+/g, " ").trim() : "";
  if (!brand_name || brand_name.length > 200) return { valid: false, reason: "Enter the brand name (max 200 characters)." };
  const corporate_tier = Number(fields.corporate_tier);
  if (corporate_tier !== 1 && corporate_tier !== 2) {
    return { valid: false, reason: "Choose Tier 1 (PE owned) or Tier 2 (VC / growth equity)." };
  }
  const parent_entity = typeof fields.parent_entity === "string" ? fields.parent_entity.replace(/\s+/g, " ").trim() : "";
  if (!parent_entity || parent_entity.length > 200) {
    return { valid: false, reason: "Enter the owner or lead investor (max 200 characters)." };
  }
  const raw_backers = fields.financial_backers;
  const backer_parts = Array.isArray(raw_backers)
    ? raw_backers
    : typeof raw_backers === "string"
      ? raw_backers.split(/[;,]/)
      : raw_backers === undefined || raw_backers === null
        ? []
        : null;
  if (!backer_parts || !backer_parts.every((part) => typeof part === "string")) {
    return { valid: false, reason: "financial_backers must be a list of names." };
  }
  const financial_backers = [...new Set((backer_parts as string[]).map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean))];
  if (financial_backers.length > MAX_BACKERS || financial_backers.some((name) => name.length > MAX_BACKER_LENGTH)) {
    return { valid: false, reason: `List at most ${MAX_BACKERS} backers of up to ${MAX_BACKER_LENGTH} characters.` };
  }
  const source_type = fields.ownership_source_type;
  if (typeof source_type !== "string" || !source_type_fits_tier(corporate_tier, source_type)) {
    return { valid: false, reason: "Choose corporate-record evidence (filing, investor release, deal database or major news)." };
  }
  const url = validate_evidence_url(fields.ownership_source_url);
  if (!url.valid) return { valid: false, reason: `Evidence link: ${url.reason}` };
  return {
    valid: true,
    input: {
      candidate_id: fields.candidate_id,
      brand_name,
      corporate_tier,
      parent_entity,
      financial_backers,
      ownership_source_type: source_type as OwnershipSourceType,
      ownership_source_url: url.normalized_url,
    },
  };
}

export function validate_reopen_storefronts(raw_body: unknown): Validation<{ candidate_ids: string[]; note: string | null }> {
  const fields = as_record(raw_body);
  if (!fields) return { valid: false, reason: "Request body must be a JSON object." };
  const candidate_ids = read_ids(fields.candidate_ids);
  if (!candidate_ids) return { valid: false, reason: `candidate_ids must list 1 to ${MAX_STOREFRONT_BATCH} ids.` };
  const note = typeof fields.note === "string" ? fields.note.trim() : "";
  if (note.length > 500) return { valid: false, reason: "The note is longer than 500 characters." };
  return { valid: true, input: { candidate_ids, note: note || null } };
}
