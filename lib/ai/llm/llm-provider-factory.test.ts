import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LLM_PROVIDER_LABEL } from "./llm-provider-factory";

describe("LLM_PROVIDER_LABEL", () => {
  it("has a distinct uppercase label for every provider", () => {
    assert.equal(LLM_PROVIDER_LABEL.claude, "CLAUDE");
    assert.equal(LLM_PROVIDER_LABEL.openai, "OPENAI");
    assert.equal(LLM_PROVIDER_LABEL.grok, "GROQ");
    assert.equal(LLM_PROVIDER_LABEL.text_worker, "TEXT_WORKER");
  });
});
