import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getLlmProviderFromConfig,
  ProviderConfigMissingError,
  LLM_PROVIDER_LABEL,
} from "./llm-provider-factory";
import { AnthropicProvider } from "./anthropic.provider";
import { OpenAILlmProvider } from "./openai.provider";
import { GroqProvider } from "./groq.provider";
import { TextWorkerProvider } from "./text-worker.provider";

// getLlmProviderFromConfig is the v2-5 per-generation resolution path. It never
// touches the DB or the network — it only maps a decrypted config to a provider
// instance — so these are pure, offline assertions.

describe("getLlmProviderFromConfig", () => {
  it("maps claude → AnthropicProvider", () => {
    const p = getLlmProviderFromConfig({
      provider: "claude",
      modelName: "claude-sonnet-4-6",
      apiKey: "k",
      baseUrl: null,
    });
    assert.ok(p instanceof AnthropicProvider);
  });

  it("maps openai → OpenAILlmProvider", () => {
    const p = getLlmProviderFromConfig({
      provider: "openai",
      modelName: "gpt-4.1-mini",
      apiKey: "k",
      baseUrl: null,
    });
    assert.ok(p instanceof OpenAILlmProvider);
  });

  it("maps grok → GroqProvider", () => {
    const p = getLlmProviderFromConfig({
      provider: "grok",
      modelName: "grok-2",
      apiKey: "k",
      baseUrl: null,
    });
    assert.ok(p instanceof GroqProvider);
  });

  describe("text_worker", () => {
    let prevUrl: string | undefined;

    before(() => {
      prevUrl = process.env.TEXT_WORKER_URL;
    });

    after(() => {
      if (prevUrl === undefined) delete process.env.TEXT_WORKER_URL;
      else process.env.TEXT_WORKER_URL = prevUrl;
    });

    it("uses the config baseUrl when present", () => {
      delete process.env.TEXT_WORKER_URL;
      const p = getLlmProviderFromConfig({
        provider: "text_worker",
        modelName: "qwen3:8b",
        apiKey: "k",
        baseUrl: "https://worker.example.com",
      });
      assert.ok(p instanceof TextWorkerProvider);
    });

    it("falls back to TEXT_WORKER_URL when the config has no baseUrl", () => {
      process.env.TEXT_WORKER_URL = "https://env-worker.example.com";
      const p = getLlmProviderFromConfig({
        provider: "text_worker",
        modelName: "qwen3:8b",
        apiKey: "k",
        baseUrl: null,
      });
      assert.ok(p instanceof TextWorkerProvider);
    });

    it("throws ProviderConfigMissingError when neither baseUrl nor TEXT_WORKER_URL is set", () => {
      delete process.env.TEXT_WORKER_URL;
      assert.throws(
        () =>
          getLlmProviderFromConfig({
            provider: "text_worker",
            modelName: "qwen3:8b",
            apiKey: "k",
            baseUrl: null,
          }),
        (err: unknown) =>
          err instanceof ProviderConfigMissingError && err.code === "PROVIDER_CONFIG_MISSING"
      );
    });
  });
});

describe("LLM_PROVIDER_LABEL", () => {
  it("has a distinct uppercase label for every provider", () => {
    assert.equal(LLM_PROVIDER_LABEL.claude, "CLAUDE");
    assert.equal(LLM_PROVIDER_LABEL.openai, "OPENAI");
    assert.equal(LLM_PROVIDER_LABEL.grok, "GROK");
    assert.equal(LLM_PROVIDER_LABEL.text_worker, "TEXT_WORKER");
  });
});
