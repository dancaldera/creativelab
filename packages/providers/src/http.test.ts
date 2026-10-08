import { describe, expect, it } from "vitest";
import { assertNoSecretLeak, containsSecret, redactSecret, scrubSecrets } from "./credentials.js";
import { HttpClient, parseRetryAfter, redactUrl, type HttpErrorPayload } from "./http.js";
import { ANY_URL, createMockFetch } from "./test-fetch.test-helper.js";

/**
 * Fake-fetch tests for the one HTTP path every adapter shares (PRD §12 retries/backoff,
 * PRD §13 credential hygiene).
 */

const TOKEN = "sk-live-supersecret-token-value-123456";

/** Instant, recorded sleep so backoff assertions do not cost wall-clock time. */
function recorder(): { delays: number[]; sleep: (ms: number) => Promise<void> } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

describe("HttpClient.request", () => {
  it("retries a 500 and then succeeds", async () => {
    const mock = createMockFetch();
    mock.addRoute(ANY_URL, [
      { status: 500, statusText: "Internal Server Error", json: { error: "boom" } },
      { status: 200, json: { ok: true } },
    ]);
    const timer = recorder();
    const client = new HttpClient({
      fetch: mock.fetch,
      sleep: timer.sleep,
      random: () => 0,
      maxRetries: 2,
    });

    const body = await client.requestJson<{ ok: boolean }>("https://api.test/v1/thing", {
      method: "POST",
      body: { a: 1 },
    });

    expect(body).toEqual({ ok: true });
    expect(mock.countFor(ANY_URL)).toBe(2);
    expect(timer.delays).toHaveLength(1);
  });

  it("honours `Retry-After: 2` seconds with a delay of at least 2000ms", async () => {
    const mock = createMockFetch();
    mock.addRoute(ANY_URL, [
      {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "retry-after": "2" },
        json: { error: "slow down" },
      },
      { status: 200, json: { ok: true } },
    ]);
    const timer = recorder();
    const retries: number[] = [];
    const client = new HttpClient({
      fetch: mock.fetch,
      sleep: timer.sleep,
      // A random draw of 0 makes the exponential component 0, so only Retry-After can
      // produce a non-zero delay — which is exactly what this test pins down.
      random: () => 0,
      maxRetries: 2,
      baseBackoffMs: 500,
      onRetry: (info) => retries.push(info.delayMs),
    });

    await client.request("https://api.test/v1/thing");

    expect(mock.countFor(ANY_URL)).toBe(2);
    expect(retries).toEqual([2000]);
    expect(timer.delays[0]).toBeGreaterThanOrEqual(2000);
  });

  it("honours `Retry-After` in HTTP-date form", async () => {
    const now = new Date("2026-10-07T12:00:00.000Z");
    const mock = createMockFetch();
    mock.addRoute(ANY_URL, [
      {
        status: 429,
        headers: { "retry-after": new Date(now.getTime() + 3_000).toUTCString() },
        json: { error: "slow down" },
      },
      { status: 200, json: { ok: true } },
    ]);
    const timer = recorder();
    const retries: number[] = [];
    const client = new HttpClient({
      fetch: mock.fetch,
      sleep: timer.sleep,
      random: () => 0,
      now: () => now,
      maxRetries: 2,
      baseBackoffMs: 100,
      onRetry: (info) => retries.push(info.delayMs),
    });

    await client.request("https://api.test/v1/thing");

    // The HTTP-date is 3s in the future relative to the injected clock.
    expect(retries[0]).toBeGreaterThanOrEqual(2_900);
    expect(retries[0]).toBeLessThanOrEqual(3_100);
  });

  it("does not retry a 400", async () => {
    const mock = createMockFetch();
    mock.addRoute(ANY_URL, [
      { status: 400, statusText: "Bad Request", json: { error: "invalid prompt" } },
    ]);
    const timer = recorder();
    const client = new HttpClient({
      fetch: mock.fetch,
      sleep: timer.sleep,
      random: () => 0,
      maxRetries: 3,
    });

    await expect(
      client.requestJson("https://api.test/v1/thing", { method: "POST", body: {} }),
    ).rejects.toMatchObject({
      name: "ProviderError",
      status: 400,
      retryable: false,
      category: "validation",
    });
    expect(mock.countFor(ANY_URL)).toBe(1);
    expect(timer.delays).toHaveLength(0);
  });

  it("stops after maxRetries retryable failures", async () => {
    const mock = createMockFetch();
    mock.addRoute(ANY_URL, [
      { status: 503, statusText: "Service Unavailable", json: { error: "down" } },
    ]);
    const timer = recorder();
    const client = new HttpClient({
      fetch: mock.fetch,
      sleep: timer.sleep,
      random: () => 0,
      maxRetries: 2,
    });

    await expect(client.request("https://api.test/v1/thing")).rejects.toMatchObject({
      status: 503,
      retryable: true,
    });
    // 1 initial attempt + 2 retries.
    expect(mock.countFor(ANY_URL)).toBe(3);
    expect(timer.delays).toHaveLength(2);
  });

  it("attaches an Idempotency-Key when provided and omits it otherwise", async () => {
    const mock = createMockFetch();
    mock.addRoute(ANY_URL, [{ status: 200, json: { ok: true } }]);
    const client = new HttpClient({ fetch: mock.fetch });

    await client.requestJson("https://api.test/v1/a", {
      method: "POST",
      body: {},
      idempotencyKey: "key-123",
    });
    expect(mock.lastRequest()?.header("idempotency-key")).toBe("key-123");

    await client.requestJson("https://api.test/v1/b", { method: "POST", body: {} });
    expect(mock.lastRequest()?.header("idempotency-key")).toBeNull();
  });
});

