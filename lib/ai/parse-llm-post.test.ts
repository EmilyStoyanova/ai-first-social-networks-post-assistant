import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLlmPost } from "./parse-llm-post";
import { LlmResponseParseError } from "./errors";

const CORE = "Automating repetitive marketing work frees small businesses to focus on growth.";

function raw(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    text: "A short engaging post.",
    hashtags: ["growth"],
    coreMessage: CORE,
    ...overrides,
  });
}

describe("parseLlmPost — coreMessage", () => {
  it("parses coreMessage from a valid response", () => {
    const parsed = parseLlmPost(raw());
    assert.strictEqual(parsed.coreMessage, CORE);
  });

  it("trims surrounding whitespace on coreMessage", () => {
    const parsed = parseLlmPost(raw({ coreMessage: `  ${CORE}  ` }));
    assert.strictEqual(parsed.coreMessage, CORE);
  });

  it("throws when coreMessage is missing", () => {
    const withoutCore = JSON.stringify({ text: "A post.", hashtags: [] });
    assert.throws(() => parseLlmPost(withoutCore), LlmResponseParseError);
  });

  it("throws when coreMessage is an empty string", () => {
    assert.throws(() => parseLlmPost(raw({ coreMessage: "" })), LlmResponseParseError);
  });

  it("throws when coreMessage is only whitespace", () => {
    assert.throws(() => parseLlmPost(raw({ coreMessage: "   " })), LlmResponseParseError);
  });

  it("throws when coreMessage is not a string", () => {
    assert.throws(() => parseLlmPost(raw({ coreMessage: 42 })), LlmResponseParseError);
  });

  it("still parses the other fields alongside coreMessage", () => {
    const parsed = parseLlmPost(
      raw({ imagePrompt: "a bright office", topic: "marketing automation" })
    );
    assert.strictEqual(parsed.text, "A short engaging post.");
    assert.deepStrictEqual(parsed.hashtags, ["growth"]);
    assert.strictEqual(parsed.imagePrompt, "a bright office");
    assert.strictEqual(parsed.topic, "marketing automation");
  });

  it("parses coreMessage from a fenced JSON response", () => {
    const fenced = "```json\n" + raw() + "\n```";
    const parsed = parseLlmPost(fenced);
    assert.strictEqual(parsed.coreMessage, CORE);
  });
});
