/**
 * Supabase runtime configuration. The anon key is public by design: it only
 * grants what the RLS policies allow. The service-role key is never used here.
 */
export interface SupabaseConfig {
  url: string;
  anon_key: string;
}

/** Returns null when Supabase is not configured (local Docker dev falls back). */
export function get_supabase_config(): SupabaseConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anon_key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !anon_key) return null;
  return { url, anon_key };
}

/** Matches the role checked by the is_admin() SQL function (app_metadata.role). */
export const ADMIN_ROLE = "admin";

export interface JwtUserLike {
  app_metadata?: Record<string, unknown> | null;
}

/** Only server-controlled app_metadata counts; user_metadata is user-editable. */
export function is_admin_user(user: JwtUserLike | null | undefined): boolean {
  return user?.app_metadata?.role === ADMIN_ROLE;
}
