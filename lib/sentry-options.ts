import type { ErrorEvent, EventHint } from "@sentry/nextjs";

/**
 * Shared Sentry options for the browser, Node and edge runtimes.
 *
 * Privacy rules (TrueOwn handles visitors' physical location):
 *  - no default PII, no cookies, no request headers or bodies;
 *  - every URL is stripped of its query string, because /api/proximity carries lat/lng.
 */

const DEFAULT_TRACES_SAMPLE_RATE = 0.1;

/** Returns the trimmed DSN, or null when monitoring is not configured. */
export function resolve_sentry_dsn(raw_dsn: string | undefined): string | null {
  const dsn = raw_dsn?.trim() ?? "";
  return dsn.length > 0 ? dsn : null;
}

/** Parses a 0..1 sample rate; anything else falls back to the default. */
export function resolve_traces_sample_rate(raw_rate: string | undefined): number {
  if (raw_rate === undefined || raw_rate.trim() === "") return DEFAULT_TRACES_SAMPLE_RATE;
  const rate = Number(raw_rate);
  return Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : DEFAULT_TRACES_SAMPLE_RATE;
}

/** Removes the query string and fragment from a URL or relative path. */
export function strip_query(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/** beforeSend hook: strips location-bearing and identifying request data. */
export function scrub_event(event: ErrorEvent, _hint?: EventHint): ErrorEvent | null {
  if (event.request) {
    if (event.request.url) event.request.url = strip_query(event.request.url);
    delete event.request.query_string;
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.data;
  }
  delete event.user;
  for (const breadcrumb of event.breadcrumbs ?? []) {
    const data = breadcrumb.data;
    if (data && typeof data.url === "string") data.url = strip_query(data.url);
    if (data && typeof data.to === "string") data.to = strip_query(data.to);
    if (data && typeof data.from === "string") data.from = strip_query(data.from);
  }
  return event;
}

export function build_sentry_options(dsn: string | null, raw_traces_rate: string | undefined) {
  return {
    dsn: dsn ?? undefined,
    enabled: dsn !== null,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    sendDefaultPii: false,
    tracesSampleRate: resolve_traces_sample_rate(raw_traces_rate),
    beforeSend: scrub_event,
  };
}
