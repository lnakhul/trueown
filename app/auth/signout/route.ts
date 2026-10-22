import { report_error } from "@/lib/monitoring";
import { NextResponse, type NextRequest } from "next/server";
import { create_session_client } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** POST /auth/signout: clears the Supabase session cookies. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = create_session_client();
  if (supabase) {
    try {
      await supabase.auth.signOut();
    } catch (caught_error) {
      report_error("[auth/signout] failed", caught_error);
    }
  }
  return NextResponse.redirect(new URL("/admin/login", request.url), { status: 303 });
}
