import type { Pool, PoolClient } from "pg";
import type { AdminClaims } from "@/lib/auth/admin-session";
import { get_database_pool } from "@/lib/db/pool";

/**
 * Runs `run` in a transaction that acts as the Supabase `authenticated` role with
 * the verified admin's JWT claims, exactly as PostgREST does for API requests.
 * Every statement is then subject to the RLS policies and is_admin() checks, so
 * a server bug cannot write as the privileged connection role.
 *
 * The connection role must be allowed to SET ROLE authenticated (true for
 * Supabase's postgres role and for the local Docker superuser).
 */
export async function with_admin_claims<T>(
  claims: AdminClaims,
  run: (client: PoolClient) => Promise<T>,
  pool: Pool = get_database_pool(),
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE authenticated");
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (caught_error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw caught_error;
  } finally {
    client.release();
  }
}
