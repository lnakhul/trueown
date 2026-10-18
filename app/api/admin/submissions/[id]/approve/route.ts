import { NextRequest, NextResponse } from "next/server";
import { UUID_PATTERN, validate_approval_input } from "@/lib/approval";
import {
  BrandTierConflictError,
  SubmissionNotPendingError,
  approve_pending_submission,
} from "@/lib/db/submissions";
import type { ApiErrorResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

function error_response(message: string, status: number): NextResponse<ApiErrorResponse> {
  return NextResponse.json({ error: message }, { status });
}

/**
 * POST /api/admin/submissions/:id/approve  (protected by middleware.ts)
 * Atomically marks the submission approved and inserts the brand + location.
 */
export async function POST(
  request: NextRequest,
  context: { params: { id: string } },
): Promise<NextResponse<{ location_id: string } | ApiErrorResponse>> {
  const submission_id = context.params.id;
  if (!UUID_PATTERN.test(submission_id)) {
    return error_response("Invalid submission id.", 400);
  }

  let request_body: unknown;
  try {
    request_body = await request.json();
  } catch {
    return error_response("Request body must be valid JSON.", 400);
  }

  const validation = validate_approval_input(request_body);
  if (!validation.valid) return error_response(validation.reason, 422);

  try {
    const location_id = await approve_pending_submission(submission_id, validation.input);
    return NextResponse.json({ location_id });
  } catch (caught_error) {
    if (caught_error instanceof SubmissionNotPendingError) {
      return error_response(caught_error.message, 409);
    }
    if (caught_error instanceof BrandTierConflictError) {
      return error_response(caught_error.message, 409);
    }
    console.error("[admin/approve] failed:", caught_error);
    return error_response("Unable to approve submission.", 500);
  }
}
