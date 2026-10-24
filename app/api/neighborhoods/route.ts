import { report_error } from "@/lib/monitoring";
import { NextRequest, NextResponse } from "next/server";
import { parse_city } from "@/lib/catalog";
import { MAX_POPULAR_NEIGHBORHOODS, fetch_neighborhoods, fetch_popular_neighborhoods } from "@/lib/db/proximity";
import type { ApiErrorResponse, NeighborhoodsResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/neighborhoods — every neighborhood with tracked storefronts (optionally for one city).
 * &popular=<n> returns only the n neighborhoods with the most storefronts (search panel quick picks).
 */
export async function GET(
  request: NextRequest,
): Promise<NextResponse<NeighborhoodsResponse | ApiErrorResponse>> {
  const raw_city = request.nextUrl.searchParams.get("city");
  const city = parse_city(raw_city);
  if (raw_city !== null && city === null) {
    return NextResponse.json({ error: "Query parameter 'city' is invalid." }, { status: 400 });
  }
  const raw_popular = request.nextUrl.searchParams.get("popular");
  const popular = raw_popular === null ? null : Number(raw_popular);
  if (popular !== null && (!Number.isInteger(popular) || popular < 1 || popular > MAX_POPULAR_NEIGHBORHOODS)) {
    return NextResponse.json({ error: `Query parameter 'popular' must be 1 to ${MAX_POPULAR_NEIGHBORHOODS}.` }, { status: 400 });
  }
  try {
    const neighborhoods =
      popular === null ? await fetch_neighborhoods(undefined, city) : await fetch_popular_neighborhoods(popular, undefined, city);
    return NextResponse.json({ neighborhoods });
  } catch (caught_error) {
    report_error("[neighborhoods] lookup failed", caught_error);
    return NextResponse.json({ error: "Unable to load neighborhoods." }, { status: 500 });
  }
}
