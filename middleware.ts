import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";
import { get_supabase_config, is_admin_user } from "@/lib/supabase/config";

/**
 * Fail-closed admin gate for the admin UI and admin API.
 * - Supabase configured: requires a verified Supabase Auth user whose
 *   app_metadata.role is 'admin' (the same rule as the is_admin() RLS function).
 * - Otherwise (local Docker dev): HTTP Basic auth via ADMIN_PASSWORD; if that is
 *   unset too, every admin request is rejected.
 */
export const config = { matcher: ["/admin/:path*", "/api/admin/:path*"] };

/** Length-independent comparison to avoid leaking the password via timing. */
function constant_time_equals(provided: string, expected: string): boolean {
  let difference = provided.length ^ expected.length;
  const compare_length = Math.max(provided.length, expected.length);
  for (let index = 0; index < compare_length; index += 1) {
    difference |= (provided.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function challenge(status: number, message: string): NextResponse {
  return new NextResponse(message, {
    status,
    headers: { "WWW-Authenticate": 'Basic realm="TrueOwn Admin", charset="UTF-8"' },
  });
}

const LOGIN_PATH = "/admin/login";

async function supabase_gate(request: NextRequest): Promise<NextResponse> {
  const config = get_supabase_config();
  if (!config) return new NextResponse("Admin access is not configured.", { status: 503 });

  const { pathname } = request.nextUrl;
  const is_api = pathname.startsWith("/api/");
  let response = NextResponse.next({ request });

  const supabase = createServerClient(config.url, config.anon_key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookies_to_set) => {
        cookies_to_set.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookies_to_set.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  // getUser() re-validates the token with Supabase Auth; getSession() would not.
  let user = null;
  try {
    const { data } = await supabase.auth.getUser();
    user = data.user;
  } catch {
    user = null;
  }

  if (pathname === LOGIN_PATH) {
    if (is_admin_user(user)) return NextResponse.redirect(new URL("/admin", request.url));
    return response;
  }

  if (!user) {
    if (is_api) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    return NextResponse.redirect(new URL(LOGIN_PATH, request.url));
  }
  if (!is_admin_user(user)) {
    if (is_api) return NextResponse.json({ error: "Admin role required." }, { status: 403 });
    return NextResponse.redirect(new URL(`${LOGIN_PATH}?error=forbidden`, request.url));
  }
  return response;
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  if (get_supabase_config()) return supabase_gate(request);

  const admin_password = process.env.ADMIN_PASSWORD;
  if (!admin_password) {
    return new NextResponse("Admin access is not configured.", { status: 503 });
  }

  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Basic ")) {
    return challenge(401, "Authentication required.");
  }

  let decoded_credentials: string;
  try {
    decoded_credentials = atob(authorization.slice("Basic ".length));
  } catch {
    return challenge(401, "Malformed credentials.");
  }

  const separator_index = decoded_credentials.indexOf(":");
  const provided_password =
    separator_index === -1 ? "" : decoded_credentials.slice(separator_index + 1);

  if (!constant_time_equals(provided_password, admin_password)) {
    return challenge(401, "Invalid credentials.");
  }
  return NextResponse.next();
}
