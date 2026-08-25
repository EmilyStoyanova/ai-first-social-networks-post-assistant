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
// valid so retry selection has something to rotate through. Every dimension is
// one the compliance gate never checks (Step 2) — angle "Educational", hook
// "Question", structure "Story Arc", CTA "No CTA" — so these fixtures exercise
// Topic Memory in isolation without also tripping the compliance gate on
// CLEAN_TEXT/DUPLICATE_TEXT's nonsense sentences. That makes attempt 1 report
// `not_checked`, which is non-blocking by design.
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

// ─── Post-generation compliance gate (Step 2) ──────────────────────────────
// Angle: Tips & Tricks, Hook: Question (unchecked), Structure: Story Arc
// (unchecked), CTA: Follow — mirrors the real production pattern
// (Tips & Tricks / Contrast / Follow) that was accepted with 0 tips and no
// Follow CTA. Angle and CTA are the only checked dimensions here, on purpose:
// these tests are about what the LOOP does with a failure, so exactly two
// checks keep the expected reasons predictable.

function makeComplianceDiversity(): DiversityOptions {
  return {
    initialAngle: "Tips & Tricks",
    recentAngles: [],
    initialPattern: { hookType: "Question", structure: "Story Arc", ctaType: "Follow" },
    recentPatterns: [],
    recentTopics: [],
  };
}

// CLEAN_TEXT ("x y z w q") has no sentence punctuation and no follow language,
// so it fails BOTH the tips count (0) and the Follow CTA check.
const COMPLIANT_TIPS_FOLLOW_TEXT = [
  "Here are two ways to plan a smarter trip.",
  "1. Book your tickets at least two months in advance.",
  "2. Pack only what fits in a single carry-on bag.",
  "Follow us for more travel tips!",
].join("\n");

describe("generateWithRetry — compliance failure triggers a retry", () => {
  it("retries a noncompliant candidate and accepts a compliant one", async () => {
    const provider = makeProvider([jsonPost(CLEAN_TEXT), jsonPost(COMPLIANT_TIPS_FOLLOW_TEXT)]);
    const result = await generateWithRetry(provider, "sys", "user", [], makeComplianceDiversity());

    assert.strictEqual(provider.callCount, 2, "should retry exactly once");
    assert.strictEqual(result.complianceResult.status, "passed");
    assert.strictEqual(result.complianceResult.passed, true);
    assert.strictEqual(result.attempts, 2);
    assert.strictEqual(result.parsed.text, COMPLIANT_TIPS_FOLLOW_TEXT);
  });

  it("keeps the SAME angle/hook/structure/CTA across the retry — never rotates for a compliance-only failure", async () => {
    const provider = makeProvider([jsonPost(CLEAN_TEXT), jsonPost(COMPLIANT_TIPS_FOLLOW_TEXT)]);
    const diversity = makeComplianceDiversity();
    const result = await generateWithRetry(provider, "sys", "user", [], diversity);

    assert.deepEqual(result.selectedAngle, diversity.initialAngle);
    assert.deepEqual(result.selectedPattern, diversity.initialPattern);
  });

  it("the retry prompt names the concrete compliance failure reasons, without forcing a different pattern", async () => {
    const provider = recordingProvider([
      jsonPost(CLEAN_TEXT),
      jsonPost(COMPLIANT_TIPS_FOLLOW_TEXT),
    ]);
    await generateWithRetry(provider, "sys", "user", [], makeComplianceDiversity());

    const retryPrompt = provider.prompts[1];
    assert.match(retryPrompt, /Tips & Tricks requires 2–4 actionable tips; found 0/);
    assert.match(retryPrompt, /Follow CTA is required/);
    // Every other retry reason tells the model to switch pattern/topic — a pure
    // compliance retry must not, since the pattern itself was already correct.
    assert.doesNotMatch(retryPrompt, /FORCED CONTENT PATTERN/);
    assert.doesNotMatch(retryPrompt, /Do not reuse the same hook type/);
  });

  it("exhausts attempts and hands the failed verdict back rather than throwing", async () => {
    // The loop reports; it does not decide. `complianceResult.passed === false`
    // surviving to the return value is what lets the generation service refuse
    // to save the post (POST_FAILED_COMPLIANCE) — see
    // generate-draft-post.service.test.ts, "compliance abort". So the contract
    // asserted here is "never throws AND never launders the failure into a pass".
    const provider = makeProvider([jsonPost(CLEAN_TEXT)]);
    const result = await generateWithRetry(provider, "sys", "user", [], makeComplianceDiversity());

    assert.strictEqual(provider.callCount, MAX_GENERATION_ATTEMPTS);
    assert.strictEqual(result.attempts, MAX_GENERATION_ATTEMPTS);
    assert.strictEqual(result.complianceResult.status, "failed");
    assert.strictEqual(result.complianceResult.passed, false);
    assert.ok(result.complianceResult.reasons.length > 0);
    assert.strictEqual(result.parsed.text, CLEAN_TEXT);
  });
});

