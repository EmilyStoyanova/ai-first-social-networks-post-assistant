import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateWithRetry,
  MAX_GENERATION_ATTEMPTS,
  type SemanticGate,
  type SemanticGateResult,
} from "./generate-with-retry";
import type { DiversityOptions } from "./generate-with-retry";
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

function jsonPostWithCore(text: string, coreMessage: string): string {
  return JSON.stringify({ text, hashtags: [], coreMessage });
}

function jsonPostWithTopic(text: string, topic: string): string {
  return JSON.stringify({
    text,
    hashtags: [],
    coreMessage: "A single central claim for this post.",
    topic,
  });
}

// Full DiversityOptions carrying the normalized topic memory. Angle/pattern are
// valid so retry selection has something to rotate through.
function makeDiversity(topicMemory: string[]): DiversityOptions {
  return {
    initialAngle: "Educational",
    recentAngles: [],
    initialPattern: { hookType: "Question", structure: "List", ctaType: "Share" },
    recentPatterns: [],
    recentTopics: topicMemory,
  };
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

// ─── Generic coreMessage gate (Phase 1.5) ─────────────────────────────────────

describe("generateWithRetry — generic coreMessage triggers a retry", () => {
  it("retries a generic-praise coreMessage and accepts a concrete one", async () => {
    const provider = recordingProvider([
      jsonPostWithCore(CLEAN_TEXT, "Corfu is ideal for family holidays."),
      jsonPostWithCore(
        CLEAN_TEXT,
        "Corfu's shallow north-east bays let toddlers wade safely near the shore."
      ),
    ]);
    const result = await generateWithRetry(provider, "sys", "user", []);

    assert.strictEqual(provider.callCount, 2, "should retry once on the generic claim");
    assert.strictEqual(result.coreMessageGeneric, false, "final claim should be concrete");
    assert.strictEqual(result.attempts, 2);

    // The retry prompt must explain the previous claim was too generic.
    const retryPrompt = provider.prompts[1];
    assert.match(retryPrompt, /too generic/);
    assert.match(retryPrompt, /Corfu is ideal for family holidays\./);
  });

  it("exhausts attempts and returns coreMessageGeneric=true when it never improves", async () => {
    const provider = makeProvider([
      jsonPostWithCore(CLEAN_TEXT, "This resort is the perfect choice for everyone."),
    ]);
    const result = await generateWithRetry(provider, "sys", "user", []);

    assert.strictEqual(provider.callCount, MAX_GENERATION_ATTEMPTS);
    assert.strictEqual(result.coreMessageGeneric, true);
  });
});

// ─── Topic Memory ──────────────────────────────────────────────────────────────
// All scenarios use mocked provider responses (jsonPostWithTopic / makeProvider /
// recordingProvider) — the real TEXT_WORKER is never contacted.

describe("Topic Memory — 1. same topic, different formatting normalizes and triggers retry", () => {
  // Every formatting variant must collapse to the same key as the memory entry
  // "authentic lisbon" and therefore be rejected as a repeat.
  for (const variant of ["Authentic Lisbon", "authentic-lisbon!", "  AUTHENTIC   LISBON  "]) {
    it(`treats ${JSON.stringify(variant)} as a repeat of "authentic lisbon"`, async () => {
      // Provider keeps returning the same variant, so the retry loop runs to
      // exhaustion — proving the normalized match forced a retry every time.
      const provider = makeProvider([jsonPostWithTopic(CLEAN_TEXT, variant)]);
      const result = await generateWithRetry(
        provider,
        "sys",
        "user",
        [],
        makeDiversity(["authentic lisbon"])
      );

      assert.strictEqual(
        provider.callCount,
        MAX_GENERATION_ATTEMPTS,
        "the normalized-topic collision must trigger retries"
      );
      assert.strictEqual(result.topicRepeated, true);
    });
  }
});

describe("Topic Memory — 2. same destination, different topic is accepted", () => {
  it('accepts "Barcelona city and beach" when memory holds "Local Barcelona culture"', async () => {
    const provider = makeProvider([jsonPostWithTopic(CLEAN_TEXT, "Barcelona city and beach")]);
    const result = await generateWithRetry(
      provider,
      "sys",
      "user",
      [],
      makeDiversity(["local barcelona culture"])
    );

    assert.strictEqual(provider.callCount, 1, "a genuinely different topic needs no retry");
    assert.strictEqual(result.topicRepeated, false);
    assert.strictEqual(result.attempts, 1);
  });
});

describe("Topic Memory — 3. repeated then fresh topic retries once and accepts", () => {
  it("returns attempts=2 and topicRepeated=false", async () => {
    // Attempt 1 repeats the memory; attempt 2 is a fresh topic that is accepted.
    const provider = recordingProvider([
      jsonPostWithTopic(CLEAN_TEXT, "Authentic Lisbon"),
      jsonPostWithTopic(CLEAN_TEXT, "Lisbon street food"),
    ]);
    const result = await generateWithRetry(
      provider,
      "sys",
      "user",
      [],
      makeDiversity(["authentic lisbon"])
    );

    assert.strictEqual(provider.callCount, 2, "should retry exactly once");
    assert.strictEqual(result.attempts, 2);
    assert.strictEqual(result.topicRepeated, false);

    // The retry prompt must name the reused topic so the model moves off it.
    const retryPrompt = provider.prompts[1];
    assert.match(retryPrompt, /recently-covered topic/);
    assert.match(retryPrompt, /Authentic Lisbon/);
  });
});

describe("Topic Memory — 4. repeated on all attempts exhausts and returns the last candidate", () => {
  it("returns attempts=3 and topicRepeated=true with the last (still-repeated) candidate", async () => {
    const provider = makeProvider([jsonPostWithTopic(DUPLICATE_TEXT, "Authentic Lisbon")]);
    const result = await generateWithRetry(
      provider,
      "sys",
      "user",
      [],
      makeDiversity(["authentic lisbon"])
    );

    assert.strictEqual(provider.callCount, MAX_GENERATION_ATTEMPTS);
    assert.strictEqual(result.attempts, MAX_GENERATION_ATTEMPTS);
    assert.strictEqual(result.attempts, 3);
    assert.strictEqual(result.topicRepeated, true);
    // Fail-safe: the last candidate is still returned even though it stayed repeated.
    assert.strictEqual(result.parsed.text, DUPLICATE_TEXT);
    assert.strictEqual(result.parsed.topic, "Authentic Lisbon");
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
