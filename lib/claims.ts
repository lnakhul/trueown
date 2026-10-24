import { UUID_PATTERN } from "@/lib/approval";
import { validate_evidence_url } from "@/lib/validation";

/** "Claim your business": an owner confirms their shop is independently owned. */

export const CLAIMANT_ROLES = ["owner", "co_owner", "manager"] as const;
export type ClaimantRole = (typeof CLAIMANT_ROLES)[number];

export const CLAIMANT_ROLE_LABELS: Record<ClaimantRole, string> = {
  owner: "Owner",
  co_owner: "Co-owner",
  manager: "General manager",
};

export const INDEPENDENCE_STATEMENT =
  "I confirm this business is independently owned and operated: no private equity firm, venture capital fund or corporate parent owns it, controls it, or has invested in it.";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_PATTERN = /^[0-9+().\-\s]{7,40}$/;

export interface BusinessClaimInput {
  location_id: string | null;
  business_name: string;
  business_address: string;
  claimant_name: string;
  claimant_role: ClaimantRole;
  contact_email: string;
  contact_phone: string | null;
  website_url: string;
  details: string | null;
}

type Validation<T> = { valid: true; input: T } | { valid: false; reason: string };

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

export function validate_business_claim(raw_body: unknown): Validation<BusinessClaimInput> {
  if (typeof raw_body !== "object" || raw_body === null || Array.isArray(raw_body)) {
    return { valid: false, reason: "Request body must be a JSON object." };
  }
  const fields = raw_body as Record<string, unknown>;

  const raw_location = fields.location_id;
  if (raw_location !== undefined && raw_location !== null && raw_location !== "" &&
      (typeof raw_location !== "string" || !UUID_PATTERN.test(raw_location))) {
    return { valid: false, reason: "The listing could not be found." };
  }
  const location_id = typeof raw_location === "string" && raw_location ? raw_location : null;

  const business_name = text(fields.business_name, 200);
  const business_address = text(fields.business_address, 300);
  if (!location_id && (!business_name || !business_address)) {
    return { valid: false, reason: "Enter the business name and street address." };
  }
  const claimant_name = text(fields.claimant_name, 120);
  if (!claimant_name) return { valid: false, reason: "Enter your name." };
  if (!CLAIMANT_ROLES.includes(fields.claimant_role as ClaimantRole)) {
    return { valid: false, reason: "Choose your role at the business." };
  }
  const contact_email = typeof fields.contact_email === "string" ? fields.contact_email.trim().toLowerCase() : "";
  if (!contact_email || contact_email.length > 320 || !EMAIL_PATTERN.test(contact_email)) {
    return { valid: false, reason: "Enter a business email address we can reach you at." };
  }
  const raw_phone = typeof fields.contact_phone === "string" ? fields.contact_phone.trim() : "";
  if (raw_phone && !PHONE_PATTERN.test(raw_phone)) return { valid: false, reason: "Enter a valid phone number, or leave it blank." };
  const website = validate_evidence_url(fields.website_url);
  if (!website.valid) return { valid: false, reason: `Business website: ${website.reason}` };
  if (fields.attests_independent !== true) {
    return { valid: false, reason: "Please confirm the business is independently owned." };
  }
  const raw_details = typeof fields.details === "string" ? fields.details.trim() : "";
  if (raw_details.length > 2000) return { valid: false, reason: "Please keep the notes under 2000 characters." };

  return {
    valid: true,
    input: {
      location_id,
      business_name: business_name ?? "",
      business_address: business_address ?? "",
      claimant_name,
      claimant_role: fields.claimant_role as ClaimantRole,
      contact_email,
      contact_phone: raw_phone || null,
      website_url: website.normalized_url,
      details: raw_details || null,
    },
  };
}

export type ClaimOutcome = "verified" | "rejected";

export function validate_claim_resolution(
  raw_body: unknown,
): Validation<{ outcome: ClaimOutcome; note: string | null; record_evidence: boolean }> {
  if (typeof raw_body !== "object" || raw_body === null) return { valid: false, reason: "Request body must be a JSON object." };
  const fields = raw_body as Record<string, unknown>;
  if (fields.outcome !== "verified" && fields.outcome !== "rejected") {
    return { valid: false, reason: "outcome must be verified or rejected." };
  }
  const note = typeof fields.note === "string" ? fields.note.trim() : "";
  if (note.length > 500) return { valid: false, reason: "The note is longer than 500 characters." };
  if (fields.outcome === "rejected" && !note) return { valid: false, reason: "Say why the claim is rejected." };
  return {
    valid: true,
    input: { outcome: fields.outcome, note: note || null, record_evidence: fields.outcome === "verified" && fields.record_evidence === true },
  };
}
