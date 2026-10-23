import { report_error } from "@/lib/monitoring";
import { NextRequest, NextResponse } from "next/server";
import { UUID_PATTERN, validate_approval_input } from "@/lib/approval";
import { require_admin } from "@/lib/auth/admin-session";
import {
  AdminPrivilegeError,
  ApprovalRejectedError,
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
 * POST /api/admin/submissions/:id/approve
 * Re-verifies the admin (middleware.ts is only the outer gate), then atomically
 * publishes the brand + location with provenance under the admin's JWT claims.
 */
export async function POST(
  request: NextRequest,
  context: { params: { id: string } },
): Promise<NextResponse<{ location_id: string } | ApiErrorResponse>> {
  const admin = await require_admin();
  if (admin instanceof NextResponse) return admin;

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
    const location_id = await approve_pending_submission(admin, submission_id, validation.input);
    return NextResponse.json({ location_id });
  } catch (caught_error) {
    if (caught_error instanceof AdminPrivilegeError) return error_response(caught_error.message, 403);
    if (caught_error instanceof SubmissionNotPendingError) return error_response(caught_error.message, 409);
    if (caught_error instanceof BrandTierConflictError) return error_response(caught_error.message, 409);
    if (caught_error instanceof ApprovalRejectedError) return error_response(caught_error.message, 422);
    report_error("[admin/approve] failed", caught_error);
    return error_response("Unable to approve submission.", 500);
  }
}
