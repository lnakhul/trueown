import { NextRequest, NextResponse } from "next/server";
import { require_admin } from "@/lib/auth/admin-session";
import { StorefrontChangeRejectedError, add_independent } from "@/lib/db/storefronts";
import { report_error } from "@/lib/monitoring";
import { validate_add_independent } from "@/lib/storefront-review";
import type { ApiErrorResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

function error_response(message: string, status: number): NextResponse<ApiErrorResponse> {
  return NextResponse.json({ error: message }, { status });
}

/** POST /api/admin/storefronts/independent — Publish a new independent with its evidence (body: { candidate_id, brand_name, ownership_source_type, ownership_source_url }). Admin re-verified per request; audited in the database. */
export async function POST(request: NextRequest): Promise<NextResponse<{ status: "ok"; count: number } | ApiErrorResponse>> {
  const admin = await require_admin();
  if (admin instanceof NextResponse) return admin;

  let request_body: unknown;
  try {
    request_body = await request.json();
  } catch {
    return error_response("Request body must be valid JSON.", 400);
  }
  const validation = validate_add_independent(request_body);
  if (!validation.valid) return error_response(validation.reason, 422);

  try {
    await add_independent(admin, validation.input);
    return NextResponse.json({ status: "ok", count: 1 });
  } catch (caught_error) {
    if (caught_error instanceof StorefrontChangeRejectedError) return error_response(caught_error.message, caught_error.status);
    report_error("[admin/storefronts/independent] failed", caught_error);
    return error_response("Unable to update storefronts.", 500);
  }
}
