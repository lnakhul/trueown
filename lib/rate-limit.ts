/**
 * Fixed-window, in-memory rate limiter keyed by client identifier.
 * Limitation: state is per server instance. On multi-instance or serverless
 * deployments, swap the store for a shared one (e.g. Upstash Redis) behind the
 * same interface.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retry_after_seconds: number;
}

interface WindowEntry {
  count: number;
  reset_at_ms: number;
}

export interface RateLimiter {
  check(key: string, now_ms?: number): RateLimitResult;
}

/** Hard cap on tracked keys so the map cannot grow without bound under attack. */
const MAX_TRACKED_KEYS = 10_000;

export function create_rate_limiter(max_requests: number, window_ms: number): RateLimiter {
  if (!Number.isInteger(max_requests) || max_requests < 1 || window_ms < 1) {
    throw new Error("Rate limiter requires max_requests >= 1 and window_ms >= 1.");
  }
  const entries = new Map<string, WindowEntry>();

  function evict_expired(now_ms: number): void {
    entries.forEach((entry, key) => {
      if (entry.reset_at_ms <= now_ms) entries.delete(key);
    });
  }

  return {
    check(key: string, now_ms: number = Date.now()): RateLimitResult {
      let entry = entries.get(key);
      if (!entry || entry.reset_at_ms <= now_ms) {
        if (entries.size >= MAX_TRACKED_KEYS) evict_expired(now_ms);
        // Still full of live keys: fail closed rather than grow unbounded.
        if (entries.size >= MAX_TRACKED_KEYS) {
          return { allowed: false, remaining: 0, retry_after_seconds: Math.ceil(window_ms / 1000) };
        }
        entry = { count: 0, reset_at_ms: now_ms + window_ms };
        entries.set(key, entry);
      }

      if (entry.count >= max_requests) {
        return {
          allowed: false,
          remaining: 0,
          retry_after_seconds: Math.max(1, Math.ceil((entry.reset_at_ms - now_ms) / 1000)),
        };
      }
      entry.count += 1;
      return {
        allowed: true,
        remaining: max_requests - entry.count,
        retry_after_seconds: 0,
      };
    },
  };
}

/**
 * Best-effort client IP. Only the first x-forwarded-for hop is used, and only
 * trustworthy behind a proxy that overwrites the header (Vercel, nginx, etc.).
 */
export function get_client_key(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const real_ip = headers.get("x-real-ip")?.trim();
  return (forwarded || real_ip || "unknown").slice(0, 64);
}
