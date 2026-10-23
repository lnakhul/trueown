/**
 * Grants (or revokes) the TrueOwn admin role on an existing Supabase Auth user by
 * setting app_metadata.role, the claim checked by middleware, route handlers and
 * the is_admin() SQL function. app_metadata is server-controlled: users cannot
 * set it themselves.
 *
 *   npm run admin:grant -- --email person@example.com --yes
 *   npm run admin:grant -- --email person@example.com --revoke --yes
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment
 * (or .env.local). The service-role key bypasses RLS: use it only from a trusted
 * machine, never in the app or the browser. Existing sessions pick up the change
 * when their JWT next refreshes (sign out and in to apply it at once).
 */
import { createClient, type User } from "@supabase/supabase-js";
import { load_local_env } from "@/lib/import/cli";
import { ADMIN_ROLE } from "@/lib/supabase/config";

const USERS_PER_PAGE = 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function option_value(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((argument) => argument.startsWith("--")));
  const email = option_value(argv, "--email")?.trim().toLowerCase() ?? null;
  const revoke = flags.has("--revoke");
  if (!email || !EMAIL_PATTERN.test(email)) {
    throw new Error("Usage: npm run admin:grant -- --email <address> [--revoke] --yes");
  }

  load_local_env();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const service_role_key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !service_role_key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  }
  const project_host = new URL(url).hostname;
  if (!flags.has("--yes")) {
    throw new Error(`This changes the role of ${email} on ${project_host}. Re-run with --yes to confirm.`);
  }

  const supabase = createClient(url, service_role_key, { auth: { persistSession: false, autoRefreshToken: false } });

  let target: User | undefined;
  for (let page = 1; !target; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: USERS_PER_PAGE });
    if (error) throw new Error(`Could not list users: ${error.message}`);
    target = data.users.find((user) => user.email?.toLowerCase() === email);
    if (data.users.length < USERS_PER_PAGE) break;
  }
  if (!target) throw new Error(`No Supabase Auth user with email ${email}. Invite or create the user first.`);

  const app_metadata = { ...(target.app_metadata ?? {}) } as Record<string, unknown>;
  if (revoke) delete app_metadata.role;
  else app_metadata.role = ADMIN_ROLE;

  const { error } = await supabase.auth.admin.updateUserById(target.id, { app_metadata });
  if (error) throw new Error(`Could not update ${email}: ${error.message}`);
  console.log(`${revoke ? "Revoked" : "Granted"} admin for ${email} on ${project_host}.`);
}

main().catch((caught_error: unknown) => {
  console.error(caught_error instanceof Error ? caught_error.message : caught_error);
  process.exitCode = 1;
});
