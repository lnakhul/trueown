import { NextRequest, NextResponse } from "next/server";
import { UUID_PATTERN } from "@/lib/approval";
import { SubmissionNotPendingError, reject_pending_submission } from "@/lib/db/submissions";
import type { ApiErrorResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

function error_response(message: string, status: number): NextResponse<ApiErrorResponse> {
  return NextResponse.json({ error: message }, { status });
}

/** POST /api/admin/submissions/:id/reject  (protected by middleware.ts) */
export async function POST(
  _request: NextRequest,
  context: { params: { id: string } },
): Promise<NextResponse<{ status: "rejected" } | ApiErrorResponse>> {
  const submission_id = context.params.id;
  if (!UUID_PATTERN.test(submission_id)) {
    return error_response("Invalid submission id.", 400);
  }

  try {
    await reject_pending_submission(submission_id);
    return NextResponse.json({ status: "rejected" });
  } catch (caught_error) {
    if (caught_error instanceof SubmissionNotPendingError) {
      return error_response(caught_error.message, 409);
    }
    console.error("[admin/reject] failed:", caught_error);
    return error_response("Unable to reject submission.", 500);
  }
}
