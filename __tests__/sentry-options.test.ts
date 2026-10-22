import type { ErrorEvent } from "@sentry/nextjs";
import {
  build_sentry_options,
  resolve_sentry_dsn,
  resolve_traces_sample_rate,
  scrub_event,
  strip_query,
} from "@/lib/sentry-options";

describe("sentry options", () => {
  test("monitoring is disabled without a DSN and enabled with one", () => {
    expect(resolve_sentry_dsn(undefined)).toBeNull();
    expect(resolve_sentry_dsn("   ")).toBeNull();
    expect(build_sentry_options(null, undefined).enabled).toBe(false);

    const options = build_sentry_options("https://key@o1.ingest.sentry.io/2", undefined);
    expect(options.enabled).toBe(true);
    expect(options.sendDefaultPii).toBe(false);
  });

  test("traces sample rate falls back to the default for invalid input", () => {
    expect(resolve_traces_sample_rate("0.5")).toBe(0.5);
    expect(resolve_traces_sample_rate("0")).toBe(0);
    expect(resolve_traces_sample_rate("2")).toBe(0.1);
    expect(resolve_traces_sample_rate("abc")).toBe(0.1);
    expect(resolve_traces_sample_rate(undefined)).toBe(0.1);
  });

  test("strip_query removes query strings and fragments", () => {
    expect(strip_query("/api/proximity?lat=40.7&lng=-74.0")).toBe("/api/proximity");
    expect(strip_query("https://x.test/a#frag")).toBe("https://x.test/a");
    expect(strip_query("/plain")).toBe("/plain");
  });

  test("scrub_event drops location, cookies, headers, body and user data", () => {
    const event = {
      type: undefined,
      request: {
        url: "https://trueown.app/api/proximity?scope=nearest&lat=40.7324&lng=-74.0021",
        query_string: "lat=40.7324&lng=-74.0021",
        cookies: { session: "secret" },
        headers: { cookie: "session=secret" },
        data: { business_name: "x" },
      },
      user: { ip_address: "1.2.3.4" },
      breadcrumbs: [{ data: { url: "/api/proximity?lat=40.7&lng=-74.0", to: "/?x=1" } }],
    } as unknown as ErrorEvent;

    const scrubbed = scrub_event(event);
    expect(scrubbed?.request).toEqual({ url: "https://trueown.app/api/proximity" });
    expect(scrubbed?.user).toBeUndefined();
    expect(scrubbed?.breadcrumbs?.[0]?.data).toEqual({ url: "/api/proximity", to: "/" });
  });
});
