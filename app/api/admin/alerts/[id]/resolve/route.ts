import { report_error } from "@/lib/monitoring";
import { NextRequest, NextResponse } from "next/server";
import { UUID_PATTERN } from "@/lib/approval";
import { require_admin } from "@/lib/auth/admin-session";
import { AlertNotOpenError, resolve_ownership_alert } from "@/lib/db/alerts";
import { BrandChangeRejectedError, BrandNotFoundError } from "@/lib/db/brands";
import { validate_alert_resolution } from "@/lib/ownership-alerts";
import type { ApiErrorResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

function error_response(message: string, status: number): NextResponse<ApiErrorResponse> {
  return NextResponse.json({ error: message }, { status });
}

/**
 * POST /api/admin/alerts/:id/resolve
 *   { "action": "dismiss", "note" }
 *   { "action": "reverify", "ownership_source_type", "ownership_source_url" }      listing unchanged, fresh evidence
 *   { "action": "correct", "corporate_tier", "parent_entity", "financial_backers",
 *     "ownership_source_type", "ownership_source_url", "review_note" }            listing updated
 * Admin re-verified per request; the listing change and the alert are closed together and audited.
 */
export async function POST(
  request: NextRequest,
  context: { params: { id: string } },
): Promise<NextResponse<{ status: "ok" } | ApiErrorResponse>> {
  const admin = await require_admin();
  if (admin instanceof NextResponse) return admin;

  const alert_id = context.params.id;
  if (!UUID_PATTERN.test(alert_id)) return error_response("Invalid alert id.", 400);

  let request_body: unknown;
  try {
    request_body = await request.json();
  } catch {
    return error_response("Request body must be valid JSON.", 400);
  }
  const validation = validate_alert_resolution(request_body);
  if (!validation.valid) return error_response(validation.reason, 422);

  try {
    await resolve_ownership_alert(admin, alert_id, validation.resolution);
    return NextResponse.json({ status: "ok" });
  } catch (caught_error) {
    if (caught_error instanceof AlertNotOpenError) return error_response(caught_error.message, 409);
    if (caught_error instanceof BrandNotFoundError) return error_response(caught_error.message, 404);
    if (caught_error instanceof BrandChangeRejectedError) return error_response(caught_error.message, caught_error.status);
    report_error("[admin/alerts/resolve] failed", caught_error);
    return error_response("Unable to update the alert.", 500);
  }
}
