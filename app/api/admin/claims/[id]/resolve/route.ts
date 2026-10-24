import { NextRequest, NextResponse } from "next/server";
import { UUID_PATTERN } from "@/lib/approval";
import { require_admin } from "@/lib/auth/admin-session";
import { validate_claim_resolution } from "@/lib/claims";
import { ClaimChangeRejectedError, resolve_business_claim } from "@/lib/db/claims";
import { report_error } from "@/lib/monitoring";
import type { ApiErrorResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

function error_response(message: string, status: number): NextResponse<ApiErrorResponse> {
  return NextResponse.json({ error: message }, { status });
}

/** POST /api/admin/claims/:id/resolve  body: { outcome: "verified" | "rejected", note?, record_evidence? } */
export async function POST(request: NextRequest, context: { params: { id: string } }): Promise<NextResponse<{ status: "ok" } | ApiErrorResponse>> {
  const admin = await require_admin();
  if (admin instanceof NextResponse) return admin;
  if (!UUID_PATTERN.test(context.params.id)) return error_response("Invalid claim id.", 400);

  let request_body: unknown;
  try {
    request_body = await request.json();
  } catch {
    return error_response("Request body must be valid JSON.", 400);
  }
  const validation = validate_claim_resolution(request_body);
  if (!validation.valid) return error_response(validation.reason, 422);

  try {
    const { outcome, note, record_evidence } = validation.input;
    await resolve_business_claim(admin, context.params.id, outcome, note, record_evidence);
    return NextResponse.json({ status: "ok" });
  } catch (caught_error) {
    if (caught_error instanceof ClaimChangeRejectedError) return error_response(caught_error.message, caught_error.status);
    report_error("[admin/claims/resolve] failed", caught_error);
    return error_response("Unable to update the claim.", 500);
  }
}
