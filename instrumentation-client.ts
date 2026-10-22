import * as Sentry from "@sentry/nextjs";
import { build_sentry_options, resolve_sentry_dsn } from "@/lib/sentry-options";

// Browser runtime: only NEXT_PUBLIC_* variables are inlined, so the DSN must be public.
// Session replay is not enabled: tip forms contain user-entered text.
Sentry.init(
  build_sentry_options(
    resolve_sentry_dsn(process.env.NEXT_PUBLIC_SENTRY_DSN),
    process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
  ),
);

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
