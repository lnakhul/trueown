import { NextResponse } from "next/server";
import { basic_admin_allowed, check_basic_credentials } from "@/lib/auth/basic";
import { get_supabase_config, is_admin_user, ADMIN_ROLE, type JwtUserLike } from "@/lib/supabase/config";

/**
 * Per-request admin verification for admin route handlers and pages. middleware.ts
 * is the outer gate; this runs again inside every handler so no admin write ever
 * depends on the middleware alone, and it produces the JWT claims the database
 * checks (is_admin()) when the write runs.
 */

/** Fixed identity for local Basic-auth sessions (never accepted in production). */
export const LOCAL_DEV_ADMIN_ID = "00000000-0000-4000-8000-00000000ad01";
export const LOCAL_DEV_ADMIN_EMAIL = "local-admin@localhost";

/** The subset of Supabase JWT claims the database policies read. */
export interface AdminClaims {
  role: "authenticated";
  sub: string;
  email: string | null;
  app_metadata: { role: typeof ADMIN_ROLE };
}

export interface AdminIdentity {
  actor_id: string;
  email: string | null;
  mode: "supabase" | "local_basic";
  claims: AdminClaims;
}

export type AdminAuthorization =
  | { ok: true; identity: AdminIdentity }
  | { ok: false; status: 401 | 403 | 503; message: string };

export interface VerifiedUser extends JwtUserLike {
  id: string;
  email?: string | null;
}

export interface AdminAuthContext {
  supabase_configured: boolean;
  node_env: string | undefined;
  /** Must re-validate the session with Supabase Auth (getUser), never trust a cookie alone. */
  get_verified_user: () => Promise<VerifiedUser | null>;
  authorization_header: string | null;
  admin_password: string | undefined;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function build_identity(actor_id: string, email: string | null, mode: AdminIdentity["mode"]): AdminIdentity {
  return {
    actor_id,
    email,
    mode,
    claims: { role: "authenticated", sub: actor_id, email, app_metadata: { role: ADMIN_ROLE } },
  };
}

/** Pure decision: who is calling, and are they an admin? Fails closed on every error. */
export async function authorize_admin(context: AdminAuthContext): Promise<AdminAuthorization> {
  if (context.supabase_configured) {
    let user: VerifiedUser | null = null;
    try {
      user = await context.get_verified_user();
    } catch {
      user = null;
    }
    if (!user || typeof user.id !== "string" || !UUID_PATTERN.test(user.id)) {
      return { ok: false, status: 401, message: "Authentication required." };
    }
    // Only server-controlled app_metadata counts; user_metadata is user-editable.
    if (!is_admin_user(user)) return { ok: false, status: 403, message: "Admin role required." };
    return { ok: true, identity: build_identity(user.id, user.email ?? null, "supabase") };
  }

  if (!basic_admin_allowed(context.node_env) || !context.admin_password) {
    return { ok: false, status: 503, message: "Admin access is not configured." };
  }
  if (check_basic_credentials(context.authorization_header, context.admin_password) !== "valid") {
    return { ok: false, status: 401, message: "Authentication required." };
  }
  return { ok: true, identity: build_identity(LOCAL_DEV_ADMIN_ID, LOCAL_DEV_ADMIN_EMAIL, "local_basic") };
}

/** Builds the context for the current request (route handler or server component). */
async function current_request_context(): Promise<AdminAuthContext> {
  const { headers } = await import("next/headers");
  const { create_session_client } = await import("@/lib/supabase/server");
  return {
    supabase_configured: get_supabase_config() !== null,
    node_env: process.env.NODE_ENV,
    authorization_header: headers().get("authorization"),
    admin_password: process.env.ADMIN_PASSWORD,
    get_verified_user: async () => {
      const supabase = create_session_client();
      if (!supabase) return null;
      const { data, error } = await supabase.auth.getUser();
      if (error) return null;
      return data.user as VerifiedUser | null;
    },
  };
}

export async function resolve_request_admin(): Promise<AdminAuthorization> {
  return authorize_admin(await current_request_context());
}

/** For route handlers: the verified admin, or the error response to return as-is. */
export async function require_admin(): Promise<AdminIdentity | NextResponse<{ error: string }>> {
  const authorization = await resolve_request_admin();
  if (authorization.ok) return authorization.identity;
  return NextResponse.json({ error: authorization.message }, { status: authorization.status });
}
