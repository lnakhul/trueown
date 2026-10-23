/**
 * HTTP Basic admin credentials for local development only (no Supabase).
 * Edge-safe: no Node APIs, so middleware and route handlers share it.
 */

/** Length-independent comparison to avoid leaking the password via timing. */
export function constant_time_equals(provided: string, expected: string): boolean {
  let difference = provided.length ^ expected.length;
  const compare_length = Math.max(provided.length, expected.length);
  for (let index = 0; index < compare_length; index += 1) {
    difference |= (provided.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export type BasicCredentialCheck = "valid" | "missing" | "malformed" | "invalid";

/** Checks an Authorization header against ADMIN_PASSWORD (the username is ignored). */
export function check_basic_credentials(
  authorization_header: string | null | undefined,
  admin_password: string,
): BasicCredentialCheck {
  if (!authorization_header?.startsWith("Basic ")) return "missing";
  let decoded_credentials: string;
  try {
    decoded_credentials = atob(authorization_header.slice("Basic ".length));
  } catch {
    return "malformed";
  }
  const separator_index = decoded_credentials.indexOf(":");
  const provided_password = separator_index === -1 ? "" : decoded_credentials.slice(separator_index + 1);
  return constant_time_equals(provided_password, admin_password) ? "valid" : "invalid";
}

/** Basic auth is a local-dev convenience; production must use Supabase Auth. */
export function basic_admin_allowed(node_env: string | undefined): boolean {
  return node_env !== "production";
}
