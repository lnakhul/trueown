import { existsSync } from "fs";

/**
 * Loads .env.local for CLI scripts (Next.js does this itself for the app).
 * Variables already present in the environment always win, so Docker/CI values
 * are never overridden.
 */
export function load_local_env(): void {
  if (!existsSync(".env.local")) return;
  const loader = (process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile;
  if (typeof loader === "function") loader.call(process, ".env.local");
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "db", "host.docker.internal"]);

export interface DatabaseTarget {
  description: string;
  is_local: boolean;
}

/** Describes the target without ever exposing credentials. */
export function describe_database_target(connection_string: string | undefined): DatabaseTarget {
  if (!connection_string) throw new Error("DATABASE_URL environment variable is not set.");
  let parsed: URL;
  try {
    parsed = new URL(connection_string);
  } catch {
    throw new Error("DATABASE_URL is not a valid connection string.");
  }
  return {
    description: `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`,
    is_local: LOCAL_HOSTS.has(parsed.hostname),
  };
}

/**
 * Guard against accidentally writing to a hosted database: non-local targets
 * need an explicit --yes. Dry runs never persist, so they are always allowed.
 */
export function assert_write_allowed(target: DatabaseTarget, dry_run: boolean, confirmed: boolean): void {
  if (dry_run || target.is_local || confirmed) return;
  throw new Error(
    `Refusing to write to non-local database ${target.description}. Re-run with --yes to confirm, or --dry-run to preview.`,
  );
}
