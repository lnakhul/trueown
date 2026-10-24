import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { validate_business_claim } from "@/lib/claims";
import { ClaimListingError, create_business_claim } from "@/lib/db/claims";
import { report_error } from "@/lib/monitoring";
import { get_client_key } from "@/lib/rate-limit";
import { create_shared_rate_limiter } from "@/lib/rate-limit-shared";
import { is_turnstile_enabled, verify_turnstile_token } from "@/lib/turnstile";
import type { ApiErrorResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

/** 3 claims per client per hour. */
const claim_limiter = create_shared_rate_limiter("claims", 3, 60 * 60 * 1000);
const MAX_BODY_BYTES = 8 * 1024;

function error_response(message: string, status: number): NextResponse<ApiErrorResponse> {
  return NextResponse.json({ error: message }, { status });
}

/** POST /api/claims — "Claim your business". Stored for an admin to verify; nothing on the site changes. */
export async function POST(request: NextRequest): Promise<NextResponse<{ id: string; status: "open" } | ApiErrorResponse>> {
  const limit = await claim_limiter.check(get_client_key(request.headers));
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many claims. Please try again later." },
      { status: 429, headers: { "Retry-After": String(limit.retry_after_seconds) } },
    );
  }

  let request_body: unknown;
  try {
    const raw_body = await request.text();
    if (raw_body.length > MAX_BODY_BYTES) return error_response("Request body is too large.", 413);
    request_body = JSON.parse(raw_body);
  } catch {
    return error_response("Request body must be valid JSON.", 400);
  }
  if (typeof request_body !== "object" || request_body === null) return error_response("Request body must be a JSON object.", 400);
  const fields = request_body as Record<string, unknown>;

  // Honeypot: real users never see this field. Pretend success so bots learn nothing.
  if (typeof fields.website === "string" && fields.website.trim() !== "") {
    return NextResponse.json({ id: randomUUID(), status: "open" }, { status: 201 });
  }
  if (is_turnstile_enabled()) {
    const human_check = await verify_turnstile_token(fields.turnstile_token, get_client_key(request.headers));
    if (!human_check.ok) {
      if (human_check.reason === "verification_unavailable") {
        return error_response("Verification is temporarily unavailable. Please try again.", 503);
      }
      return error_response("Please complete the human verification and try again.", 403);
    }
  }

  const validation = validate_business_claim(request_body);
  if (!validation.valid) return error_response(validation.reason, 422);

  try {
    const claim_id = await create_business_claim(validation.input);
    return NextResponse.json({ id: claim_id, status: "open" }, { status: 201 });
  } catch (caught_error) {
    if (caught_error instanceof ClaimListingError) return error_response(caught_error.message, caught_error.status);
    report_error("[claims] insert failed", caught_error);
    return error_response("Your claim could not be saved. Please try again.", 500);
  }
}
