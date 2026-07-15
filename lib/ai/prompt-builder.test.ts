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
      maxTextLength: null,
      includeSourceLink: false,
    },
    feedItems: [],
    hasArticleSources: false,
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

describe("prompt-builder — Bulgarian language quality section", () => {
  it("includes the Bulgarian quality section when contentLanguage=bg", () => {
    const { systemPrompt } = buildPrompts(makeCtx({}), "bg");
    assert.ok(
      systemPrompt.includes("Bulgarian Language Quality"),
      "BG system prompt must include the quality section heading"
    );
    assert.ok(
      systemPrompt.includes("professional Bulgarian copywriter"),
      "BG system prompt must instruct writing as a professional Bulgarian copywriter"
    );
    assert.ok(
      systemPrompt.includes("Do NOT translate from English"),
      "BG system prompt must explicitly forbid translating from English"
    );
  });

  it("includes the Bulgarian quality section when channel postingLanguage=bg (no contentLanguage override)", () => {
    const { systemPrompt } = buildPrompts(makeCtx({ postingLanguage: "bg" }));
    assert.ok(
      systemPrompt.includes("Bulgarian Language Quality"),
      "BG channel language must also trigger the quality section"
    );
  });

  it("omits the Bulgarian quality section for English generation", () => {
    const { systemPrompt } = buildPrompts(makeCtx({}), "en");
    assert.ok(
      !systemPrompt.includes("Bulgarian Language Quality"),
      "EN system prompt must NOT include the BG quality section"
    );
    assert.ok(
      !systemPrompt.includes("professional Bulgarian copywriter"),
      "EN system prompt must NOT mention Bulgarian copywriting rules"
    );
  });

  it("omits the Bulgarian quality section when no contentLanguage override and channel is EN", () => {
    const { systemPrompt } = buildPrompts(makeCtx({ postingLanguage: "en" }));
    assert.ok(
      !systemPrompt.includes("Bulgarian Language Quality"),
      "default EN channel must NOT include BG quality section"
    );
  });

  it("BG prompt retains the basic language directive in Writing Rules", () => {
    const { systemPrompt } = buildPrompts(makeCtx({}), "bg");
    assert.ok(
      systemPrompt.includes("Generate the post in Bulgarian."),
      "Writing Rules must still include the basic BG language directive"
    );
  });

  it("EN prompt Writing Rules language directive is unchanged", () => {
    const { systemPrompt } = buildPrompts(makeCtx({}), "en");
    assert.ok(
      systemPrompt.includes("Generate the post in English."),
      "EN Writing Rules language directive must remain unchanged"
    );
    assert.ok(
      !systemPrompt.includes("Generate the post in Bulgarian"),
      "EN system prompt must not mention Bulgarian directive"
    );
  });

  it("BG quality section does not appear in the user prompt", () => {
    const { userPrompt } = buildPrompts(makeCtx({}), "bg");
    assert.ok(
      !userPrompt.includes("Bulgarian Language Quality"),
      "BG quality section must only appear in the system prompt, not the user prompt"
    );
  });
});

describe("prompt-builder — coreMessage", () => {
  it("defines coreMessage in the system prompt with its constraints", () => {
    const { systemPrompt } = buildPrompts(makeCtx({}), "en");
    assert.ok(
      systemPrompt.includes("Core Message"),
      "system prompt must include the Core Message section"
    );
    assert.ok(
      systemPrompt.includes("exactly one sentence"),
      "coreMessage must be defined as exactly one sentence"
    );
    assert.ok(
      systemPrompt.includes("independent of the hook") || systemPrompt.includes("stand on its own"),
      "coreMessage must be defined as independent of the hook / CTA"
    );
    assert.ok(
      systemPrompt.includes("NOT a summary") && systemPrompt.includes("NOT the topic"),
      "coreMessage must be defined as neither a summary nor the topic"
    );
  });

  it("includes coreMessage in the JSON format block of the user prompt", () => {
    const { userPrompt } = buildPrompts(makeCtx({}), "en");
    const coreLine = userPrompt.split("\n").find((l) => l.includes('"coreMessage"'));
    assert.ok(coreLine, "JSON format block must include a coreMessage line");
    assert.ok(
      coreLine.toLowerCase().includes("one sentence"),
      "coreMessage JSON line should describe it as one sentence"
    );
  });

  it("instructs coreMessage to be written in the post language (BG)", () => {
    const { systemPrompt } = buildPrompts(makeCtx({}), "bg");
    // The Core Message section references the post language token (BG).
    const idx = systemPrompt.indexOf("Core Message");
    const section = systemPrompt.slice(idx);
    assert.ok(
      section.includes("BG"),
      "coreMessage rule must scope the language to BG for Bulgarian posts"
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
