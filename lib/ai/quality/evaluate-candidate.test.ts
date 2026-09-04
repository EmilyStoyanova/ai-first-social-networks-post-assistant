import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateCandidate, type SemanticGate } from "./evaluate-candidate";
import type { RecentPost } from "./duplicate-detection";
import type { ParsedLlmPost } from "../parse-llm-post";

/**
 * The shared gate evaluator, tested directly.
 *
 * `generate-with-retry.test.ts` already covers these gates through the
 * single-agent loop and passed unedited after the extraction, which is the real
 * regression control. What this file adds is the property the extraction exists
 * for: the `rejectionReason` LADDER, which decides what a retry prompt is built
 * from when several gates fire at once, and which both strategies now inherit
 * from one place.
 */

const CLEAN: ParsedLlmPost = {
  text:
    "Building in the open earns trust because every shipped decision is visible to the people paying for it.\n" +
    "A first look drops this week, and early access opens right after.",
  hashtags: ["growth"],
  coreMessage: "Publishing decisions as they are made shortens the feedback loop by about a week.",
  topic: "open development",
};

const gateSaying =
  (decision: "accept" | "gray_zone" | "regenerate"): SemanticGate =>
  async () => ({
    decision,
    topSimilarity: decision === "regenerate" ? 0.95 : 0.2,
    matchedPostId: decision === "regenerate" ? "post-1" : null,
    matchedCoreMessage: decision === "regenerate" ? "An earlier post said this." : null,
    skipped: false,
  });

describe("evaluateCandidate — a clean candidate", () => {
  it("needs no retry and names no reason", async () => {
    const v = await evaluateCandidate({ parsed: CLEAN, recentPosts: [], attempt: 1 });
    assert.equal(v.needsRetry, false);
    assert.equal(v.rejectionReason, null);
  });

  it("reports the semantic gate as SKIPPED when none is injected, and still accepts", async () => {
    // Fail-open: an absent gate must never look like a passing gate, and must
    // never block either.
    const v = await evaluateCandidate({ parsed: CLEAN, recentPosts: [], attempt: 1 });
    assert.equal(v.semanticResult.skipped, true);
    assert.equal(v.semanticResult.decision, "accept");
    assert.equal(v.needsRetry, false);
  });

  it("treats a gray-zone verdict as acceptable", async () => {
    const v = await evaluateCandidate({
      parsed: CLEAN,
      recentPosts: [],
      semanticGate: gateSaying("gray_zone"),
      attempt: 1,
    });
    assert.equal(v.needsRetry, false);
  });
});

describe("evaluateCandidate — each gate fires on its own", () => {
  it("jaccard_duplicate", async () => {
    const recent: RecentPost[] = [{ id: "post-1", text: CLEAN.text }];
    const v = await evaluateCandidate({ parsed: CLEAN, recentPosts: recent, attempt: 1 });
    assert.equal(v.rejectionReason, "jaccard_duplicate");
    assert.equal(v.duplicateResult.matchedPostId, "post-1");
  });

  it("semantic_duplicate", async () => {
    const v = await evaluateCandidate({
      parsed: CLEAN,
      recentPosts: [],
      semanticGate: gateSaying("regenerate"),
      attempt: 1,
    });
    assert.equal(v.rejectionReason, "semantic_duplicate");
  });

  it("generic_core_message", async () => {
    const v = await evaluateCandidate({
      parsed: {
        ...CLEAN,
        coreMessage: "This is the perfect choice for an unforgettable experience.",
      },
      recentPosts: [],
      attempt: 1,
    });
    assert.equal(v.rejectionReason, "generic_core_message");
  });

  it("repeated_topic", async () => {
    const v = await evaluateCandidate({
      parsed: CLEAN,
      recentPosts: [],
      recentTopics: ["open development"],
      attempt: 1,
    });
    assert.equal(v.rejectionReason, "repeated_topic");
  });

  it("compliance_failed", async () => {
    const v = await evaluateCandidate({
      parsed: { ...CLEAN, text: `Стоп! ${CLEAN.text}` },
      recentPosts: [],
      contentLanguage: "bg",
      attempt: 1,
    });
    assert.equal(v.rejectionReason, "compliance_failed");
    assert.equal(v.complianceResult.status, "failed");
  });
});

describe("evaluateCandidate — the rejectionReason ladder", () => {
  it("Jaccard outranks every other gate", async () => {
    // The ladder decides which reason the next attempt's prompt is built from.
    // Jaccard first because near-verbatim text is the least ambiguous evidence
    // and the most actionable instruction.
    const recent: RecentPost[] = [{ id: "post-1", text: CLEAN.text }];
    const v = await evaluateCandidate({
      parsed: {
        ...CLEAN,
        coreMessage: "This is the perfect choice for an unforgettable experience.",
      },
      recentPosts: recent,
      semanticGate: gateSaying("regenerate"),
      recentTopics: ["open development"],
      attempt: 1,
    });
    assert.equal(v.rejectionReason, "jaccard_duplicate");
    // Every other verdict is still REPORTED — the ladder chooses the headline,
    // it does not suppress the rest.
    assert.equal(v.semanticResult.decision, "regenerate");
    assert.equal(v.coreMessageGeneric, true);
    assert.equal(v.topicRepeated, true);
  });

  it("semantic outranks a generic core message", async () => {
    const v = await evaluateCandidate({
      parsed: { ...CLEAN, coreMessage: "An ideal place and a perfect choice." },
      recentPosts: [],
      semanticGate: gateSaying("regenerate"),
      attempt: 1,
    });
    assert.equal(v.rejectionReason, "semantic_duplicate");
  });

  it("a generic core message outranks a repeated topic", async () => {
    const v = await evaluateCandidate({
      parsed: { ...CLEAN, coreMessage: "An ideal place and a perfect choice." },
      recentPosts: [],
      recentTopics: ["open development"],
      attempt: 1,
    });
    assert.equal(v.rejectionReason, "generic_core_message");
  });

  it("compliance sits LAST — a banned term is only the headline when nothing else fired", async () => {
    const v = await evaluateCandidate({
      parsed: { ...CLEAN, text: `Стоп! ${CLEAN.text}`, topic: "open development" },
      recentPosts: [],
      recentTopics: ["open development"],
      contentLanguage: "bg",
      attempt: 1,
    });
    assert.equal(v.rejectionReason, "repeated_topic");
    // But the compliance failure is still on the record, and it is what the
    // service refuses to persist.
    assert.equal(v.complianceResult.status, "failed");
  });
});

describe("evaluateCandidate — the topic-memory waiver", () => {
  it("an empty topic memory never fires, which is how a sibling channel is exempted", async () => {
    // `loopTopicMemory` is [] for a dictated topic: the prompt was ORDERED to
    // repeat it, so the judge must not reject it for obeying. The waiver lives
    // at the call site and works by handing this function nothing to compare.
    const v = await evaluateCandidate({
      parsed: CLEAN,
      recentPosts: [],
      recentTopics: [],
      attempt: 1,
    });
    assert.equal(v.topicRepeated, false);
    assert.equal(v.needsRetry, false);
  });
});
