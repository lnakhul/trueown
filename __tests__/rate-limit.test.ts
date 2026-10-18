import { create_rate_limiter, get_client_key } from "@/lib/rate-limit";

describe("rate limiter", () => {
  it("allows up to the limit then blocks with retry-after", () => {
    const limiter = create_rate_limiter(2, 60_000);
    expect(limiter.check("a", 0)).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.check("a", 1)).toMatchObject({ allowed: true, remaining: 0 });
    const blocked = limiter.check("a", 2);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retry_after_seconds).toBe(60);
  });

  it("tracks keys independently and resets after the window", () => {
    const limiter = create_rate_limiter(1, 1000);
    expect(limiter.check("a", 0).allowed).toBe(true);
    expect(limiter.check("b", 0).allowed).toBe(true);
    expect(limiter.check("a", 500).allowed).toBe(false);
    expect(limiter.check("a", 1000).allowed).toBe(true);
  });

  it("rejects invalid configuration", () => {
    expect(() => create_rate_limiter(0, 1000)).toThrow();
    expect(() => create_rate_limiter(1, 0)).toThrow();
  });

  it("uses the first forwarded hop as the client key", () => {
    expect(get_client_key(new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }))).toBe("1.2.3.4");
    expect(get_client_key(new Headers())).toBe("unknown");
  });
});

describe("POST /api/submissions abuse controls", () => {
  // Imported lazily so the route's module-level limiter is fresh for this suite.
  const post = async (body: unknown, ip: string): Promise<Response> => {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("@/app/api/submissions/route");
    return POST(
      new NextRequest("http://localhost/api/submissions", {
        method: "POST",
        headers: { "x-forwarded-for": ip, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  };

  it("silently accepts honeypot hits without touching the database", async () => {
    const response = await post({ website: "http://spam.example" }, "10.0.0.1");
    expect(response.status).toBe(201);
  });

  it("rejects oversized bodies with 413", async () => {
    const response = await post({ business_name: "x".repeat(10_000) }, "10.0.0.2");
    expect(response.status).toBe(413);
  });

  it("returns 429 with Retry-After after 5 requests from one client", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      statuses.push((await post({ business_name: "" }, "10.0.0.3")).status);
    }
    expect(statuses.slice(0, 5)).toEqual([422, 422, 422, 422, 422]);
    expect(statuses[5]).toBe(429);
    const blocked = await post({ business_name: "" }, "10.0.0.3");
    expect(blocked.headers.get("Retry-After")).not.toBeNull();
  });
});
