import { UUID_PATTERN } from "@/lib/approval";
import { validate_evidence_url } from "@/lib/validation";

/** "Report an error" requests from owners, staff or anyone who knows a listing is wrong. */

export const CORRECTION_ISSUES = ["not_affiliated", "tier_wrong", "ownership_changed", "closed", "other"] as const;
export type CorrectionIssue = (typeof CORRECTION_ISSUES)[number];

export const ISSUE_LABELS: Record<CorrectionIssue, string> = {
  not_affiliated: "This business is not owned or funded by the listed company",
  tier_wrong: "The type of ownership is wrong",
  ownership_changed: "The ownership has changed",
  closed: "This location has closed",
  other: "Something else",
};

export const REPORTER_RELATIONSHIPS = ["owner", "employee", "customer", "other"] as const;
export type ReporterRelationship = (typeof REPORTER_RELATIONSHIPS)[number];

export const RELATIONSHIP_LABELS: Record<ReporterRelationship, string> = {
  owner: "I own this business",
  employee: "I work there",
  customer: "I'm a customer",
  other: "Other",
};

export const MIN_DETAILS_LENGTH = 10;
export const MAX_DETAILS_LENGTH = 2000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export interface CorrectionRequestInput {
  location_id: string;
  issue: CorrectionIssue;
  details: string;
  reporter_relationship: ReporterRelationship;
  contact_email: string | null;
  evidence_url: string | null;
}

export type CorrectionValidation = { valid: true; input: CorrectionRequestInput } | { valid: false; reason: string };

export function validate_correction_request(raw_body: unknown): CorrectionValidation {
  if (typeof raw_body !== "object" || raw_body === null || Array.isArray(raw_body)) {
    return { valid: false, reason: "Request body must be a JSON object." };
  }
  const fields = raw_body as Record<string, unknown>;

  if (typeof fields.location_id !== "string" || !UUID_PATTERN.test(fields.location_id)) {
    return { valid: false, reason: "Choose the business location you are reporting." };
  }
  if (!CORRECTION_ISSUES.includes(fields.issue as CorrectionIssue)) {
    return { valid: false, reason: "Choose what is wrong." };
  }
  if (!REPORTER_RELATIONSHIPS.includes(fields.reporter_relationship as ReporterRelationship)) {
    return { valid: false, reason: "Choose how you know this business." };
  }

  const details = typeof fields.details === "string" ? fields.details.trim() : "";
  if (details.length < MIN_DETAILS_LENGTH) {
    return { valid: false, reason: `Please describe the problem (at least ${MIN_DETAILS_LENGTH} characters).` };
  }
  if (details.length > MAX_DETAILS_LENGTH) {
    return { valid: false, reason: `Please keep the description under ${MAX_DETAILS_LENGTH} characters.` };
  }

  const raw_email = typeof fields.contact_email === "string" ? fields.contact_email.trim() : "";
  if (raw_email && (raw_email.length > 320 || !EMAIL_PATTERN.test(raw_email))) {
    return { valid: false, reason: "Enter a valid email address, or leave it blank." };
  }

  const raw_evidence = typeof fields.evidence_url === "string" ? fields.evidence_url.trim() : "";
  let evidence_url: string | null = null;
  if (raw_evidence) {
    const evidence = validate_evidence_url(raw_evidence);
    if (!evidence.valid) return { valid: false, reason: `Evidence link: ${evidence.reason}` };
    evidence_url = evidence.normalized_url;
  }

  return {
    valid: true,
    input: {
      location_id: fields.location_id,
      issue: fields.issue as CorrectionIssue,
      details,
      reporter_relationship: fields.reporter_relationship as ReporterRelationship,
      contact_email: raw_email ? raw_email.toLowerCase() : null,
      evidence_url,
    },
  };
}

export type CorrectionOutcome = "resolved" | "dismissed";

export type ResolutionValidation =
  | { valid: true; outcome: CorrectionOutcome; note: string | null }
  | { valid: false; reason: string };

export function validate_resolution(raw_body: unknown): ResolutionValidation {
  if (typeof raw_body !== "object" || raw_body === null) return { valid: false, reason: "Request body must be a JSON object." };
  const fields = raw_body as Record<string, unknown>;
  if (fields.outcome !== "resolved" && fields.outcome !== "dismissed") {
    return { valid: false, reason: "outcome must be resolved or dismissed." };
  }
  const note = typeof fields.note === "string" ? fields.note.trim() : "";
  if (note.length > 500) return { valid: false, reason: "note is longer than 500 characters." };
  if (fields.outcome === "dismissed" && !note) return { valid: false, reason: "Say why the report is being dismissed." };
  return { valid: true, outcome: fields.outcome, note: note || null };
}
