import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SUPPORTED_PROVIDERS,
  buildSupportedProvider,
  getSupportedProviderInfo,
  isProviderAvailable,
  isSupportedProvider,
  listSupportedProviderInfo,
  ProviderNotAvailableError,
} from "./supported-providers";
import { GroqProvider } from "./groq.provider";
import { TextWorkerProvider } from "./text-worker.provider";

// Snapshot and restore the env vars these tests toggle, so availability is
// derived deterministically regardless of the developer's local environment.
const ENV_KEYS = [
  "GROQ_API_KEY",
  "GROQ_MODEL",
  "TEXT_WORKER_URL",
  "TEXT_WORKER_API_KEY",
  "TEXT_WORKER_MODEL",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("supported-providers registry", () => {
  it("includes the supported providers and guards membership", () => {
    assert.ok(SUPPORTED_PROVIDERS.includes("grok"));
    assert.ok(SUPPORTED_PROVIDERS.includes("text_worker"));
    assert.equal(isSupportedProvider("grok"), true);
    assert.equal(isSupportedProvider("nonsense"), false);
  });

  it("reports not_configured when the required env is absent", () => {
    assert.equal(getSupportedProviderInfo("grok")!.status, "not_configured");
    assert.equal(isProviderAvailable("grok"), false);
  });

  it("reports available for Groq once GROQ_API_KEY exists", () => {
    process.env.GROQ_API_KEY = "k";
    assert.equal(getSupportedProviderInfo("grok")!.status, "available");
    assert.equal(isProviderAvailable("grok"), true);
  });

  it("treats Text Worker as available only when URL and key both exist", () => {
    process.env.TEXT_WORKER_URL = "https://worker.example.com";
    assert.equal(getSupportedProviderInfo("text_worker")!.status, "misconfigured");

    process.env.TEXT_WORKER_API_KEY = "k";
    assert.equal(getSupportedProviderInfo("text_worker")!.status, "available");
  });

  it("resolves the model from env, falling back to a default", () => {
    assert.equal(getSupportedProviderInfo("grok")!.model, "llama-3.3-70b-versatile");
    process.env.GROQ_MODEL = "llama-3.1-8b-instant";
    assert.equal(getSupportedProviderInfo("grok")!.model, "llama-3.1-8b-instant");
  });

  // The `grok` enum value is a historical misnomer; the vendor is Groq, and the
  // UI must never say "Grok" (xAI's unrelated model family).
  it("displays the Groq provider as Groq, not Grok", () => {
    assert.equal(getSupportedProviderInfo("grok")!.displayName, "Groq");
  });

  it("builds an instance when available and throws when not", () => {
    assert.throws(() => buildSupportedProvider("grok"), ProviderNotAvailableError);

    process.env.GROQ_API_KEY = "k";
    assert.ok(buildSupportedProvider("grok").instance instanceof GroqProvider);

    process.env.TEXT_WORKER_URL = "https://worker.example.com";
    process.env.TEXT_WORKER_API_KEY = "k";
    assert.ok(buildSupportedProvider("text_worker").instance instanceof TextWorkerProvider);
  });

  it("lists every provider in display order", () => {
    const list = listSupportedProviderInfo();
    assert.equal(list.length, SUPPORTED_PROVIDERS.length);
    assert.deepEqual(
      list.map((p) => p.provider),
      [...SUPPORTED_PROVIDERS]
    );
  });
});
