import { NextRequest, NextResponse } from "next/server";
import { require_admin } from "@/lib/auth/admin-session";
import { StorefrontChangeRejectedError, approve_storefronts } from "@/lib/db/storefronts";
import { report_error } from "@/lib/monitoring";
import { validate_approve_storefronts } from "@/lib/storefront-review";
import type { ApiErrorResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

function error_response(message: string, status: number): NextResponse<ApiErrorResponse> {
  return NextResponse.json({ error: message }, { status });
}

/** POST /api/admin/storefronts/approve — Publish storefronts for a live brand (body: { candidate_ids, brand_id? }). Admin re-verified per request; audited in the database. */
export async function POST(request: NextRequest): Promise<NextResponse<{ status: "ok"; count: number } | ApiErrorResponse>> {
  const admin = await require_admin();
  if (admin instanceof NextResponse) return admin;

  let request_body: unknown;
  try {
    request_body = await request.json();
  } catch {
    return error_response("Request body must be valid JSON.", 400);
  }
  const validation = validate_approve_storefronts(request_body);
  if (!validation.valid) return error_response(validation.reason, 422);

  try {
    const count = await approve_storefronts(admin, validation.input.candidate_ids, validation.input.brand_id);
    return NextResponse.json({ status: "ok", count });
  } catch (caught_error) {
    if (caught_error instanceof StorefrontChangeRejectedError) return error_response(caught_error.message, caught_error.status);
    report_error("[admin/storefronts/approve] failed", caught_error);
    return error_response("Unable to update storefronts.", 500);
  }
}
