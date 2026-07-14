import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateWithRetry,
  MAX_GENERATION_ATTEMPTS,
  type SemanticGate,
  type SemanticGateResult,
} from "./generate-with-retry";
import type { ILlmProvider, LlmRequest, LlmResponse } from "./types";
import type { RecentPost } from "./quality/duplicate-detection";

// ─── Fixtures ─────────────────────────────────────────────────────────────────
//
// Jaccard similarity between word sets:
//   "a b c d e" vs "a b c d"  → intersection=4, union=5 → 0.80  (≥ 0.75, flagged)
//   "x y z w q" vs "a b c d"  → intersection=0, union=9 → 0.00  (<  0.75, clean)

function jsonPost(text: string): string {
  return JSON.stringify({
    text,
    hashtags: [],
    coreMessage: "A single central claim for this post.",
  });
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

// Provider that also records the userPrompts it was given, for retry-prompt assertions.
function recordingProvider(
  responses: string[]
): ILlmProvider & { callCount: number; prompts: string[] } {
  let i = 0;
  const provider = {
    callCount: 0,
    prompts: [] as string[],
    async generate(req: LlmRequest): Promise<LlmResponse> {
      provider.callCount++;
      provider.prompts.push(req.userPrompt);
      return { text: responses[Math.min(i++, responses.length - 1)] };
    },
  };
  return provider;
}

const ACCEPT: SemanticGateResult = {
  decision: "accept",
  topSimilarity: 0.1,
  matchedPostId: null,
  matchedCoreMessage: null,
  skipped: false,
};

const REGENERATE: SemanticGateResult = {
  decision: "regenerate",
  topSimilarity: 0.92,
  matchedPostId: "sem-1",
  matchedCoreMessage: "The repeated central claim.",
  skipped: false,
};

// A gate that yields the given results in order, repeating the last one.
function gateSequence(results: SemanticGateResult[]): SemanticGate {
  let i = 0;
  return async () => results[Math.min(i++, results.length - 1)];
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

// ─── Semantic gate (Phase 1.4) ─────────────────────────────────────────────────

describe("generateWithRetry — semantic gate accept", () => {
  it("accepts on the first attempt when the gate is below threshold", async () => {
    const provider = makeProvider([jsonPost(CLEAN_TEXT)]);
    const result = await generateWithRetry(
      provider,
      "sys",
      "user",
      [],
      undefined,
      gateSequence([ACCEPT])
    );

    assert.strictEqual(provider.callCount, 1);
    assert.strictEqual(result.semanticResult.decision, "accept");
    assert.strictEqual(result.attempts, 1);
  });
});

describe("generateWithRetry — semantic duplicate then successful retry", () => {
  it("retries a Jaccard-clean but semantically-duplicate candidate and injects the repeated claim", async () => {
    // Both attempts are Jaccard-clean; only the semantic gate forces the retry.
    const provider = recordingProvider([jsonPost(CLEAN_TEXT), jsonPost(CLEAN_TEXT)]);
    const result = await generateWithRetry(
      provider,
      "sys",
      "user",
      [],
      undefined,
      gateSequence([REGENERATE, ACCEPT])
    );

    assert.strictEqual(provider.callCount, 2, "should retry exactly once");
    assert.strictEqual(result.semanticResult.decision, "accept");
    assert.strictEqual(result.attempts, 2);

    // The retry prompt must tell the model which central claim was repeated.
    const retryPrompt = provider.prompts[1];
    assert.match(retryPrompt, /Semantic duplicate/);
    assert.match(retryPrompt, /The repeated central claim\./);
  });
});

describe("generateWithRetry — semantic duplicate on all attempts", () => {
  it("exhausts the attempts and returns the final regenerate decision", async () => {
    const provider = makeProvider([jsonPost(CLEAN_TEXT)]);
    const result = await generateWithRetry(
      provider,
      "sys",
      "user",
      [],
      undefined,
      gateSequence([REGENERATE])
    );

    assert.strictEqual(provider.callCount, MAX_GENERATION_ATTEMPTS);
    assert.strictEqual(result.semanticResult.decision, "regenerate");
    assert.strictEqual(result.attempts, MAX_GENERATION_ATTEMPTS);
  });
});

describe("generateWithRetry — gray zone accepts without retrying", () => {
  it("does not retry when the gate returns gray_zone", async () => {
    const provider = makeProvider([jsonPost(CLEAN_TEXT)]);
    const grayZone: SemanticGateResult = {
      decision: "gray_zone",
      topSimilarity: 0.83,
      matchedPostId: "sem-2",
      matchedCoreMessage: "A somewhat similar claim.",
      skipped: false,
    };
    const result = await generateWithRetry(
      provider,
      "sys",
      "user",
      [],
      undefined,
      gateSequence([grayZone])
    );

    assert.strictEqual(provider.callCount, 1, "gray zone is accepted, not regenerated");
    assert.strictEqual(result.semanticResult.decision, "gray_zone");
  });
});
