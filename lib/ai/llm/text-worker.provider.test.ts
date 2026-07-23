import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { TextWorkerProvider, TEXT_WORKER_TIMEOUT_MS } from "./text-worker.provider";
import { LlmProviderError } from "../errors";

// ─── fetch stubbing ───────────────────────────────────────────────────────────

type Reply = { status: number; body: string };

const realFetch = globalThis.fetch;
let requests: Array<{
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal: unknown;
}> = [];

function stubFetch(reply: Reply) {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({
      url: String(url),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init.body)),
      signal: init.signal,
    });
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      statusText: String(reply.status),
      text: async () => reply.body,
      json: async () => JSON.parse(reply.body),
    };
  }) as unknown as typeof fetch;
}

const REQUEST = { systemPrompt: "sys", userPrompt: "user" };

beforeEach(() => {
  requests = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ─── Timeout cap (the 120s → 300s fix) ──────────────────────────────────────────

describe("TextWorkerProvider — per-request timeout cap", () => {
  it("uses a 300s cap so slow (e.g. Ollama) generations are not aborted early", () => {
    // Regression guard for the fix: the app-side cap must match the worker's own 300s
    // Ollama timeout, otherwise the app aborts a request the worker would have completed.
    assert.equal(TEXT_WORKER_TIMEOUT_MS, 300_000);
  });

  it("passes an AbortSignal to fetch (the request is deadline-bounded)", async () => {
    stubFetch({ status: 200, body: JSON.stringify({ text: "ok" }) });
    await new TextWorkerProvider("http://worker.local", "key", "model").generate(REQUEST);

    assert.equal(requests.length, 1);
    assert.ok(requests[0].signal instanceof AbortSignal);
  });
});

// ─── Request shape + auth header ────────────────────────────────────────────────

describe("TextWorkerProvider — request shape", () => {
  it("POSTs to {workerUrl}/generate with the model, concatenated prompt, and api-key header", async () => {
    stubFetch({ status: 200, body: JSON.stringify({ text: "translated" }) });
    const provider = new TextWorkerProvider("https://worker.local/", "secret-key", "llama3");

    const res = await provider.generate(REQUEST);

    assert.equal(res.text, "translated");
    assert.equal(requests.length, 1);
    // Trailing slash on the base URL is normalised — exactly one /generate segment.
    assert.equal(requests[0].url, "https://worker.local/generate");
    assert.equal(requests[0].body.model, "llama3");
    assert.equal(requests[0].body.prompt, "sys\n\nuser");
    // The auth header must still be sent after the timeout change.
    assert.equal(requests[0].headers["x-worker-api-key"], "secret-key");
    assert.equal(requests[0].headers["content-type"], "application/json");
  });

  it("sends only the user prompt when the system prompt is empty", async () => {
    stubFetch({ status: 200, body: JSON.stringify({ text: "ok" }) });
    await new TextWorkerProvider("http://worker.local", "k", "m").generate({
      systemPrompt: "",
      userPrompt: "hi",
    });

    assert.equal(requests[0].body.prompt, "hi");
  });
});

// ─── Error handling ─────────────────────────────────────────────────────────────

describe("TextWorkerProvider — errors", () => {
  it("throws LlmProviderError on a non-2xx worker response", async () => {
    stubFetch({ status: 500, body: "boom" });
    const provider = new TextWorkerProvider("http://worker.local", "k", "m");

    const err = await provider.generate(REQUEST).then(
      () => null,
      (e: unknown) => e
    );

    assert.ok(err instanceof LlmProviderError);
    assert.match((err as Error).message, /Text worker error 500/);
  });
});
