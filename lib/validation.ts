/**
 * Evidence URL validation shared by the client form and the server gateway.
 * The server is the source of truth; the client copy only improves UX.
 */

const MAX_URL_LENGTH = 2048;

/** Hostname: dot-separated labels ending in an alphabetic TLD (>= 2 chars). */
const DOMAIN_PATTERN =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export type ValidationResult =
  | { valid: true; normalized_url: string }
  | { valid: false; reason: string };

export function validate_evidence_url(raw_value: unknown): ValidationResult {
  if (typeof raw_value !== "string") {
    return { valid: false, reason: "Evidence URL is required." };
  }
  const trimmed_value = raw_value.trim();
  if (trimmed_value.length === 0) {
    return { valid: false, reason: "Evidence URL is required." };
  }
  if (trimmed_value.length > MAX_URL_LENGTH) {
    return { valid: false, reason: "Evidence URL is too long." };
  }

  let parsed_url: URL;
  try {
    parsed_url = new URL(trimmed_value);
  } catch {
    return {
      valid: false,
      reason: "Enter a full link, e.g. https://example.com/article.",
    };
  }

  if (parsed_url.protocol !== "https:" && parsed_url.protocol !== "http:") {
    return { valid: false, reason: "Link must start with http:// or https://." };
  }
  if (parsed_url.username || parsed_url.password) {
    return { valid: false, reason: "Link must not contain credentials." };
  }
  if (!DOMAIN_PATTERN.test(parsed_url.hostname)) {
    return { valid: false, reason: "Link must point to a valid domain." };
  }

  return { valid: true, normalized_url: parsed_url.toString() };
}

export function validate_required_text(
  raw_value: unknown,
  field_label: string,
  max_length = 200,
): { valid: true; value: string } | { valid: false; reason: string } {
  if (typeof raw_value !== "string" || raw_value.trim().length === 0) {
    return { valid: false, reason: `${field_label} is required.` };
  }
  const trimmed_value = raw_value.trim();
  if (trimmed_value.length > max_length) {
    return { valid: false, reason: `${field_label} is too long.` };
  }
  return { valid: true, value: trimmed_value };
}
