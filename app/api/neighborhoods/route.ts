import { NextResponse } from "next/server";
import { fetch_neighborhoods } from "@/lib/db/proximity";
import type { ApiErrorResponse, NeighborhoodsResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

/** GET /api/neighborhoods — options for the "Search by Neighborhood" fallback menu. */
export async function GET(): Promise<NextResponse<NeighborhoodsResponse | ApiErrorResponse>> {
  try {
    const neighborhoods = await fetch_neighborhoods();
    return NextResponse.json({ neighborhoods });
  } catch (caught_error) {
    console.error("[neighborhoods] lookup failed:", caught_error);
    return NextResponse.json({ error: "Unable to load neighborhoods." }, { status: 500 });
  }
}
