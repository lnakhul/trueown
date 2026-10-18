import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { get_supabase_config } from "@/lib/supabase/config";

/** Stateless anon client: acts strictly under the `anon` RLS role. */
export function create_anon_client(): SupabaseClient | null {
  const config = get_supabase_config();
  if (!config) return null;
  return createClient(config.url, config.anon_key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Cookie-bound client for server components and route handlers (user session). */
export function create_session_client(): SupabaseClient | null {
  const config = get_supabase_config();
  if (!config) return null;
  const cookie_store = cookies();
  return createServerClient(config.url, config.anon_key, {
    cookies: {
      getAll: () => cookie_store.getAll(),
      setAll: (cookies_to_set) => {
        try {
          cookies_to_set.forEach(({ name, value, options }) =>
            cookie_store.set(name, value, options),
          );
        } catch {
          // Called from a Server Component: middleware refreshes the session instead.
        }
      },
    },
  });
}