describe("HttpClient redaction", () => {
  it("keeps no bearer token in the error message, details or JSON serialization", async () => {
    const mock = createMockFetch();
    mock.addRoute(ANY_URL, [
      {
        status: 401,
        statusText: "Unauthorized",
        // A hostile body that echoes the key back at us.
        json: { error: "invalid key", echoed: `Bearer ${TOKEN}`, hint: `api_key=${TOKEN}` },
      },
    ]);
    const client = new HttpClient({
      fetch: mock.fetch,
      secrets: [TOKEN],
      maxRetries: 1,
      sleep: async () => undefined,
    });

    let caught: unknown;
    try {
      await client.requestJson("https://api.test/v1/thing", {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "x-api-key": TOKEN,
          cookie: `session=${TOKEN}`,
        },
        body: { prompt: "hello" },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error & {
      details: Record<string, unknown>;
      category: string;
      status: number;
    };

    expect(error.category).toBe("credential");
    expect(error.status).toBe(401);
    expect(error.message).not.toContain(TOKEN);
    expect(JSON.stringify(error.details)).not.toContain(TOKEN);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(containsSecret(error, TOKEN)).toBe(false);

    // The redacted request headers are present but masked; the response headers are kept
    // as-is because providers never echo the request's Authorization header.
    const payload = error.details as unknown as HttpErrorPayload;
    expect(payload.requestHeaders["authorization"]).toBe("***");
    expect(payload.requestHeaders["x-api-key"]).toBe("***");
    expect(payload.requestHeaders["cookie"]).toBe("***");
    expect(payload.requestHeaders["accept"]).toBe("application/json");
    expect(() => assertNoSecretLeak(error, TOKEN)).not.toThrow();
  });

  it("redacts a short secret that a body echoes verbatim", async () => {
    const secret = "abc123secret";
    const mock = createMockFetch();
    mock.addRoute(ANY_URL, [{ status: 500, json: { echo: secret } }]);
    const client = new HttpClient({ fetch: mock.fetch, secrets: [secret], maxRetries: 0 });

    const error = await client
      .request("https://api.test/v1/thing")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(secret);
  });

  it("masks secret-looking query parameters in a URL", () => {
    expect(redactUrl("https://api.test/v1/x?api_key=abcdef&other=1")).not.toContain("abcdef");
    expect(redactUrl("https://user:pass@api.test/v1/x")).not.toContain("pass");
  });

  it("scrubSecrets strips credentials, and redactSecret is a *** marker", () => {
    expect(redactSecret("abcdefghijkl")).toBe("***");
    expect(redactSecret("")).toBe("***");
    expect(
      scrubSecrets({ a: "api_key=abcdefgh", b: ["Bearer abcdefghijkl"], c: "sk-abcdefghijklmnop" }),
    ).toEqual({
      a: "***",
      b: ["***"],
      c: "***",
    });
  });
});

describe("HttpClient malformed bodies", () => {
  it("throws a ProviderError for a malformed JSON body instead of returning undefined", async () => {
    const mock = createMockFetch();
    mock.addRoute(ANY_URL, [
      {
        status: 200,
        headers: { "content-type": "application/json" },
        text: "<html>not json at all</html>",
      },
    ]);
    const client = new HttpClient({ fetch: mock.fetch, maxRetries: 0 });

    const error = await client
      .request("https://api.test/v1/thing")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("ProviderError");
    expect((error as { category: string }).category).toBe("provider");
    expect((error as Error).message).toContain("malformed JSON body");
  });

  it("returns undefined for an empty 204 body", async () => {
    const mock = createMockFetch();
    mock.addRoute(ANY_URL, [{ status: 204, text: "" }]);
    const client = new HttpClient({ fetch: mock.fetch, maxRetries: 0 });
    await expect(client.request("https://api.test/v1/thing")).resolves.toBeUndefined();
  });

  it("includes the body text in a non-2xx error even when the body is not JSON", async () => {
    const mock = createMockFetch();
    mock.addRoute(ANY_URL, [{ status: 502, statusText: "Bad Gateway", text: "upstream exploded" }]);
    const client = new HttpClient({ fetch: mock.fetch, maxRetries: 0 });
    await expect(client.request("https://api.test/v1/thing")).rejects.toThrow(/upstream exploded/);
  });
});

describe("HttpClient timeout", () => {
  it("aborts on timeout and reports a retryable timeout error", async () => {
    // A transport that never settles, so only the client's own timeout can end the call.
    const hangingFetch = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new Error("aborted")),
          { once: true },
        );
      })) as unknown as typeof fetch;

    const started = Date.now();
    const client = new HttpClient({ fetch: hangingFetch, timeoutMs: 25, maxRetries: 0 });
    const error = await client
      .request("https://api.test/v1/slow")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as { category: string }).category).toBe("timeout");
    expect((error as { retryable: boolean }).retryable).toBe(true);
    expect((error as Error).message).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("surfaces caller cancellation as a canceled error, not a timeout", async () => {
    const hangingFetch = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new Error("aborted")),
          { once: true },
        );
      })) as unknown as typeof fetch;

    const controller = new AbortController();
    const client = new HttpClient({ fetch: hangingFetch, timeoutMs: 5_000, maxRetries: 0 });
    const pending = client.request("https://api.test/v1/slow", { signal: controller.signal });
    controller.abort();

    const error = await pending.catch((caught: unknown) => caught);
    expect((error as { category: string }).category).toBe("canceled");
  });
});

describe("parseRetryAfter", () => {
  const now = new Date("2026-10-07T12:00:00.000Z");

  it("parses delta-seconds", () => {
    expect(parseRetryAfter("2", now)).toBe(2);
    expect(parseRetryAfter("0", now)).toBe(0);
    expect(parseRetryAfter("1.5", now)).toBe(1.5);
  });

  it("parses an HTTP-date", () => {
    expect(parseRetryAfter(new Date(now.getTime() + 5_000).toUTCString(), now)).toBeCloseTo(5, 3);
  });

  it("ignores absent or nonsense values", () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter("-5", now)).toBeUndefined();
  });
});
