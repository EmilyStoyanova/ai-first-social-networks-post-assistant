import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkDuplicatePost, SIMILARITY_THRESHOLD } from "./duplicate-detection";

const post = (id: string, text: string) => ({ id, text });

// ─── The bug this closes ─────────────────────────────────────────────────────
//
// `\w` is ASCII-only, so the old normalizer (`[^\w\s]`) treated every Cyrillic
// letter as punctuation and stripped it. Proven directly against the OLD
// implementation before this fix:
//
//   normalize("Новият смесител улеснява ежедневната употреба в банята.") → []
//   jaccard([], [])                                                     → 1.0
//
// Two completely different Bulgarian posts therefore both collapsed to an
// empty token set and scored a false PERFECT duplicate — and two genuinely
// near-identical Bulgarian posts hit the exact same empty set and the exact
// same false 1.0, so the gate could not tell "different" from "near-duplicate"
// at all once the text was pure Cyrillic. A mixed post fared no better: only
// its Latin product name survived normalization, so the Bulgarian words that
// carried the actual meaning were dropped from their own comparison.

describe("checkDuplicatePost — Cyrillic text is compared, not stripped", () => {
  it("scores two completely different Bulgarian posts well below the duplicate threshold", () => {
    const result = checkDuplicatePost({
      candidateText: "Боята за външни стени издържа на влага и атмосферни условия.",
      recentPosts: [post("p1", "Новият смесител улеснява ежедневната употреба в банята.")],
    });

    assert.strictEqual(result.flagged, false);
    assert.ok(
      result.similarityScore !== null && result.similarityScore < SIMILARITY_THRESHOLD,
      `expected similarity well under ${SIMILARITY_THRESHOLD}, got ${result.similarityScore}`
    );
    // Before the fix this was 1.0 — the whole point of the regression.
    assert.notStrictEqual(result.similarityScore, 1);
  });

  it("scores near-duplicate Bulgarian posts with meaningfully high similarity", () => {
    // Sharing most of a sentence but not all of it: under the flagging
    // threshold, and correctly so (SIMILARITY_THRESHOLD exists precisely to
    // separate this from an exact duplicate) — but nowhere near the false 0
    // OR false 1 the old ASCII normalizer would have produced from the same
    // pair (0 if only one side happened to keep a stray Latin token, 1 if both
    // sides collapsed to empty).
    const result = checkDuplicatePost({
      candidateText: "Този нов смесител е подходящ за модерната баня.",
      recentPosts: [post("p1", "Новият смесител е подходящ за модерна баня.")],
    });

    assert.strictEqual(result.flagged, false);
    assert.ok(
      result.similarityScore !== null && result.similarityScore >= 0.4,
      `expected meaningful similarity, got ${result.similarityScore}`
    );
  });

  it("scores identical Bulgarian text as an exact duplicate", () => {
    const text = "Новият смесител е подходящ за модерна баня.";
    const result = checkDuplicatePost({ candidateText: text, recentPosts: [post("p1", text)] });

    assert.strictEqual(result.flagged, true);
    assert.strictEqual(result.similarityScore, 1);
    assert.strictEqual(result.matchedPostId, "p1");
  });

  it("does not reduce Bulgarian-only content to an empty token set", () => {
    // A regression on the root cause directly: two DIFFERENT Bulgarian posts
    // sharing not one meaningful word must NOT score as identical, which is
    // exactly what an empty-vs-empty comparison used to produce.
    const result = checkDuplicatePost({
      candidateText: "Дъждовна градина в задния двор пести вода през лятото.",
      recentPosts: [post("p1", "Слънчевите панели намаляват сметката за ток през зимата.")],
    });

    assert.strictEqual(result.flagged, false);
    assert.notStrictEqual(result.similarityScore, 1);
  });

  it("keeps Bulgarian words in the comparison alongside a Latin product name", () => {
    // Before the fix, "Смесителят Grohe Eurosmart е подходящ за малки бани."
    // normalized to only {grohe, eurosmart} — every Bulgarian word vanished.
    // A candidate sharing just the product name but describing something
    // unrelated must NOT read as near-identical now that the Bulgarian words
    // are part of the comparison too.
    const result = checkDuplicatePost({
      candidateText: "Смесителят Grohe Eurosmart е подходящ за малки бани.",
      recentPosts: [post("p1", "Ръчката Grohe Eurosmart пасва на всеки интериор.")],
    });

    assert.strictEqual(result.flagged, false);
    assert.ok(result.similarityScore !== null && result.similarityScore > 0);
    assert.ok(result.similarityScore! < SIMILARITY_THRESHOLD);
  });

  it("still flags a genuine mixed Cyrillic+Latin near-duplicate", () => {
    const result = checkDuplicatePost({
      candidateText: "Смесителят Grohe Eurosmart е чудесен избор за малка баня.",
      recentPosts: [post("p1", "Смесителят Grohe Eurosmart е отличен избор за малка баня.")],
    });

    assert.strictEqual(result.flagged, true);
  });
});

