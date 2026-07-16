import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { LlmProvider } from "@prisma/client";
import { resolveLlmSelection, type ResolveLlmSelectionDeps } from "./resolve-llm-selection.service";

const savedKey = process.env.GROQ_API_KEY;

beforeEach(() => {
  process.env.GROQ_API_KEY = "k";
});

afterEach(() => {
  if (savedKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = savedKey;
});

function makeDeps(
  active: Record<string, LlmProvider>,
  adminDefault: { id: string; provider: LlmProvider } | null
): ResolveLlmSelectionDeps {
  return {
    loadLlmConfig: async (id) => (active[id] ? { provider: active[id] } : null),
    loadDefaultLlmConfig: async () => adminDefault,
  };
}

describe("resolveLlmSelection — precedence", () => {
  it("an explicit llmConfigId wins over preference and admin default", async () => {
    const deps = makeDeps({ explicit: "grok", pref: "openai" }, { id: "def", provider: "claude" });

    const result = await resolveLlmSelection(
      { llmConfigId: "explicit", preferredLlmConfigId: "pref" },
      deps
    );

    assert.ok(result.success);
    assert.equal(result.selection.provider, "grok");
    assert.equal(result.selection.llmConfigId, "explicit");
  });

  it("falls back to the user preference when no explicit id is given", async () => {
    const deps = makeDeps({ pref: "openai" }, { id: "def", provider: "claude" });

    const result = await resolveLlmSelection({ preferredLlmConfigId: "pref" }, deps);

    assert.ok(result.success);
    assert.equal(result.selection.provider, "openai");
    assert.equal(result.selection.llmConfigId, "pref");
  });

  it("falls back to the admin default when the preference is no longer active", async () => {
    const deps = makeDeps({}, { id: "def", provider: "claude" });

    const result = await resolveLlmSelection({ preferredLlmConfigId: "gone" }, deps);

    assert.ok(result.success);
    assert.equal(result.selection.provider, "claude");
    assert.equal(result.selection.llmConfigId, "def");
  });

  it("uses the admin default when neither id is supplied (the cron path)", async () => {
    const deps = makeDeps({}, { id: "def", provider: "grok" });

    const result = await resolveLlmSelection({}, deps);

    assert.ok(result.success);
    assert.equal(result.selection.llmConfigId, "def");
  });
});

describe("resolveLlmSelection — errors", () => {
  it("hard-errors on an inactive explicit id rather than silently swapping", async () => {
    const deps = makeDeps({}, { id: "def", provider: "claude" });

    const result = await resolveLlmSelection({ llmConfigId: "gone" }, deps);

    assert.ok(!result.success);
    assert.equal(result.code, "LLM_CONFIG_NOT_FOUND");
  });

  it("returns NO_ACTIVE_PROVIDER when nothing resolves — never an env fallback", async () => {
    const deps = makeDeps({}, null);

    const result = await resolveLlmSelection({}, deps);

    assert.ok(!result.success);
    assert.equal(result.code, "NO_ACTIVE_PROVIDER");
  });
});

describe("resolveLlmSelection — provenance", () => {
  it("labels the grok enum value as GROQ and resolves the Groq model", async () => {
    const deps = makeDeps({}, { id: "def", provider: "grok" });

    const result = await resolveLlmSelection({}, deps);

    assert.ok(result.success);
    assert.equal(result.selection.providerLabel, "GROQ");
    assert.equal(result.selection.model, "llama-3.3-70b-versatile");
  });
});
