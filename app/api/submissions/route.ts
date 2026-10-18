import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { get_database_pool } from "@/lib/db/pool";
import { create_anon_client } from "@/lib/supabase/server";
import { validate_evidence_url, validate_required_text } from "@/lib/validation";
import { create_rate_limiter, get_client_key } from "@/lib/rate-limit";
import { is_turnstile_enabled, verify_turnstile_token } from "@/lib/turnstile";
import type { ApiErrorResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

/** 5 tips per client per hour; the endpoint is public and writes to the database. */
const submission_limiter = create_rate_limiter(5, 60 * 60 * 1000);
const MAX_BODY_BYTES = 8 * 1024;

function error_response(message: string, status: number): NextResponse<ApiErrorResponse> {
  return NextResponse.json({ error: message }, { status });
}

/**
 * POST /api/submissions
 * Fail-closed gateway: every submission is stored as 'pending' and requires a
 * valid evidence URL. Client-supplied status values are ignored.
 */
export async function POST(
  request: NextRequest,
): Promise<NextResponse<{ id: string; status: "pending" } | ApiErrorResponse>> {
  const limit = submission_limiter.check(get_client_key(request.headers));
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many submissions. Please try again later." },
      { status: 429, headers: { "Retry-After": String(limit.retry_after_seconds) } },
    );
  }

  let request_body: unknown;
  try {
    const raw_body = await request.text();
    if (raw_body.length > MAX_BODY_BYTES) {
      return error_response("Request body is too large.", 413);
    }
    request_body = JSON.parse(raw_body);
  } catch {
    return error_response("Request body must be valid JSON.", 400);
  }

  if (typeof request_body !== "object" || request_body === null) {
    return error_response("Request body must be a JSON object.", 400);
  }
  const fields = request_body as Record<string, unknown>;

  // Honeypot: real users never see this field. Pretend success so bots learn nothing.
  if (typeof fields.website === "string" && fields.website.trim() !== "") {
    return NextResponse.json({ id: randomUUID(), status: "pending" }, { status: 201 });
  }

  // Human check runs before any validation work or database access.
  if (is_turnstile_enabled()) {
    const human_check = await verify_turnstile_token(
      fields.turnstile_token,
      get_client_key(request.headers),
    );
    if (!human_check.ok) {
      if (human_check.reason === "verification_unavailable") {
        return error_response("Verification is temporarily unavailable. Please try again.", 503);
      }
      return error_response("Please complete the human verification and try again.", 403);
    }
  }

  const business_name = validate_required_text(fields.business_name, "Business name");
  if (!business_name.valid) return error_response(business_name.reason, 422);

  const street_address = validate_required_text(fields.street_address, "Street address", 300);
  if (!street_address.valid) return error_response(street_address.reason, 422);

  const evidence = validate_evidence_url(fields.evidence_url);
  if (!evidence.valid) return error_response(evidence.reason, 422);

  // Preferred path: insert as the `anon` role so RLS is genuinely enforced.
  // The id is generated here because anon has no SELECT policy for RETURNING.
  const anon_client = create_anon_client();
  if (anon_client) {
    const submission_id = randomUUID();
    try {
      const { error } = await anon_client.from("submissions").insert({
        id: submission_id,
        business_name: business_name.value,
        street_address: street_address.value,
        evidence_url: evidence.normalized_url,
        status: "pending",
      });
      if (error) {
        console.error("[submissions] anon insert rejected:", error.code, error.message);
        return error_response("Submission could not be saved.", 500);
      }
      return NextResponse.json({ id: submission_id, status: "pending" }, { status: 201 });
    } catch (caught_error) {
      console.error("[submissions] anon insert failed:", caught_error);
      return error_response("Submission could not be saved.", 500);
    }
  }

  // Local Docker fallback: direct Postgres connection as the owner role.
  try {
    const insert_result = await get_database_pool().query<{ id: string }>(
      `INSERT INTO submissions (business_name, street_address, evidence_url, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING id`,
      [business_name.value, street_address.value, evidence.normalized_url],
    );
    const created_row = insert_result.rows[0];
    if (!created_row) {
      return error_response("Submission could not be saved.", 500);
    }
    return NextResponse.json({ id: created_row.id, status: "pending" }, { status: 201 });
  } catch (caught_error) {
    console.error("[submissions] insert failed:", caught_error);
    return error_response("Submission could not be saved.", 500);
  }
}
