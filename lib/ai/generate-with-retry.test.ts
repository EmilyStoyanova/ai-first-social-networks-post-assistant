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
// valid so retry selection has something to rotate through. Every pattern
// dimension is one the compliance gate never checks (Step 2) — angle
// "Educational", hook "Question", structure "Story Arc", CTA "No CTA" — so
// these fixtures exercise Topic Memory in isolation without also tripping the
// pattern-specific compliance checks on CLEAN_TEXT/DUPLICATE_TEXT's nonsense
// sentences. The banned-word check still runs (it always does) and passes,
// since neither fixture text contains the banned word.
function makeDiversity(topicMemory: string[]): DiversityOptions {
  return {
    initialAngle: "Educational",
    recentAngles: [],
    initialPattern: { hookType: "Question", structure: "Story Arc", ctaType: "No CTA" },
    recentPatterns: [],
    recentTopics: topicMemory,
  };
}

const DUPLICATE_TEXT = "a b c d e";
const CLEAN_TEXT = "x y z w q";

// Satisfies every deterministic compliance check at once (Myth vs Fact debunk,
// Tips & Tricks tip count, Contrast hook, List item count, and every checkable
// CTA including Reflection) — used where a test's retry rotates
// angle/hook/structure/CTA to an unpredictable value (LRU-driven, not under the
// test's control) and the response still needs to be accepted.
const UNIVERSALLY_COMPLIANT_TEXT = [
  "Most people assume Lisbon is best in summer, but the data shows autumn actually wins.",
  "1. Try the pastel de nata from a bakery, not a chain.",
  "2. Order the bifana sandwich from a stall near Praça da Figueira.",
  "3. Ride tram 28 before nine, while the queues are still short.",
  "Follow us, share this with a friend, visit our website, and comment your favorite spot below — which one would you try first?",
].join("\n");

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
    // Note: a topic-memory retry (unlike a compliance-only retry) still rotates
    // angle/hook/structure/CTA as it always has, so attempt 2's response must
    // satisfy the compliance gate under WHATEVER pattern that rotation lands on
    // — UNIVERSALLY_COMPLIANT_TEXT does, regardless of which one it is.
    const provider = recordingProvider([
      jsonPostWithTopic(CLEAN_TEXT, "Authentic Lisbon"),
      jsonPostWithTopic(UNIVERSALLY_COMPLIANT_TEXT, "Lisbon street food"),
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

// ─── Post-generation compliance gate ────────────────────────────────────────
// The gate enforces banned terms and nothing else. The angle/hook/structure/CTA
// a post was generated under are prompt guidance: the model is asked for them,
// but a post that misses one is still a good post and is saved as-is.
//
// These fixtures pin that. Every one of them is a pattern the OLD gate could
// measure, paired with text that misses it outright — the exact shape that used
// to burn all three attempts and then discard the post.

function styleDiversity(pattern: DiversityOptions["initialPattern"]): DiversityOptions {
  return {
    initialAngle: "Tips & Tricks",
    recentAngles: [],
    initialPattern: pattern,
    recentPatterns: [],
    recentTopics: [],
  };
}

// CLEAN_TEXT ("x y z w q") has no sentence punctuation, no list, no contrast,
// no misconception and no CTA language of any kind — it misses every stylistic
// requirement there is.
const NO_STYLE_TEXT = CLEAN_TEXT;

describe("generateWithRetry — a missed stylistic requirement never triggers a retry", () => {
  // One case per dimension the old gate used to enforce. In every one the
  // provider is given exactly ONE response: if the loop retried, it would run
  // out of responses, so `callCount === 1` is a real assertion, not a formality.

  it("accepts a post with no share invitation under a Share CTA", async () => {
    const provider = makeProvider([jsonPost(NO_STYLE_TEXT)]);
    const result = await generateWithRetry(
      provider,
      "sys",
      "user",
      [],
      styleDiversity({ hookType: "Question", structure: "Story Arc", ctaType: "Share" })
    );

    assert.strictEqual(provider.callCount, 1, "a missing Share CTA must not cause a retry");
    assert.strictEqual(result.attempts, 1);
    assert.strictEqual(result.complianceResult.status, "passed");
    assert.strictEqual(result.parsed.text, NO_STYLE_TEXT);
  });

  it("accepts a post with no follow invitation under a Follow CTA", async () => {
    const provider = makeProvider([jsonPost(NO_STYLE_TEXT)]);
    const result = await generateWithRetry(
      provider,
      "sys",
      "user",
      [],
      styleDiversity({ hookType: "Question", structure: "Story Arc", ctaType: "Follow" })
    );

    assert.strictEqual(provider.callCount, 1);
    assert.strictEqual(result.complianceResult.status, "passed");
  });

  it("accepts a post with no list items under a List structure", async () => {
    const provider = makeProvider([jsonPost(NO_STYLE_TEXT)]);
    const result = await generateWithRetry(
      provider,
      "sys",
      "user",
      [],
      styleDiversity({ hookType: "Question", structure: "List", ctaType: "No CTA" })
    );

    assert.strictEqual(provider.callCount, 1, "a missing List structure must not cause a retry");
    assert.strictEqual(result.complianceResult.status, "passed");
  });

  it("accepts a post with no contrast opening under a Contrast hook", async () => {
    const provider = makeProvider([jsonPost(NO_STYLE_TEXT)]);
    const result = await generateWithRetry(
      provider,
      "sys",
      "user",
      [],
      styleDiversity({ hookType: "Contrast", structure: "Story Arc", ctaType: "No CTA" })
    );

    assert.strictEqual(provider.callCount, 1, "a missing Contrast hook must not cause a retry");
    assert.strictEqual(result.complianceResult.status, "passed");
  });

  it("accepts a post that debunks nothing under a Myth vs Fact angle", async () => {
    const provider = makeProvider([jsonPost(NO_STYLE_TEXT)]);
    const result = await generateWithRetry(provider, "sys", "user", [], {
      initialAngle: "Myth vs Fact",
      recentAngles: [],
      initialPattern: { hookType: "Question", structure: "Story Arc", ctaType: "No CTA" },
      recentPatterns: [],
      recentTopics: [],
    });

    assert.strictEqual(provider.callCount, 1, "a missing Myth vs Fact opening must not retry");
    assert.strictEqual(result.complianceResult.status, "passed");
  });

  it("accepts a post with zero tips under a Tips & Tricks angle", async () => {
    const provider = makeProvider([jsonPost(NO_STYLE_TEXT)]);
    const result = await generateWithRetry(
      provider,
      "sys",
      "user",
      [],
      styleDiversity({ hookType: "Question", structure: "Story Arc", ctaType: "No CTA" })
    );

    assert.strictEqual(provider.callCount, 1);
    assert.strictEqual(result.complianceResult.status, "passed");
  });

  it("accepts a post missing EVERY stylistic requirement at once", async () => {
    // Myth vs Fact + Contrast + List + Share against text that has none of
    // them: four simultaneous misses, still one call and a saved post.
    const provider = makeProvider([jsonPost(NO_STYLE_TEXT)]);
    const result = await generateWithRetry(provider, "sys", "user", [], {
      initialAngle: "Myth vs Fact",
      recentAngles: [],
      initialPattern: { hookType: "Contrast", structure: "List", ctaType: "Share" },
      recentPatterns: [],
      recentTopics: [],
    });

    assert.strictEqual(provider.callCount, 1, "four stylistic misses must still not retry");
    assert.strictEqual(result.attempts, 1);
    assert.strictEqual(result.complianceResult.status, "passed");
    assert.strictEqual(result.complianceResult.passed, true);
    assert.deepEqual(result.complianceResult.reasons, []);
    assert.deepEqual(result.complianceResult.failures, []);
    assert.strictEqual(result.parsed.text, NO_STYLE_TEXT);
  });

  it("reports the stylistic dimensions as unchecked rather than as verified passes", async () => {
    const provider = makeProvider([jsonPost(NO_STYLE_TEXT)]);
    const result = await generateWithRetry(
      provider,
      "sys",
      "user",
      [],
      styleDiversity({ hookType: "Contrast", structure: "List", ctaType: "Share" })
    );

    assert.deepEqual(result.complianceResult.checked, {
      angle: false,
      hook: false,
      cta: false,
      structure: false,
      bannedWords: true,
    });
    assert.strictEqual(result.complianceResult.evaluated, true);
  });
});

// ─── The banned word is still a real gate ───────────────────────────────────
// Everything stylistic stopped blocking; this did not. A banned term is a hard
// product prohibition, so it still retries and still refuses to launder a
// failure into a pass when the attempts run out.

const BANNED_TEXT = "Стоп! Не изпускайте нашата есенна оферта.";

describe("generateWithRetry — the banned-word check runs even with no diversity options at all", () => {
  it("still evaluates compliance (via the banned-word check) with no angle/pattern", async () => {
    const provider = makeProvider([jsonPost(CLEAN_TEXT)]);
    const result = await generateWithRetry(provider, "sys", "user", []);

    assert.strictEqual(
      provider.callCount,
      1,
      "nothing banned, nothing else to check — accepted on the first try"
    );
    assert.strictEqual(result.complianceResult.status, "passed");
    assert.strictEqual(result.complianceResult.evaluated, true);
    assert.strictEqual(result.complianceResult.passed, true);
  });

  it("aborts-and-retries on the banned word even with no angle/pattern at all", async () => {
    const provider = makeProvider([jsonPost(BANNED_TEXT)]);
    const result = await generateWithRetry(provider, "sys", "user", []);

    assert.strictEqual(provider.callCount, MAX_GENERATION_ATTEMPTS);
    assert.strictEqual(result.complianceResult.status, "failed");
    assert.strictEqual(result.complianceResult.passed, false);
  });
});

describe("generateWithRetry — a banned word still triggers a retry", () => {
  it("retries a banned candidate and accepts the clean rewrite", async () => {
    const provider = makeProvider([jsonPost(BANNED_TEXT), jsonPost(CLEAN_TEXT)]);
    const result = await generateWithRetry(
      provider,
      "sys",
      "user",
      [],
      styleDiversity({ hookType: "Question", structure: "Story Arc", ctaType: "Share" })
    );

    assert.strictEqual(provider.callCount, 2, "should retry exactly once");
    assert.strictEqual(result.attempts, 2);
    assert.strictEqual(result.complianceResult.status, "passed");
    assert.strictEqual(result.parsed.text, CLEAN_TEXT);
  });

  it("names the violation and its remediation without rotating the pattern away", async () => {
    const provider = recordingProvider([jsonPost(BANNED_TEXT), jsonPost(CLEAN_TEXT)]);
    await generateWithRetry(
      provider,
      "sys",
      "user",
      [],
      styleDiversity({ hookType: "Question", structure: "Story Arc", ctaType: "Share" })
    );

    const retryPrompt = provider.prompts[1];
    assert.match(retryPrompt, /Стоп/);
    assert.match(retryPrompt, /Remove the banned word entirely/);
    // The pattern did not cause the violation, so the retry must not swap it.
    assert.doesNotMatch(retryPrompt, /FORCED CONTENT PATTERN/);
    assert.doesNotMatch(retryPrompt, /Do not reuse the same hook type/);
  });

  it("keeps the SAME angle/hook/structure/CTA across a banned-word retry", async () => {
    const provider = makeProvider([jsonPost(BANNED_TEXT), jsonPost(CLEAN_TEXT)]);
    const diversity = styleDiversity({
      hookType: "Question",
      structure: "Story Arc",
      ctaType: "Share",
    });
    const result = await generateWithRetry(provider, "sys", "user", [], diversity);

    assert.strictEqual(result.selectedAngle, diversity.initialAngle);
    assert.deepEqual(result.selectedPattern, diversity.initialPattern);
  });

  it("exhausts attempts and hands the failed verdict back rather than throwing", async () => {
    // The loop reports; it does not decide. `complianceResult.passed === false`
    // surviving to the return value is what lets the generation service refuse
    // to save the post (POST_FAILED_COMPLIANCE) — see
    // generate-draft-post.service.test.ts, "compliance abort". So the contract
    // asserted here is "never throws AND never launders the failure into a pass".
    const provider = makeProvider([jsonPost(BANNED_TEXT)]);
    const result = await generateWithRetry(
      provider,
      "sys",
      "user",
      [],
      styleDiversity({ hookType: "Question", structure: "Story Arc", ctaType: "Share" })
    );

    assert.strictEqual(provider.callCount, MAX_GENERATION_ATTEMPTS);
    assert.strictEqual(result.attempts, MAX_GENERATION_ATTEMPTS);
    assert.strictEqual(result.complianceResult.status, "failed");
    assert.strictEqual(result.complianceResult.passed, false);
    assert.ok(result.complianceResult.reasons.length > 0);
    assert.strictEqual(result.parsed.text, BANNED_TEXT);
  });

  it("attributes the failure to bannedWords and to nothing else", async () => {
    const provider = makeProvider([jsonPost(BANNED_TEXT)]);
    const result = await generateWithRetry(
      provider,
      "sys",
      "user",
      [],
      styleDiversity({ hookType: "Contrast", structure: "List", ctaType: "Share" })
    );

    assert.strictEqual(result.complianceResult.status, "failed");
    assert.deepEqual(
      result.complianceResult.failures.map((f) => f.dimension),
      ["bannedWords"]
    );
  });
});

// ─── The real TravelNest post, end to end through the loop ──────────────────
// Angle: Myth vs Fact · Hook: Bold Statement · Structure: List · CTA:
// Reflection, against text that debunks nothing, lists nothing and closes on no
// reflective prompt. Three of those four used to be measured, so this post was
// retried twice and then thrown away. It is a perfectly publishable post: it is
// now accepted on the first attempt.

const TRAVELNEST_PATTERN: DiversityOptions = {
  initialAngle: "Myth vs Fact",
  recentAngles: [],
  initialPattern: { hookType: "Bold Statement", structure: "List", ctaType: "Reflection" },
  recentPatterns: [],
  recentTopics: [],
};

const TRAVELNEST_TEXT =
  "Есента е най-добрият момент за пътуване, но къде отиват пътниците? " +
  "Топ 10 дестинации за тази година включват 8 европейски градове и два мексикански курорта.";

describe("generateWithRetry — the real TravelNest post is accepted, not discarded", () => {
  it("accepts it on the first attempt despite missing three stylistic requirements", async () => {
    const provider = recordingProvider([jsonPost(TRAVELNEST_TEXT)]);
    const result = await generateWithRetry(provider, "sys", "user", [], TRAVELNEST_PATTERN);

    assert.strictEqual(provider.callCount, 1, "a usable post must not be retried over style");
    assert.strictEqual(result.attempts, 1);
    assert.strictEqual(result.complianceResult.status, "passed");
    assert.deepEqual(result.complianceResult.reasons, []);
    assert.strictEqual(result.parsed.text, TRAVELNEST_TEXT);
  });

  it("reports every stylistic dimension as unchecked — it certifies nothing about them", async () => {
    const provider = makeProvider([jsonPost(TRAVELNEST_TEXT)]);
    const result = await generateWithRetry(provider, "sys", "user", [], TRAVELNEST_PATTERN);

    assert.deepEqual(result.complianceResult.checked, {
      angle: false,
      hook: false,
      cta: false,
      structure: false,
      bannedWords: true,
    });
  });

  it("keeps the selected angle and pattern on the record for provenance", async () => {
    const provider = makeProvider([jsonPost(TRAVELNEST_TEXT)]);
    const result = await generateWithRetry(provider, "sys", "user", [], TRAVELNEST_PATTERN);

    assert.strictEqual(result.selectedAngle, TRAVELNEST_PATTERN.initialAngle);
    assert.deepEqual(result.selectedPattern, TRAVELNEST_PATTERN.initialPattern);
  });
});

// ─── [jaccard_duplicate] diagnostics ───────────────────────────────────────────
//
// Every flagged attempt is logged with enough metadata to say, without a
// second database query, whether the matched post was a legitimate sibling
// (same article, or same content group) or a genuinely unrelated historical
// post. `recentPosts` already carries that metadata (see RecentPost); this
// only exercises the classification, which does not depend on how the caller
// populated it — generate-draft-post.service.ts is what actually excludes
// same-contentGroupId siblings from the pool before they ever reach here.
describe("generateWithRetry — [jaccard_duplicate] diagnostics", () => {
  function withCapturedWarn(): { calls: () => unknown[][]; restore: () => void } {
    const original = console.warn;
    const calls: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      calls.push(args);
    };
    return { calls: () => calls, restore: () => (console.warn = original) };
  }

  it("classifies a match against unrelated history as historical, not a sibling", async () => {
    const provider = makeProvider([jsonPost(DUPLICATE_TEXT)]);
    const recentPosts: RecentPost[] = [
      {
        id: "hist-1",
        text: "a b c d",
        channel: "instagram",
        contentGroupId: "group-999",
        feedItemId: "feed-999",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    ];
    const { calls, restore } = withCapturedWarn();
    try {
      await generateWithRetry(
        provider,
        "sys",
        "user",
        recentPosts,
        undefined,
        undefined,
        1,
        undefined,
        { channel: "instagram", feedItemId: "feed-1", contentGroupId: "group-1" }
      );
    } finally {
      restore();
    }

    const diagnosticCall = calls().find(
      (args) => typeof args[0] === "string" && (args[0] as string).startsWith("[jaccard_duplicate]")
    );
    assert.ok(diagnosticCall);
    const [message, diagnostic] = diagnosticCall as [string, Record<string, unknown>];
    assert.match(message, /candidate instagram matched historical instagram post hist-1/);
    assert.match(message, /similarity 0\.8 threshold 0\.75/);
    assert.deepEqual(diagnostic, {
      candidateChannel: "instagram",
      candidateFeedItemId: "feed-1",
      candidateContentGroupId: "group-1",
      similarity: 0.8,
      threshold: 0.75,
      matchedPostId: "hist-1",
      matchedPostChannel: "instagram",
      matchedFeedItemId: "feed-999",
      matchedContentGroupId: "group-999",
      matchedCreatedAt: new Date("2026-01-01T00:00:00Z"),
      matchKind: "historical_post",
      sameChannel: true,
      differentChannel: false,
    });
  });

  it("classifies a match sharing this run's content group as a sibling", async () => {
    const provider = makeProvider([jsonPost(DUPLICATE_TEXT)]);
    const recentPosts: RecentPost[] = [
      {
        id: "sib-1",
        text: "a b c d",
        channel: "instagram",
        contentGroupId: "group-1",
        feedItemId: "feed-999",
      },
    ];
    const { calls, restore } = withCapturedWarn();
    try {
      await generateWithRetry(
        provider,
        "sys",
        "user",
        recentPosts,
        undefined,
        undefined,
        1,
        undefined,
        { channel: "instagram", feedItemId: "feed-1", contentGroupId: "group-1" }
      );
    } finally {
      restore();
    }

    const diagnostic = calls().find((args) => typeof args[0] === "string")?.[1] as
      Record<string, unknown> | undefined;
    assert.equal(diagnostic?.matchKind, "same_content_group_sibling");
  });

  it("classifies a match sharing this run's article as a sibling, even without a shared content group", async () => {
    const provider = makeProvider([jsonPost(DUPLICATE_TEXT)]);
    const recentPosts: RecentPost[] = [
      {
        id: "sib-2",
        text: "a b c d",
        channel: "instagram",
        contentGroupId: "group-999",
        feedItemId: "feed-1",
      },
    ];
    const { calls, restore } = withCapturedWarn();
    try {
      await generateWithRetry(
        provider,
        "sys",
        "user",
        recentPosts,
        undefined,
        undefined,
        1,
        undefined,
        { channel: "instagram", feedItemId: "feed-1", contentGroupId: "group-1" }
      );
    } finally {
      restore();
    }

    const diagnostic = calls().find((args) => typeof args[0] === "string")?.[1] as
      Record<string, unknown> | undefined;
    assert.equal(diagnostic?.matchKind, "same_article_sibling");
  });

  it("logs nothing when no attempt is flagged", async () => {
    const provider = makeProvider([jsonPost(CLEAN_TEXT)]);
    const { calls, restore } = withCapturedWarn();
    try {
      await generateWithRetry(provider, "sys", "user", [recentPost], undefined, undefined, 1);
    } finally {
      restore();
    }

    assert.equal(
      calls().some(
        (args) =>
          typeof args[0] === "string" && (args[0] as string).startsWith("[jaccard_duplicate]")
      ),
      false
    );
  });
});
