import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TOPIC_MEMORY_SIZE,
  normalizeTopic,
  buildTopicMemory,
  isTopicRepeated,
} from "./topic-memory";

// ─── normalizeTopic ───────────────────────────────────────────────────────────

describe("normalizeTopic", () => {
  it("lowercases, trims, collapses spaces, and removes punctuation", () => {
    assert.equal(normalizeTopic("  Authentic   Lisbon!  "), "authentic lisbon");
    assert.equal(normalizeTopic("Hiring for Culture-Fit"), "hiring for culture fit");
    assert.equal(normalizeTopic("Startup cash-flow, explained."), "startup cash flow explained");
  });

  it("treats punctuation-only differences as the same key", () => {
    assert.equal(normalizeTopic("Authentic Lisbon"), normalizeTopic("authentic, lisbon!"));
    assert.equal(normalizeTopic("ROI / Business Impact"), normalizeTopic("roi business impact"));
  });

  it("preserves Cyrillic letters and digits", () => {
    assert.equal(normalizeTopic("Автентичен Лисабон"), "автентичен лисабон");
    assert.equal(normalizeTopic("Top 5 Beaches"), "top 5 beaches");
  });

  it("returns an empty string for blank or absent input", () => {
    assert.equal(normalizeTopic(null), "");
    assert.equal(normalizeTopic(undefined), "");
    assert.equal(normalizeTopic("   "), "");
    assert.equal(normalizeTopic("!!! ---"), "");
  });
});

// ─── buildTopicMemory ─────────────────────────────────────────────────────────

describe("buildTopicMemory", () => {
  it("normalizes, de-duplicates, and preserves most-recent-first order", () => {
    const memory = buildTopicMemory([
      "Authentic Lisbon",
      "authentic  lisbon!", // duplicate after normalization
      "Barcelona Nightlife",
      null,
      "  ", // blank → dropped
      "Barcelona nightlife.", // duplicate after normalization
    ]);
    assert.deepEqual(memory, ["authentic lisbon", "barcelona nightlife"]);
  });

  it("returns an empty list when there are no usable topics", () => {
    assert.deepEqual(buildTopicMemory([null, undefined, "   ", "!!!"]), []);
  });

  it("exposes a 30-post window size", () => {
    assert.equal(TOPIC_MEMORY_SIZE, 30);
  });
});

// ─── isTopicRepeated ──────────────────────────────────────────────────────────

describe("isTopicRepeated", () => {
  const memory = buildTopicMemory(["Authentic Lisbon", "Barcelona Nightlife"]);

  it("matches a candidate that differs only by case/punctuation/spacing", () => {
    assert.equal(isTopicRepeated("authentic, lisbon!", memory), true);
    assert.equal(isTopicRepeated("  Authentic Lisbon  ", memory), true);
  });

  it("does not match a genuinely new topic", () => {
    assert.equal(isTopicRepeated("Lisbon Street Food", memory), false);
  });

  it("never treats a blank or absent candidate as a repeat", () => {
    assert.equal(isTopicRepeated(null, memory), false);
    assert.equal(isTopicRepeated(undefined, memory), false);
    assert.equal(isTopicRepeated("   ", memory), false);
  });

  it("returns false against an empty memory", () => {
    assert.equal(isTopicRepeated("Authentic Lisbon", []), false);
  });
});