// ─── Punctuation, URLs, hashtags, emoji ──────────────────────────────────────

describe("checkDuplicatePost — non-word content does not dominate similarity", () => {
  it("ignores a Cyrillic hashtag as a token but does not let it manufacture a false match", () => {
    const result = checkDuplicatePost({
      candidateText: "Ново пристигане в магазина. #промоция",
      recentPosts: [post("p1", "Разпродажба до края на месеца. #промоция")],
    });

    assert.strictEqual(result.flagged, false);
  });

  it("does not let a shared URL alone push two different Bulgarian posts over the threshold", () => {
    const result = checkDuplicatePost({
      candidateText: "Новата серия смесители пристигна. https://example.com/a",
      recentPosts: [post("p1", "Разпродажбата на боя приключва скоро. https://example.com/a")],
    });

    assert.strictEqual(result.flagged, false);
  });

  it("ignores emoji rather than treating them as comparable tokens", () => {
    const result = checkDuplicatePost({
      candidateText: "Новият смесител е тук 🚿🎉",
      recentPosts: [post("p1", "Разпродажба до неделя 🎉🔥")],
    });

    assert.strictEqual(result.flagged, false);
  });

  it("treats punctuation-only differences as the same text", () => {
    const result = checkDuplicatePost({
      candidateText: "Новият смесител е подходящ за модерна баня",
      recentPosts: [post("p1", "Новият, смесител — е подходящ за модерна баня!")],
    });

    assert.strictEqual(result.flagged, true);
  });
});

// ─── English behaviour is unchanged ──────────────────────────────────────────

describe("checkDuplicatePost — English behaviour is unaffected", () => {
  it("flags near-verbatim English text as before", () => {
    const result = checkDuplicatePost({
      candidateText: "A single-lever mixer solves the temperature problem in one movement.",
      recentPosts: [
        post("p1", "A single-lever mixer solves the temperature problem in one motion."),
      ],
    });

    assert.strictEqual(result.flagged, true);
  });

  it("does not flag genuinely different English text", () => {
    const result = checkDuplicatePost({
      candidateText: "Ceramic cartridges typically outlast rubber washers by years.",
      recentPosts: [post("p1", "Rain gardens reduce runoff after a heavy storm.")],
    });

    assert.strictEqual(result.flagged, false);
  });
});

// ─── Empty-set semantics ──────────────────────────────────────────────────────
//
// An empty-vs-empty comparison carries no evidence of duplication. Scoring it
// 1.0 (the old behaviour) is exactly the mechanism that turned the Cyrillic bug
// above into a false duplicate purely from two empty sets — so this is a
// second, independent line of defense: even if a future normalizer bug (or a
// genuinely blank/punctuation-only post) again produces an empty set, an
// empty-vs-empty comparison must not be able to force a retry or an abort.

describe("checkDuplicatePost — empty-set semantics", () => {
  it("does not flag two candidates that both normalize to no tokens", () => {
    const result = checkDuplicatePost({
      candidateText: "... !!! ???",
      recentPosts: [post("p1", "*** --- ///")],
    });

    assert.strictEqual(result.flagged, false);
    assert.strictEqual(result.similarityScore, 0);
  });

  it("does not flag an empty candidate against real text", () => {
    const result = checkDuplicatePost({
      candidateText: "",
      recentPosts: [post("p1", "Новият смесител е подходящ за модерна баня.")],
    });

    assert.strictEqual(result.flagged, false);
    assert.strictEqual(result.similarityScore, 0);
  });

  it("does not flag real text against an empty recent post", () => {
    const result = checkDuplicatePost({
      candidateText: "Новият смесител е подходящ за модерна баня.",
      recentPosts: [post("p1", "")],
    });

    assert.strictEqual(result.flagged, false);
    assert.strictEqual(result.similarityScore, 0);
  });

  it("does not flag whitespace-only candidates against each other", () => {
    const result = checkDuplicatePost({
      candidateText: "   ",
      recentPosts: [post("p1", "\t\n  ")],
    });

    assert.strictEqual(result.flagged, false);
  });

  it("still returns the neutral no-history result when there are no recent posts at all", () => {
    // Unchanged pre-existing behaviour — distinct from the empty-set case above,
    // which has history but nothing comparable in it.
    const result = checkDuplicatePost({ candidateText: "Новият смесител.", recentPosts: [] });

    assert.deepEqual(result, { flagged: false, similarityScore: null, matchedPostId: null });
  });
});
