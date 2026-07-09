import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPrompts } from "./prompt-builder";
import type { GenerationContext } from "./types";

function makeCtx(overrides: {
  imageRequired?: boolean;
  postingLanguage?: string;
}): GenerationContext {
  return {
    company: {
      name: "Acme",
      website: null,
      automationMode: "semi_automated",
      defaultLang: "en",
    },
    brand: null,
    channel: {
      channel: "instagram",
      postingLanguage: overrides.postingLanguage ?? "en",
      imageRequired: overrides.imageRequired ?? false,
      automationModeOverride: null,
    },
    feedItems: [],
    llm: { provider: "groq", model: "llama-3.3-70b-versatile" },
  };
}

describe("prompt-builder — Bulgarian content language", () => {
  it("instructs the LLM to write post text in Bulgarian", () => {
    const { systemPrompt } = buildPrompts(makeCtx({}), "bg");
    assert.ok(systemPrompt.includes("Bulgarian"), "system prompt should mention Bulgarian");
    assert.ok(
      systemPrompt.includes("text") && systemPrompt.includes("BG"),
      "writing rule should scope BG to the text field"
    );
  });

  it("instructs imagePrompt to always be in English even when contentLanguage=bg", () => {
    const { systemPrompt, userPrompt } = buildPrompts(makeCtx({}), "bg");
    const combined = systemPrompt + "\n" + userPrompt;
    assert.ok(
      combined.toLowerCase().includes("english"),
      "prompts must explicitly require imagePrompt to be in English"
    );
    assert.ok(
      combined.includes("imagePrompt") && combined.toLowerCase().includes("english"),
      "imagePrompt English rule must be present"
    );
  });

  it("imagePrompt English rule is present even when contentLanguage=en", () => {
    const { systemPrompt, userPrompt } = buildPrompts(makeCtx({}), "en");
    const combined = systemPrompt + "\n" + userPrompt;
    assert.ok(
      combined.toLowerCase().includes("english"),
      "imagePrompt English rule should always appear"
    );
  });
});

describe("prompt-builder — imageRequired", () => {
  it("marks imagePrompt as REQUIRED in the JSON format when imageRequired=true", () => {
    const { userPrompt } = buildPrompts(makeCtx({ imageRequired: true }));
    // Extract the imagePrompt line from the JSON format block
    const imagePromptLine = userPrompt.split("\n").find((l) => l.includes('"imagePrompt"'));
    assert.ok(imagePromptLine, "JSON format block must include an imagePrompt line");
    assert.ok(
      imagePromptLine.includes("REQUIRED"),
      "imagePrompt line should say REQUIRED when imageRequired=true"
    );
    assert.ok(
      !imagePromptLine.toLowerCase().includes("optional"),
      "imagePrompt line must not say optional when imageRequired=true"
    );
  });

  it("marks imagePrompt as optional in the JSON format when imageRequired=false", () => {
    const { userPrompt } = buildPrompts(makeCtx({ imageRequired: false }));
    const imagePromptLine = userPrompt.split("\n").find((l) => l.includes('"imagePrompt"'));
    assert.ok(imagePromptLine, "JSON format block must include an imagePrompt line");
    assert.ok(
      imagePromptLine.toLowerCase().includes("optional"),
      "imagePrompt line should say optional when imageRequired=false"
    );
    assert.ok(
      !imagePromptLine.includes("REQUIRED"),
      "imagePrompt line must not say REQUIRED when imageRequired=false"
    );
  });
});
