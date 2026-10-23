import { report_error } from "@/lib/monitoring";
import { NextRequest, NextResponse } from "next/server";
import { UUID_PATTERN, validate_review_note } from "@/lib/approval";
import { require_admin } from "@/lib/auth/admin-session";
import { AdminPrivilegeError, SubmissionNotPendingError, reject_pending_submission } from "@/lib/db/submissions";
import type { ApiErrorResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

function error_response(message: string, status: number): NextResponse<ApiErrorResponse> {
  return NextResponse.json({ error: message }, { status });
}

/** POST /api/admin/submissions/:id/reject  body (optional): { "review_note": "..." } */
export async function POST(
  request: NextRequest,
  context: { params: { id: string } },
): Promise<NextResponse<{ status: "rejected" } | ApiErrorResponse>> {
  const admin = await require_admin();
  if (admin instanceof NextResponse) return admin;

  const submission_id = context.params.id;
  if (!UUID_PATTERN.test(submission_id)) {
    return error_response("Invalid submission id.", 400);
  }

  const raw_text = await request.text();
  let request_body: unknown = null;
  if (raw_text.trim().length > 0) {
    try {
      request_body = JSON.parse(raw_text);
    } catch {
      return error_response("Request body must be valid JSON.", 400);
    }
  }
  const note = validate_review_note(request_body);
  if (!note.valid) return error_response(note.reason, 422);

  try {
    await reject_pending_submission(admin, submission_id, note.review_note);
    return NextResponse.json({ status: "rejected" });
  } catch (caught_error) {
    if (caught_error instanceof AdminPrivilegeError) return error_response(caught_error.message, 403);
    if (caught_error instanceof SubmissionNotPendingError) return error_response(caught_error.message, 409);
    report_error("[admin/reject] failed", caught_error);
    return error_response("Unable to reject submission.", 500);
  }
}
