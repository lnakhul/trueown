import { verify_turnstile_token, is_turnstile_enabled } from "@/lib/turnstile";

const json_response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

describe("turnstile verification", () => {
  const original = { ...process.env };
  beforeEach(() => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it("is enabled only when a secret is configured", () => {
    expect(is_turnstile_enabled()).toBe(true);
    delete process.env.TURNSTILE_SECRET_KEY;
    expect(is_turnstile_enabled()).toBe(false);
  });

  it("rejects missing, non-string and oversized tokens without calling Cloudflare", async () => {
    const fetch_mock = jest.fn();
    for (const token of [undefined, null, "", 42, "x".repeat(2049)]) {
      expect(await verify_turnstile_token(token, null, fetch_mock)).toEqual({
        ok: false,
        reason: "missing_token",
      });
    }
    expect(fetch_mock).not.toHaveBeenCalled();
  });

  it("accepts a token Cloudflare marks successful and posts secret + response", async () => {
    const fetch_mock = jest.fn().mockResolvedValue(json_response({ success: true }));
    expect(await verify_turnstile_token("tok", "1.2.3.4", fetch_mock)).toEqual({ ok: true });
    const body = (fetch_mock.mock.calls[0][1] as RequestInit).body as URLSearchParams;
    expect(body.get("secret")).toBe("test-secret");
    expect(body.get("response")).toBe("tok");
    expect(body.get("remoteip")).toBe("1.2.3.4");
  });

  it("rejects tokens Cloudflare marks unsuccessful", async () => {
    const fetch_mock = jest.fn().mockResolvedValue(json_response({ success: false }));
    expect(await verify_turnstile_token("tok", null, fetch_mock)).toEqual({
      ok: false,
      reason: "invalid_token",
    });
  });

  it("classifies Cloudflare error codes: bad token is 403-class, bad secret is 503-class", async () => {
    const bad_token = jest
      .fn()
      .mockResolvedValue(json_response({ success: false, "error-codes": ["invalid-input-response"] }, 400));
    expect(await verify_turnstile_token("t", null, bad_token)).toEqual({ ok: false, reason: "invalid_token" });
    const duplicate = jest
      .fn()
      .mockResolvedValue(json_response({ success: false, "error-codes": ["timeout-or-duplicate"] }));
    expect(await verify_turnstile_token("t", null, duplicate)).toEqual({ ok: false, reason: "invalid_token" });
    const bad_secret = jest
      .fn()
      .mockResolvedValue(json_response({ success: false, "error-codes": ["invalid-input-secret"] }, 400));
    expect(await verify_turnstile_token("t", null, bad_secret)).toEqual({
      ok: false,
      reason: "verification_unavailable",
    });
  });

  it("fails closed on network errors, non-200s and malformed bodies", async () => {
    const unavailable = { ok: false, reason: "verification_unavailable" };
    expect(await verify_turnstile_token("t", null, jest.fn().mockRejectedValue(new Error("down")))).toEqual(unavailable);
    expect(await verify_turnstile_token("t", null, jest.fn().mockResolvedValue(json_response({}, 500)))).toEqual(unavailable);
    expect(
      await verify_turnstile_token("t", null, jest.fn().mockResolvedValue(new Response("<html>", { status: 200 }))),
    ).toEqual(unavailable);
  });

  it("is unavailable when the secret is not configured", async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    expect(await verify_turnstile_token("t", null, jest.fn())).toEqual({
      ok: false,
      reason: "verification_unavailable",
    });
  });
});
