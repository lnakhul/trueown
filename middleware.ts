import { NextRequest, NextResponse } from "next/server";

/**
 * Fail-closed HTTP Basic auth for the admin UI and admin API.
 * If ADMIN_PASSWORD is unset, every admin request is rejected.
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

export function middleware(request: NextRequest): NextResponse {
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
