import { report_error } from "@/lib/monitoring";
import { NextRequest, NextResponse } from "next/server";
import { parse_city } from "@/lib/catalog";
import { fetch_neighborhoods } from "@/lib/db/proximity";
import type { ApiErrorResponse, NeighborhoodsResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

/** GET /api/neighborhoods — options (optionally for one city) for the "Search by Neighborhood" fallback menu. */
export async function GET(
  request: NextRequest,
): Promise<NextResponse<NeighborhoodsResponse | ApiErrorResponse>> {
  const raw_city = request.nextUrl.searchParams.get("city");
  const city = parse_city(raw_city);
  if (raw_city !== null && city === null) {
    return NextResponse.json({ error: "Query parameter 'city' is invalid." }, { status: 400 });
  }
  try {
    const neighborhoods = await fetch_neighborhoods(undefined, city);
    return NextResponse.json({ neighborhoods });
  } catch (caught_error) {
    report_error("[neighborhoods] lookup failed", caught_error);
    return NextResponse.json({ error: "Unable to load neighborhoods." }, { status: 500 });
  }
}
