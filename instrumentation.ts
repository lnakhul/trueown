import * as Sentry from "@sentry/nextjs";

/** Loads the Sentry config that matches the runtime Next.js is starting. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
    const { register_telemetry_sink } = await import("./lib/telemetry");
    const { sentry_telemetry_sink } = await import("./lib/telemetry-sentry");
    register_telemetry_sink(sentry_telemetry_sink);
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

/** Reports errors thrown while rendering server components and route handlers. */
export const onRequestError = Sentry.captureRequestError;
