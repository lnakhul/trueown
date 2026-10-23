import type { IndustryVertical } from "@/lib/types";

/**
 * Non-blocking product telemetry for proximity searches.
 *
 * Contract: `record_proximity_search` NEVER throws, NEVER awaits, and never delays the
 * caller. The event is handed to the registered sink on a later tick, bounded by a
 * timeout and an in-flight cap, so a dead or hung monitoring backend (e.g. a Sentry
 * socket failure) cannot slow or fail a client response. Failures are counted, not logged.
 *
 * Privacy: events carry only market id, vertical and search type. Never add coordinates,
 * addresses, search text or anything user-identifying.
 *
 * The sink is wired in `instrumentation.ts` (Next.js `register()` hook). Until a sink is
 * registered, events are dropped.
 */

export type ProximitySearchType = "nearest" | "text_fallback";

export interface ProximitySearchEvent {
  name: "proximity_search";
  market_id: string;
  industry_vertical: IndustryVertical;
  search_type: ProximitySearchType;
  occurred_at: string;
}

export type TelemetrySink = (event: ProximitySearchEvent) => void | Promise<void>;

export const TELEMETRY_TIMEOUT_MS = 2000;
export const TELEMETRY_MAX_IN_FLIGHT = 50;

interface TelemetryState {
  sink: TelemetrySink | null;
  in_flight: number;
  stats: { delivered: number; failed: number; dropped: number };
}

// Held on globalThis: Next.js bundles instrumentation.ts and route handlers separately,
// so module-level state would be duplicated and the registered sink never seen by routes.
const state_holder = globalThis as typeof globalThis & { __trueown_telemetry?: TelemetryState };
const state: TelemetryState = (state_holder.__trueown_telemetry ??= {
  sink: null,
  in_flight: 0,
  stats: { delivered: 0, failed: 0, dropped: 0 },
});
const stats = state.stats;

/** Installs (or with null, removes) the destination for telemetry events. */
export function register_telemetry_sink(sink: TelemetrySink | null): void {
  state.sink = sink;
}

/** Counters for diagnostics and tests. */
export function get_telemetry_stats(): Readonly<typeof stats> {
  return { ...stats };
}

export function reset_telemetry_stats(): void {
  stats.delivered = 0;
  stats.failed = 0;
  stats.dropped = 0;
}

async function deliver(sink: TelemetrySink, event: ProximitySearchEvent): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("telemetry timeout")), TELEMETRY_TIMEOUT_MS);
      timer.unref?.();
    });
    await Promise.race([Promise.resolve().then(() => sink(event)), timeout]);
    stats.delivered += 1;
  } catch {
    stats.failed += 1;
  } finally {
    if (timer) clearTimeout(timer);
    state.in_flight -= 1;
  }
}

/** Fire-and-forget. Safe to call from any request path. */
export function record_proximity_search(fields: Omit<ProximitySearchEvent, "name" | "occurred_at">): void {
  try {
    const sink = state.sink;
    if (!sink) return;
    if (state.in_flight >= TELEMETRY_MAX_IN_FLIGHT) {
      stats.dropped += 1;
      return;
    }
    state.in_flight += 1;
    const event: ProximitySearchEvent = {
      name: "proximity_search",
      market_id: fields.market_id,
      industry_vertical: fields.industry_vertical,
      search_type: fields.search_type,
      occurred_at: new Date().toISOString(),
    };
    // Deferred so the sink never runs on the request's critical path.
    const defer_timer = setTimeout(() => {
      void deliver(sink, event);
    }, 0);
    defer_timer.unref?.();
  } catch {
    stats.failed += 1;
  }
}
