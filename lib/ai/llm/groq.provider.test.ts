import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { GroqProvider, parseRetryAfterMs } from "./groq.provider";
import { LlmProviderError, LlmRateLimitError } from "../errors";

// ─── fetch stubbing ───────────────────────────────────────────────────────────

type Reply = { status: number; body: string; headers?: Record<string, string> };

const realFetch = globalThis.fetch;
let requests: { url: string; body: Record<string, unknown> }[] = [];

function stubFetch(replies: Reply[]) {
  let i = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const reply = replies[Math.min(i, replies.length - 1)];
    i++;
    requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      statusText: String(reply.status),
      headers: { get: (h: string) => reply.headers?.[h.toLowerCase()] ?? null },
      text: async () => reply.body,
      json: async () => JSON.parse(reply.body),
    };
  }) as unknown as typeof fetch;
}

const OK_BODY = JSON.stringify({ choices: [{ message: { content: "hello" } }] });
const RATE_LIMIT_BODY = JSON.stringify({
  error: { code: "rate_limit_exceeded", message: "Rate limit reached for llama-3.3-70b-versatile" },
});

// Records sleeps instead of performing them, so backoff is asserted, not waited on.
function makeSleepSpy() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms) };
}

const REQUEST = { systemPrompt: "sys", userPrompt: "user" };

beforeEach(() => {
  requests = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ─── Retry-After parsing ──────────────────────────────────────────────────────

describe("parseRetryAfterMs", () => {
  it("parses integer and fractional seconds", () => {
    assert.equal(parseRetryAfterMs("7"), 7_000);
    assert.equal(parseRetryAfterMs("2.5"), 2_500);
  });

  it("parses an HTTP-date into a future offset", () => {
    const at = new Date(Date.now() + 30_000).toUTCString();
    const ms = parseRetryAfterMs(at)!;
    // Second-resolution header → allow a small window.
    assert.ok(ms > 28_000 && ms <= 31_000, `expected ~30s, got ${ms}`);
  });

  it("never returns a negative wait for a past date", () => {
    assert.equal(parseRetryAfterMs(new Date(Date.now() - 60_000).toUTCString()), 0);
  });

  it("returns undefined when absent or unparseable", () => {
    assert.equal(parseRetryAfterMs(null), undefined);
    assert.equal(parseRetryAfterMs(""), undefined);
    assert.equal(parseRetryAfterMs("soon"), undefined);
  });
});

// ─── Happy path ───────────────────────────────────────────────────────────────

describe("GroqProvider — request shape", () => {
  it("posts the selected model to the Groq endpoint", async () => {
    stubFetch([{ status: 200, body: OK_BODY }]);
    const provider = new GroqProvider("key", "llama-3.3-70b-versatile");

    const res = await provider.generate(REQUEST);

    assert.equal(res.text, "hello");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://api.groq.com/openai/v1/chat/completions");
    assert.equal(requests[0].body.model, "llama-3.3-70b-versatile");
  });
});

// ─── Rate limiting ────────────────────────────────────────────────────────────

describe("GroqProvider — 429 handling", () => {
  it("retries after a 429 and succeeds, honouring Retry-After", async () => {
    stubFetch([
      { status: 429, body: RATE_LIMIT_BODY, headers: { "retry-after": "2" } },
      { status: 200, body: OK_BODY },
    ]);
    const { slept, sleep } = makeSleepSpy();
    const provider = new GroqProvider("key", "m", undefined, { sleep });

    const res = await provider.generate(REQUEST);

    assert.equal(res.text, "hello");
    assert.equal(requests.length, 2, "should have retried once");
    assert.deepEqual(slept, [2_000], "should wait exactly the advertised Retry-After");
  });

  it("uses exponential backoff when Retry-After is absent", async () => {
    stubFetch([
      { status: 429, body: RATE_LIMIT_BODY },
      { status: 429, body: RATE_LIMIT_BODY },
      { status: 200, body: OK_BODY },
    ]);
    const { slept, sleep } = makeSleepSpy();
    const provider = new GroqProvider("key", "m", undefined, { sleep });

    await provider.generate(REQUEST);

    assert.deepEqual(slept, [1_000, 2_000]);
  });

  it("throws LlmRateLimitError with retryAfterMs once attempts are exhausted", async () => {
    stubFetch([{ status: 429, body: RATE_LIMIT_BODY, headers: { "retry-after": "3" } }]);
    const { sleep } = makeSleepSpy();
    const provider = new GroqProvider("key", "m", undefined, { maxAttempts: 2, sleep });

    const err = await provider.generate(REQUEST).then(
      () => null,
      (e: unknown) => e
    );

    assert.ok(err instanceof LlmRateLimitError);
    assert.equal(err.retryAfterMs, 3_000);
    assert.equal(requests.length, 2, "initial attempt + one retry");
  });

  it("does not sleep through a Retry-After longer than the cap", async () => {
    stubFetch([{ status: 429, body: RATE_LIMIT_BODY, headers: { "retry-after": "600" } }]);
    const { slept, sleep } = makeSleepSpy();
    const provider = new GroqProvider("key", "m", undefined, { sleep });

    const err = await provider.generate(REQUEST).then(
      () => null,
      (e: unknown) => e
    );

    assert.ok(err instanceof LlmRateLimitError);
    assert.equal(err.retryAfterMs, 600_000, "the provider's wait is preserved for the caller");
    assert.deepEqual(slept, [], "must fail fast rather than hold the request open");
    assert.equal(requests.length, 1);
  });

  it("treats a rate_limit_exceeded body as rate limited even off a non-429 status", async () => {
    stubFetch([{ status: 503, body: RATE_LIMIT_BODY }]);
    const { sleep } = makeSleepSpy();
    const provider = new GroqProvider("key", "m", undefined, { maxAttempts: 1, sleep });

    const err = await provider.generate(REQUEST).then(
      () => null,
      (e: unknown) => e
    );

    assert.ok(err instanceof LlmRateLimitError);
  });

  it("never switches model across retries", async () => {
    stubFetch([
      { status: 429, body: RATE_LIMIT_BODY },
      { status: 200, body: OK_BODY },
    ]);
    const { sleep } = makeSleepSpy();
    const provider = new GroqProvider("key", "llama-3.3-70b-versatile", undefined, { sleep });

    await provider.generate(REQUEST);

    assert.deepEqual(
      requests.map((r) => r.body.model),
      ["llama-3.3-70b-versatile", "llama-3.3-70b-versatile"]
    );
  });
});

// ─── Non-rate-limit errors ────────────────────────────────────────────────────

describe("GroqProvider — other errors", () => {
  it("throws a plain LlmProviderError on a non-rate-limit failure, without retrying", async () => {
    stubFetch([{ status: 500, body: "boom" }]);
    const provider = new GroqProvider("key", "m");

    const err = await provider.generate(REQUEST).then(
      () => null,
      (e: unknown) => e
    );

    assert.ok(err instanceof LlmProviderError);
    assert.ok(!(err instanceof LlmRateLimitError));
    assert.match((err as Error).message, /Groq API error 500/);
    assert.equal(requests.length, 1, "non-rate-limit errors must not be retried");
  });
});
