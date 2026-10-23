import { NextRequest, NextResponse } from "next/server";
import { UUID_PATTERN } from "@/lib/approval";
import { require_admin } from "@/lib/auth/admin-session";
import { validate_resolution } from "@/lib/corrections";
import { CorrectionChangeRejectedError, resolve_correction_request } from "@/lib/db/corrections";
import { report_error } from "@/lib/monitoring";
import type { ApiErrorResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

function error_response(message: string, status: number): NextResponse<ApiErrorResponse> {
  return NextResponse.json({ error: message }, { status });
}

/** POST /api/admin/corrections/:id/resolve  body: { "outcome": "resolved" | "dismissed", "note" } */
export async function POST(
  request: NextRequest,
  context: { params: { id: string } },
): Promise<NextResponse<{ status: "ok" } | ApiErrorResponse>> {
  const admin = await require_admin();
  if (admin instanceof NextResponse) return admin;

  const request_id = context.params.id;
  if (!UUID_PATTERN.test(request_id)) return error_response("Invalid request id.", 400);

  let request_body: unknown;
  try {
    request_body = await request.json();
  } catch {
    return error_response("Request body must be valid JSON.", 400);
  }
  const validation = validate_resolution(request_body);
  if (!validation.valid) return error_response(validation.reason, 422);

  try {
    await resolve_correction_request(admin, request_id, validation.outcome, validation.note);
    return NextResponse.json({ status: "ok" });
  } catch (caught_error) {
    if (caught_error instanceof CorrectionChangeRejectedError) return error_response(caught_error.message, caught_error.status);
    report_error("[admin/corrections/resolve] failed", caught_error);
    return error_response("Unable to update the report.", 500);
  }
}
