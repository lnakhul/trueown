import { create_shared_rate_limiter, is_shared_rate_limit_enabled } from "@/lib/rate-limit-shared";

const ORIGINAL_ENV = { ...process.env };
const fetch_mock = jest.fn();

beforeEach(() => {
  fetch_mock.mockReset();
  global.fetch = fetch_mock as unknown as typeof fetch;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

function use_redis(): void {
  process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
}

function redis_reply(count: number, ttl: number): Response {
  return new Response(JSON.stringify([{ result: count }, { result: 1 }, { result: ttl }]), { status: 200 });
}

describe("shared rate limiter", () => {
  it("uses the in-memory fallback when Redis is not configured", async () => {
    const limiter = create_shared_rate_limiter("t1", 1, 60_000);
    expect(is_shared_rate_limit_enabled()).toBe(false);
    expect((await limiter.check("a")).allowed).toBe(true);
    expect((await limiter.check("a")).allowed).toBe(false);
    expect(fetch_mock).not.toHaveBeenCalled();
  });

  it("rejects a non-https Redis URL", () => {
    process.env.UPSTASH_REDIS_REST_URL = "http://insecure.example.com";
    process.env.UPSTASH_REDIS_REST_TOKEN = "token";
    expect(is_shared_rate_limit_enabled()).toBe(false);
  });

  it("allows within the limit and blocks above it using Redis counts", async () => {
    use_redis();
    const limiter = create_shared_rate_limiter("t2", 2, 60_000);
    fetch_mock.mockResolvedValueOnce(redis_reply(2, 3000));
    expect(await limiter.check("a")).toMatchObject({ allowed: true, remaining: 0 });
    fetch_mock.mockResolvedValueOnce(redis_reply(3, 2500));
    expect(await limiter.check("a")).toMatchObject({ allowed: false, retry_after_seconds: 2500 });

    const [url, init] = fetch_mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.upstash.io/pipeline");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token");
  });

  it("falls back to in-memory limits when Redis fails", async () => {
    use_redis();
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    const limiter = create_shared_rate_limiter("t3", 1, 60_000);
    fetch_mock.mockRejectedValue(new Error("network down"));
    expect((await limiter.check("a")).allowed).toBe(true);
    expect((await limiter.check("a")).allowed).toBe(false);
  });

  it("treats a malformed Redis reply as a failure and still limits", async () => {
    use_redis();
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    const limiter = create_shared_rate_limiter("t4", 1, 60_000);
    fetch_mock.mockResolvedValue(new Response(JSON.stringify([{ error: "ERR" }]), { status: 200 }));
    expect((await limiter.check("a")).allowed).toBe(true);
    expect((await limiter.check("a")).allowed).toBe(false);
  });
});
