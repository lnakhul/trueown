import { NextRequest, NextResponse } from "next/server";
import { require_admin } from "@/lib/auth/admin-session";
import { StorefrontChangeRejectedError, add_corporate_brand } from "@/lib/db/storefronts";
import { report_error } from "@/lib/monitoring";
import { validate_add_corporate_brand } from "@/lib/storefront-review";
import type { ApiErrorResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

function error_response(message: string, status: number): NextResponse<ApiErrorResponse> {
  return NextResponse.json({ error: message }, { status });
}

/**
 * POST /api/admin/storefronts/corporate-brand
 * body: { candidate_id, brand_name, corporate_tier, parent_entity, financial_backers, ownership_source_type, ownership_source_url }
 * Creates the PE/VC-backed brand with its evidence; its shops move to Chain matches. Audited in the database.
 */
export async function POST(
  request: NextRequest,
): Promise<NextResponse<{ status: "ok"; brand_id: string; moved_to_chain_matches: number } | ApiErrorResponse>> {
  const admin = await require_admin();
  if (admin instanceof NextResponse) return admin;

  let request_body: unknown;
  try {
    request_body = await request.json();
  } catch {
    return error_response("Request body must be valid JSON.", 400);
  }
  const validation = validate_add_corporate_brand(request_body);
  if (!validation.valid) return error_response(validation.reason, 422);

  try {
    const result = await add_corporate_brand(admin, validation.input);
    return NextResponse.json({ status: "ok", ...result });
  } catch (caught_error) {
    if (caught_error instanceof StorefrontChangeRejectedError) return error_response(caught_error.message, caught_error.status);
    report_error("[admin/storefronts/corporate-brand] failed", caught_error);
    return error_response("Unable to add the brand.", 500);
  }
}