describe("generateWithRetry — compliance check needs an angle AND a pattern to run", () => {
  it("never fails compliance when no diversity options are given at all", async () => {
    const provider = makeProvider([jsonPost(CLEAN_TEXT)]);
    const result = await generateWithRetry(provider, "sys", "user", []);

    assert.strictEqual(
      provider.callCount,
      1,
      "nothing to check against — accepted on the first try"
    );
    assert.strictEqual(result.complianceResult.status, "not_checked");
    assert.strictEqual(result.complianceResult.evaluated, false);
    assert.strictEqual(result.complianceResult.passed, true);
  });
});

// ─── "Nothing was checkable" must never behave like a failure ───────────────
// The whole point of separating `not_checked` from `passed` is honesty in the
// report — it must not leak into control flow. An unsupported pattern is still
// accepted on the first try, exactly as it was before the status existed.

describe("generateWithRetry — an unsupported pattern combination never blocks", () => {
  it("accepts on attempt 1 and reports not_checked when no dimension is measurable", async () => {
    const provider = makeProvider([jsonPost(CLEAN_TEXT)]);
    const result = await generateWithRetry(provider, "sys", "user", [], {
      // Not one of these has a deterministic check: the angle is not
      // Tips & Tricks or Myth vs Fact, the hook is not Contrast, the structure
      // is not List, and "Try It" has no low-false-positive CTA signal.
      initialAngle: "Behind the Scenes",
      recentAngles: [],
      initialPattern: { hookType: "Empathy", structure: "Story Arc", ctaType: "Try It" },
      recentPatterns: [],
      recentTopics: [],
    });

    assert.strictEqual(provider.callCount, 1, "an unverifiable pattern must not cause a retry");
    assert.strictEqual(result.complianceResult.status, "not_checked");
    assert.strictEqual(result.complianceResult.evaluated, false);
    assert.deepEqual(result.complianceResult.reasons, []);
    assert.deepEqual(result.complianceResult.checked, {
      angle: false,
      hook: false,
      cta: false,
      structure: false,
    });
  });
});

// ─── The real TravelNest failure, end to end through the loop ───────────────
// Angle: Myth vs Fact · Hook: Bold Statement · Structure: List · CTA:
// Reflection — the combination that reported "Passed: true" with every
// `checked.*` false. Three of the four are now measured, so the same post is
// rejected and retried instead of accepted.

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

const TRAVELNEST_COMPLIANT_TEXT = [
  "Мит: есента е мъртъв сезон за пътуване. Факт: цените на билетите падат с около 30% след 15 септември.",
  "1. Лисабон — слънце до края на октомври.",
  "2. Рим — половината опашки пред музеите.",
  "3. Прага — най-евтините нощувки за годината.",
  "А вие къде бихте пътували тази есен?",
].join("\n");

describe("generateWithRetry — the real TravelNest post is rejected and retried", () => {
  it("fails compliance on the real text and names all three missed requirements", async () => {
    const provider = recordingProvider([
      jsonPost(TRAVELNEST_TEXT),
      jsonPost(TRAVELNEST_COMPLIANT_TEXT),
    ]);
    const result = await generateWithRetry(provider, "sys", "user", [], TRAVELNEST_PATTERN);

    assert.strictEqual(provider.callCount, 2, "the real post must be rejected, not accepted");
    assert.strictEqual(result.attempts, 2);
    assert.strictEqual(result.complianceResult.status, "passed");
    assert.strictEqual(result.parsed.text, TRAVELNEST_COMPLIANT_TEXT);

    // The retry prompt must name what was missing, and must not rotate away
    // from the pattern that was correct all along.
    const retryPrompt = provider.prompts[1];
    assert.match(
      retryPrompt,
      /Myth vs Fact requires the opening to challenge a clear misconception/
    );
    assert.match(retryPrompt, /List structure requires 3–5 scannable list items; found 0/);
    assert.match(retryPrompt, /Reflection CTA is required/);
    assert.doesNotMatch(retryPrompt, /FORCED CONTENT PATTERN/);
  });

  it("keeps the same angle, hook, structure and CTA on the retry", async () => {
    const provider = makeProvider([jsonPost(TRAVELNEST_TEXT), jsonPost(TRAVELNEST_COMPLIANT_TEXT)]);
    const result = await generateWithRetry(provider, "sys", "user", [], TRAVELNEST_PATTERN);

    assert.strictEqual(result.selectedAngle, TRAVELNEST_PATTERN.initialAngle);
    assert.deepEqual(result.selectedPattern, TRAVELNEST_PATTERN.initialPattern);
  });

  it("reports checked=true for the three measurable dimensions and false for the hook", async () => {
    const provider = makeProvider([jsonPost(TRAVELNEST_TEXT)]);
    const result = await generateWithRetry(provider, "sys", "user", [], TRAVELNEST_PATTERN);

    assert.strictEqual(result.complianceResult.status, "failed");
    assert.deepEqual(result.complianceResult.checked, {
      angle: true,
      hook: false, // "Bold Statement" has no defensible deterministic signal
      cta: true,
      structure: true,
    });
  });
});
