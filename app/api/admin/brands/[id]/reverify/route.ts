import { report_error } from "@/lib/monitoring";
import { NextRequest, NextResponse } from "next/server";
import { UUID_PATTERN } from "@/lib/approval";
import { require_admin } from "@/lib/auth/admin-session";
import { validate_reverify_input } from "@/lib/brand-review";
import { BrandChangeRejectedError, BrandNotFoundError, reverify_brand_claim } from "@/lib/db/brands";
import type { ApiErrorResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

function error_response(message: string, status: number): NextResponse<ApiErrorResponse> {
  return NextResponse.json({ error: message }, { status });
}

/**
 * POST /api/admin/brands/:id/reverify  body: { "ownership_source_type", "ownership_source_url" }
 * Records fresh (or re-checked) evidence for the brand's current claim. Admin re-verified per request; the change is audited in the database.
 */
export async function POST(
  request: NextRequest,
  context: { params: { id: string } },
): Promise<NextResponse<{ status: "ok" } | ApiErrorResponse>> {
  const admin = await require_admin();
  if (admin instanceof NextResponse) return admin;

  const brand_id = context.params.id;
  if (!UUID_PATTERN.test(brand_id)) return error_response("Invalid brand id.", 400);

  let request_body: unknown;
  try {
    request_body = await request.json();
  } catch {
    return error_response("Request body must be valid JSON.", 400);
  }
  const validation = validate_reverify_input(request_body);
  if (!validation.valid) return error_response(validation.reason, 422);

  try {
    await reverify_brand_claim(admin, brand_id, validation.input);
    return NextResponse.json({ status: "ok" });
  } catch (caught_error) {
    if (caught_error instanceof BrandNotFoundError) return error_response(caught_error.message, 404);
    if (caught_error instanceof BrandChangeRejectedError) return error_response(caught_error.message, caught_error.status);
    report_error("[admin/brands/reverify] failed", caught_error);
    return error_response("Unable to update the brand.", 500);
  }
}
