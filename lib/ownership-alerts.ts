import { validate_correction_input, validate_reverify_input, type CorrectionInput, type ReverifyInput } from "@/lib/brand-review";

/** How an admin closes an ownership alert. */
export type AlertResolution =
  | { action: "dismiss"; note: string }
  | { action: "reverify"; input: ReverifyInput }
  | { action: "correct"; input: CorrectionInput };

export const DISMISS_REASONS = [
  "Not about this brand",
  "Not an ownership change",
  "Already reflected on the listing",
] as const;

export const SIGNAL_LABELS = {
  acquisition: "Acquisition",
  investment: "Investment",
  public_offering: "Public offering",
} as const;

export const ALERT_SOURCE_LABELS = {
  gdelt_news: "News",
  sec_edgar: "SEC filing",
} as const;

type Validation<T> = { valid: true; resolution: T } | { valid: false; reason: string };

export function validate_alert_resolution(raw_body: unknown): Validation<AlertResolution> {
  if (typeof raw_body !== "object" || raw_body === null || Array.isArray(raw_body)) {
    return { valid: false, reason: "Request body must be a JSON object." };
  }
  const fields = raw_body as Record<string, unknown>;
  if (fields.action === "dismiss") {
    const note = typeof fields.note === "string" ? fields.note.replace(/\s+/g, " ").trim() : "";
    if (!note) return { valid: false, reason: "Say why the alert is dismissed." };
    if (note.length > 500) return { valid: false, reason: "The reason is longer than 500 characters." };
    return { valid: true, resolution: { action: "dismiss", note } };
  }
  if (fields.action === "reverify") {
    const validation = validate_reverify_input(fields);
    return validation.valid ? { valid: true, resolution: { action: "reverify", input: validation.input } } : validation;
  }
  if (fields.action === "correct") {
    const validation = validate_correction_input(fields);
    return validation.valid ? { valid: true, resolution: { action: "correct", input: validation.input } } : validation;
  }
  return { valid: false, reason: "action must be dismiss, reverify or correct." };
}
