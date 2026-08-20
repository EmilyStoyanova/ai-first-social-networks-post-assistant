import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTranslationProvider } from "./translation-provider-factory";
import type { ResolveLlmFn } from "./translation-provider-factory";

/**
 * Which engine gets built, from which environment. The first test is the one that
 * matters most: an empty environment must still build the engine that has always run.
 */

const llm: ResolveLlmFn = async () => ({
  ok: true,
  instance: { generate: async () => ({ text: "{}" }) },
  provider: "TEXT_WORKER",
  model: "qwen3:8b",
});

const noLlm: ResolveLlmFn = async () => ({ ok: false });

const WORKER_ENV = {
  TEXT_WORKER_URL: "http://192.168.31.102:3002",
  TEXT_WORKER_API_KEY: "secret",
};

describe("buildTranslationProvider — the default", () => {
  it("builds the prompt-based engine when nothing is configured", async () => {
    const result = await buildTranslationProvider({ resolveLlm: llm, env: {} });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.provider.kind, "ollama");
  });

  it("keeps the admin default's provider label and model as the stored provenance", async () => {
    const result = await buildTranslationProvider({ resolveLlm: llm, env: {} });
    assert.ok(result.ok);
    assert.equal(result.provider.providerLabel, "TEXT_WORKER");
    assert.equal(result.provider.model, "qwen3:8b");
  });

  it("reports no provider — rather than guessing — when no admin default exists", async () => {
    const result = await buildTranslationProvider({ resolveLlm: noLlm, env: {} });
    assert.equal(result.ok, false);
  });

  it("builds the prompt-based engine for an explicit TRANSLATION_PROVIDER=ollama", async () => {
    const result = await buildTranslationProvider({
      resolveLlm: llm,
      env: { TRANSLATION_PROVIDER: "ollama" },
    });
    assert.ok(result.ok);
    assert.equal(result.provider.kind, "ollama");
  });

  it("degrades a typo to the default engine, loudly, rather than to no translation", async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(String(args[0]));
    let result;
    try {
      result = await buildTranslationProvider({
        resolveLlm: llm,
        env: { ...WORKER_ENV, TRANSLATION_PROVIDER: "maddlad" },
      });
    } finally {
      console.warn = original;
    }
    assert.ok(result.ok);
    assert.equal(result.provider.kind, "ollama");
    assert.equal(result.config.kind, "ollama");
    assert.match(warnings[0], /maddlad/);
  });
});

describe("buildTranslationProvider — MADLAD", () => {
  it("builds the MADLAD engine against the EXISTING text worker", async () => {
    const result = await buildTranslationProvider({
      resolveLlm: llm,
      env: { ...WORKER_ENV, TRANSLATION_PROVIDER: "madlad" },
    });
    assert.ok(result.ok);
    assert.equal(result.provider.kind, "madlad");
    // The provenance names WHO SERVED the model — MADLAD runs inside the text worker.
    // The ENGINE is `kind`, and the model is what tells the two apart in the data.
    assert.equal(result.provider.providerLabel, "TEXT_WORKER");
    assert.equal(result.provider.model, "google/madlad400-3b-mt");
  });

  it("never touches the LLM selection when MADLAD is chosen", async () => {
    let asked = false;
    await buildTranslationProvider({
      resolveLlm: async () => {
        asked = true;
        return { ok: false };
      },
      env: { ...WORKER_ENV, TRANSLATION_PROVIDER: "madlad" },
    });
    assert.equal(asked, false, "MADLAD does not run through an LlmConfig row");
  });

  it("refuses rather than quietly translating with the other engine when the worker is unconfigured", async () => {
    const result = await buildTranslationProvider({
      resolveLlm: llm,
      env: { TRANSLATION_PROVIDER: "madlad" },
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && /TEXT_WORKER_URL/.test(result.reason));
  });

  it("honours an explicit MADLAD checkpoint", async () => {
    const result = await buildTranslationProvider({
      resolveLlm: llm,
      env: {
        ...WORKER_ENV,
        TRANSLATION_PROVIDER: "madlad",
        TRANSLATION_MADLAD_MODEL: "google/madlad400-10b-mt",
      },
    });
    assert.ok(result.ok);
    assert.equal(result.provider.model, "google/madlad400-10b-mt");
  });

  it("threads the configured HTTP batch size through to the built provider's config", async () => {
    const result = await buildTranslationProvider({
      resolveLlm: llm,
      env: {
        ...WORKER_ENV,
        TRANSLATION_PROVIDER: "madlad",
        TRANSLATION_MADLAD_HTTP_BATCH_SIZE: "10",
      },
    });
    assert.ok(result.ok);
    assert.equal(result.provider.kind, "madlad");
    assert.equal(result.config.madladHttpBatchSize, 10);
  });

  it("defaults the HTTP batch size to 30 when unset", async () => {
    const result = await buildTranslationProvider({
      resolveLlm: llm,
      env: { ...WORKER_ENV, TRANSLATION_PROVIDER: "madlad" },
    });
    assert.ok(result.ok);
    assert.equal(result.config.madladHttpBatchSize, 30);
  });
});

describe("buildTranslationProvider — the Ollama model override", () => {
  it("is ignored when it matches what the admin default already resolves to", async () => {
    const result = await buildTranslationProvider({
      resolveLlm: llm,
      env: { TRANSLATION_OLLAMA_MODEL: "qwen3:8b" },
    });
    assert.ok(result.ok);
    assert.equal(result.provider.model, "qwen3:8b");
  });

  it("refuses to override the model of a provider that was never asked for", async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(String(args[0]));
    let result;
    try {
      result = await buildTranslationProvider({
        // The admin default is Groq, not the text worker.
        resolveLlm: async () => ({
          ok: true,
          instance: { generate: async () => ({ text: "{}" }) },
          provider: "GROQ",
          model: "llama-3.3-70b-versatile",
        }),
        env: { TRANSLATION_OLLAMA_MODEL: "qwen3:8b" },
      });
    } finally {
      console.warn = original;
    }
    assert.ok(result.ok);
    // Swapping a cloud provider's model behind the admin's back would be a silent
    // provider swap — the one thing this pipeline refuses everywhere.
    assert.equal(result.provider.model, "llama-3.3-70b-versatile");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /ignored/);
  });
});

describe("buildTranslationProvider — fallback is off unless asked for", () => {
  it("reports no fallback by default", async () => {
    const result = await buildTranslationProvider({
      resolveLlm: llm,
      env: { ...WORKER_ENV, TRANSLATION_PROVIDER: "madlad" },
    });
    assert.ok(result.ok);
    assert.equal(result.config.fallbackToOllamaOnTransportError, false);
  });

  it("reports the fallback when it is explicitly enabled", async () => {
    const result = await buildTranslationProvider({
      resolveLlm: llm,
      env: {
        ...WORKER_ENV,
        TRANSLATION_PROVIDER: "madlad",
        TRANSLATION_MADLAD_FALLBACK: "ollama",
      },
    });
    assert.ok(result.ok);
    assert.equal(result.config.fallbackToOllamaOnTransportError, true);
  });
});
