import * as Sentry from "@sentry/nextjs";

/**
 * Server-side error reporting: always logs, and forwards to Sentry when a DSN is
 * configured (captureException is a no-op otherwise). `context` is a short, static
 * label such as "[proximity] lookup failed"; never put user input or coordinates in it.
 */
export function report_error(context: string, error: unknown): void {
  console.error(`${context}:`, error);
  Sentry.captureException(error, { tags: { context } });
}
