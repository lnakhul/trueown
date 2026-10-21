import { NextResponse } from "next/server";
import { get_database_pool } from "@/lib/db/pool";

export const dynamic = "force-dynamic";

/**
 * GET /api/health: uptime-monitor endpoint. Confirms the app is up and the
 * database answers. Reveals nothing about configuration or errors.
 */
export async function GET(): Promise<NextResponse> {
  try {
    await get_database_pool().query("SELECT 1");
    return NextResponse.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json(
      { status: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
