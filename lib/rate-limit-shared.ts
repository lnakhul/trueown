import { create_rate_limiter, type RateLimitResult } from "@/lib/rate-limit";

/**
 * Rate limiting that survives serverless/multi-instance deployments. Uses the
 * Upstash Redis REST API (plain fetch, no SDK) when UPSTASH_REDIS_REST_URL and
 * UPSTASH_REDIS_REST_TOKEN are set; otherwise, or if Redis is unreachable, it
 * degrades to the per-instance in-memory limiter so the endpoint is never unlimited.
 */
export interface AsyncRateLimiter {
  check(key: string): Promise<RateLimitResult>;
}

const REDIS_TIMEOUT_MS = 1500;

function redis_config(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!url || !token) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    return { url: parsed.origin, token };
  } catch {
    return null;
  }
}

export function is_shared_rate_limit_enabled(): boolean {
  return redis_config() !== null;
}

/** Fixed window: INCR, set the expiry on the first hit, read the remaining TTL. */
async function redis_increment(
  config: { url: string; token: string },
  redis_key: string,
  window_seconds: number,
): Promise<{ count: number; ttl_seconds: number }> {
  const response = await fetch(`${config.url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify([
      ["INCR", redis_key],
      ["EXPIRE", redis_key, String(window_seconds), "NX"],
      ["TTL", redis_key],
    ]),
    signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Redis responded ${response.status}`);

  const results = (await response.json()) as Array<{ result?: unknown; error?: string }>;
  const count = results[0]?.result;
  const ttl = results[2]?.result;
  if (typeof count !== "number" || typeof ttl !== "number" || results.some((entry) => entry.error)) {
    throw new Error("Unexpected Redis response");
  }
  return { count, ttl_seconds: ttl > 0 ? ttl : window_seconds };
}

export function create_shared_rate_limiter(
  name: string,
  max_requests: number,
  window_ms: number,
): AsyncRateLimiter {
  const fallback = create_rate_limiter(max_requests, window_ms);
  const window_seconds = Math.max(1, Math.ceil(window_ms / 1000));

  return {
    async check(key: string): Promise<RateLimitResult> {
      const config = redis_config();
      if (!config) return fallback.check(key);

      try {
        const { count, ttl_seconds } = await redis_increment(
          config,
          `trueown:rl:${name}:${key}`,
          window_seconds,
        );
        if (count > max_requests) {
          return { allowed: false, remaining: 0, retry_after_seconds: Math.max(1, ttl_seconds) };
        }
        return { allowed: true, remaining: max_requests - count, retry_after_seconds: 0 };
      } catch (error) {
        console.error(
          "Shared rate limiter unavailable; using in-memory fallback:",
          error instanceof Error ? error.message : "unknown error",
        );
        return fallback.check(key);
      }
    },
  };
}
