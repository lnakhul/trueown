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
  return new Pool({ connectionString: connection_string, max: 10 });
}

export function get_database_pool(): Pool {
  if (!globalForPool.pgPool) {
    globalForPool.pgPool = create_pool();
  }
  return globalForPool.pgPool;
}
