import * as Sentry from "@sentry/nextjs";
import { build_sentry_options, resolve_sentry_dsn } from "@/lib/sentry-options";

Sentry.init(
  build_sentry_options(
    resolve_sentry_dsn(process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN),
    process.env.SENTRY_TRACES_SAMPLE_RATE,
  ),
);
