import * as Sentry from "@sentry/nextjs";
import type { TelemetrySink } from "@/lib/telemetry";

/**
 * Production sink: a Sentry counter metric per proximity search. With no DSN configured
 * Sentry drops it, and any transport failure is swallowed by lib/telemetry.ts.
 */
export const sentry_telemetry_sink: TelemetrySink = (event) => {
  Sentry.metrics.count(event.name, 1, {
    attributes: {
      market_id: event.market_id,
      industry_vertical: event.industry_vertical,
      search_type: event.search_type,
    },
  });
};
