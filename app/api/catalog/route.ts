import { report_error } from "@/lib/monitoring";
import { NextResponse } from "next/server";
import { fetch_catalog } from "@/lib/db/proximity";
import type { ApiErrorResponse, CatalogResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

/** GET /api/catalog — cities and verticals with tracked storefronts, for the selectors. */
export async function GET(): Promise<NextResponse<CatalogResponse | ApiErrorResponse>> {
  try {
    return NextResponse.json(await fetch_catalog());
  } catch (caught_error) {
    report_error("[catalog] lookup failed", caught_error);
    return NextResponse.json({ error: "Unable to load catalog." }, { status: 500 });
  }
}
