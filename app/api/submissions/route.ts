import { NextRequest, NextResponse } from "next/server";
import { get_database_pool } from "@/lib/db/pool";
import { validate_evidence_url, validate_required_text } from "@/lib/validation";
import type { ApiErrorResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

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
  let request_body: unknown;
  try {
    request_body = await request.json();
  } catch {
    return error_response("Request body must be valid JSON.", 400);
  }

  if (typeof request_body !== "object" || request_body === null) {
    return error_response("Request body must be a JSON object.", 400);
  }
  const fields = request_body as Record<string, unknown>;

  const business_name = validate_required_text(fields.business_name, "Business name");
  if (!business_name.valid) return error_response(business_name.reason, 422);

  const street_address = validate_required_text(fields.street_address, "Street address", 300);
  if (!street_address.valid) return error_response(street_address.reason, 422);

  const evidence = validate_evidence_url(fields.evidence_url);
  if (!evidence.valid) return error_response(evidence.reason, 422);

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
