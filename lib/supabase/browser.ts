import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { get_supabase_config } from "@/lib/supabase/config";

/** Browser client for the admin login form. Returns null if Supabase is unconfigured. */
export function create_browser_client(): SupabaseClient | null {
  const config = get_supabase_config();
  if (!config) return null;
  return createBrowserClient(config.url, config.anon_key);
}
