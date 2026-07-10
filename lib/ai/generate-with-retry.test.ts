import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateWithRetry, MAX_GENERATION_ATTEMPTS } from "./generate-with-retry";
import type { ILlmProvider, LlmRequest, LlmResponse } from "./types";
import type { RecentPost } from "./quality/duplicate-detection";

// ─── Fixtures ─────────────────────────────────────────────────────────────────
//
// Jaccard similarity between word sets:
//   "a b c d e" vs "a b c d"  → intersection=4, union=5 → 0.80  (≥ 0.75, flagged)
//   "x y z w q" vs "a b c d"  → intersection=0, union=9 → 0.00  (<  0.75, clean)

function jsonPost(text: string): string {
  return JSON.stringify({ text, hashtags: [] });
}

const DUPLICATE_TEXT = "a b c d e";
const CLEAN_TEXT = "x y z w q";

const recentPost: RecentPost = { id: "p1", text: "a b c d" };

function makeProvider(responses: string[]): ILlmProvider & { callCount: number } {
  let i = 0;
  const provider = {
    callCount: 0,
    async generate(_req: LlmRequest): Promise<LlmResponse> {
      provider.callCount++;
      // Repeat the last response if the sequence is exhausted
      const text = responses[Math.min(i++, responses.length - 1)];
      return { text };
    },
  };
  return provider;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("generateWithRetry — attempt count constant", () => {
  it("MAX_GENERATION_ATTEMPTS is 3", () => {
    assert.strictEqual(MAX_GENERATION_ATTEMPTS, 3);
  });
});

describe("generateWithRetry — success on first attempt", () => {
  it("returns the result immediately without retrying", async () => {
    const provider = makeProvider([jsonPost(CLEAN_TEXT)]);
    const result = await generateWithRetry(provider, "sys", "user", [recentPost]);

    assert.strictEqual(provider.callCount, 1, "should call provider exactly once");
    assert.strictEqual(result.parsed.text, CLEAN_TEXT);
    assert.strictEqual(result.duplicateResult.flagged, false);
  });
});

describe("generateWithRetry — duplicate then successful retry", () => {
  it("retries once and saves the clean second attempt", async () => {
    const provider = makeProvider([jsonPost(DUPLICATE_TEXT), jsonPost(CLEAN_TEXT)]);
    const result = await generateWithRetry(provider, "sys", "user", [recentPost]);

    assert.strictEqual(provider.callCount, 2, "should call provider exactly twice");
    assert.strictEqual(result.parsed.text, CLEAN_TEXT, "should return the clean attempt");
    assert.strictEqual(result.duplicateResult.flagged, false);
  });
});

describe("generateWithRetry — duplicate on all attempts", () => {
  it("stops after 3 attempts and returns the last flagged result", async () => {
    const provider = makeProvider([jsonPost(DUPLICATE_TEXT)]);
    const result = await generateWithRetry(provider, "sys", "user", [recentPost]);

    assert.strictEqual(provider.callCount, 3, "should make exactly 3 provider calls");
    assert.strictEqual(result.duplicateResult.flagged, true, "result should still be flagged");
    assert.strictEqual(result.parsed.text, DUPLICATE_TEXT);
    assert.ok(
      (result.duplicateResult.similarityScore ?? 0) >= 0.75,
      "similarity score should be at or above the threshold"
    );
  });
});

describe("generateWithRetry — no recent posts", () => {
  it("never flags a duplicate when recentPosts is empty", async () => {
    const provider = makeProvider([jsonPost(DUPLICATE_TEXT)]);
    const result = await generateWithRetry(provider, "sys", "user", []);

    assert.strictEqual(provider.callCount, 1, "should not retry when there is nothing to compare");
    assert.strictEqual(result.duplicateResult.flagged, false);
  });
});
