import { Pool } from "pg";

/**
 * Singleton connection pool. Cached on globalThis so Next.js dev hot-reloads
 * do not exhaust database connections.
 */
const globalForPool = globalThis as unknown as { pgPool?: Pool };

function create_pool(): Pool {
  const connection_string = process.env.DATABASE_URL;
  if (!connection_string) {
    // Fail closed: never run with an implicit/default connection.
    throw new Error("DATABASE_URL environment variable is not set.");
  }
  // Serverless instances multiply; keep each one small and rely on the Supabase pooler.
  const max_connections = process.env.VERCEL ? 3 : 10;
  return new Pool({ connectionString: connection_string, max: max_connections });
}

export function get_database_pool(): Pool {
  if (!globalForPool.pgPool) {
    globalForPool.pgPool = create_pool();
  }
  return globalForPool.pgPool;
}
