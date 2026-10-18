/**
 * Cloudflare Turnstile server-side verification (siteverify).
 * Fail-closed: any network error, timeout, non-200 or malformed response is a failure.
 */
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const VERIFY_TIMEOUT_MS = 5000;
/** Turnstile tokens are at most 2048 characters. */
const MAX_TOKEN_LENGTH = 2048;

export type TurnstileResult =
  | { ok: true }
  | { ok: false; reason: "missing_token" | "invalid_token" | "verification_unavailable" };

/** Turnstile is enforced whenever a secret key is configured. */
export function is_turnstile_enabled(): boolean {
  return Boolean(process.env.TURNSTILE_SECRET_KEY?.trim());
}

export async function verify_turnstile_token(
  token: unknown,
  remote_ip: string | null,
  fetch_impl: typeof fetch = fetch,
): Promise<TurnstileResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) return { ok: false, reason: "verification_unavailable" };
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: "missing_token" };
  }

  const form = new URLSearchParams({ secret, response: token });
  if (remote_ip && remote_ip !== "unknown") form.set("remoteip", remote_ip);

  try {
    const response = await fetch_impl(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    const outcome: unknown = await response.json();
    if (typeof outcome !== "object" || outcome === null) {
      return { ok: false, reason: "verification_unavailable" };
    }
    const { success, "error-codes": error_codes } = outcome as {
      success?: unknown;
      "error-codes"?: unknown;
    };
    if (response.ok && success === true) return { ok: true };

    // Token-specific rejections are the client's problem (403); anything else
    // (bad secret, Cloudflare outage) is ours (503).
    const codes = Array.isArray(error_codes) ? error_codes : [];
    const token_rejected = codes.some(
      (code) => code === "invalid-input-response" || code === "timeout-or-duplicate",
    );
    if (token_rejected || (response.ok && codes.length === 0)) {
      return { ok: false, reason: "invalid_token" };
    }
    return { ok: false, reason: "verification_unavailable" };
  } catch {
    return { ok: false, reason: "verification_unavailable" };
  }
}
