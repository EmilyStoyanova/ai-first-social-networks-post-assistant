import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeNextProfileVersion,
  defaultResearchTopicsFromBrand,
  sameStringSet,
  shouldRecomputeRelevanceOnSave,
  shouldReopenStaleAnalysisOnSave,
  versionWasBumped,
} from "./research-profile-versioning";

describe("defaultResearchTopicsFromBrand", () => {
  it("concatenates top + medium priority topics, in that order", () => {
    assert.deepEqual(
      defaultResearchTopicsFromBrand({
        topPriorityTopics: ["sustainability", "AI"],
        mediumPriorityTopics: ["pricing"],
      }),
      ["sustainability", "AI", "pricing"]
    );
  });

  it("returns [] when Brand Guidelines has no configured topics", () => {
    assert.deepEqual(
      defaultResearchTopicsFromBrand({ topPriorityTopics: [], mediumPriorityTopics: [] }),
      []
    );
  });

  it("returns [] when there is no Brand Guidelines row at all", () => {
    assert.deepEqual(defaultResearchTopicsFromBrand(null), []);
  });
});

describe("sameStringSet", () => {
  it("treats a reordered list as unchanged", () => {
    assert.equal(sameStringSet(["a", "b", "c"], ["c", "a", "b"]), true);
  });

  it("detects an actual addition", () => {
    assert.equal(sameStringSet(["a", "b"], ["a", "b", "c"]), false);
  });

  it("detects an actual removal", () => {
    assert.equal(sameStringSet(["a", "b", "c"], ["a", "b"]), false);
  });
});

describe("computeNextProfileVersion", () => {
  it("is 1 on the very first save, regardless of content", () => {
    assert.equal(computeNextProfileVersion(null, { researchTopics: ["x"], markets: [] }), 1);
  });

  it("does NOT bump when only analysisPeriodDays would change — topics/markets identical", () => {
    const existing = { researchTopics: ["a", "b"], markets: ["BG"], profileVersion: 3 };
    const next = { researchTopics: ["a", "b"], markets: ["BG"] };
    assert.equal(computeNextProfileVersion(existing, next), 3);
  });

  it("bumps when researchTopics changed", () => {
    const existing = { researchTopics: ["a", "b"], markets: ["BG"], profileVersion: 3 };
    const next = { researchTopics: ["a", "b", "c"], markets: ["BG"] };
    assert.equal(computeNextProfileVersion(existing, next), 4);
  });

  it("bumps when markets changed", () => {
    const existing = { researchTopics: ["a", "b"], markets: ["BG"], profileVersion: 3 };
    const next = { researchTopics: ["a", "b"], markets: ["BG", "RO"] };
    assert.equal(computeNextProfileVersion(existing, next), 4);
  });

  it("does NOT bump when researchTopics is merely reordered", () => {
    const existing = { researchTopics: ["a", "b"], markets: [], profileVersion: 5 };
    const next = { researchTopics: ["b", "a"], markets: [] };
    assert.equal(computeNextProfileVersion(existing, next), 5);
  });
});

describe("versionWasBumped", () => {
  it("is false on the first-ever save — there is no prior version to move away from", () => {
    assert.equal(versionWasBumped(null, 1), false);
  });

  it("is true when an existing row's version actually moved", () => {
    assert.equal(versionWasBumped({ profileVersion: 3 }, 4), true);
  });

  it("is false when the version is unchanged (period-only save)", () => {
    assert.equal(versionWasBumped({ profileVersion: 3 }, 3), false);
  });
});

// ─── Verification-pass §1: the unsaved-default lifecycle ─────────────────
// Reproduces the exact sequence the pass asked to trace:
//   A. no CompetitorResearchProfile row exists; effective (unpersisted)
//      Brand-derived defaults are used, and content is extracted/relevance
//      would be judged against them if anything ever computed it — nothing
//      does (recomputeStaleRelevanceForCompany refuses to run without a
//      persisted row).
//   B. the user's FIRST Save changes topics away from those defaults; the
//      newly-persisted row starts at profileVersion = 1.
// The concern was: could content judged against the unsaved defaults ALSO
// carry relevanceProfileVersion = 1, colliding with the first persisted
// save's version 1 and breaking stale detection? See
// `shouldRecomputeRelevanceOnSave`'s own comment for why the answer is no —
// nothing is ever computed before persistence, so there is only ever one
// "version 1" per company, and no sentinel is needed.
describe("shouldRecomputeRelevanceOnSave — the unsaved-default lifecycle (verification pass §1)", () => {
  it("A → B: the FIRST-EVER save (existing === null) must trigger a recompute", () => {
    // This is the exact bug the pass found: relying on versionBumped alone
    // (which is unconditionally false when existing is null) would silently
    // skip the recompute here, leaving any content extracted before this
    // save sat at relevance: pending forever.
    const existing = null;
    const versionBumped = versionWasBumped(
      existing,
      computeNextProfileVersion(existing, {
        researchTopics: ["boilers", "air conditioning"],
        markets: [],
      })
    );
    assert.equal(versionBumped, false); // confirms the trap this function avoids
    assert.equal(shouldRecomputeRelevanceOnSave(existing, versionBumped), true);
  });

  it("first save always persists at profileVersion 1, regardless of the topics chosen", () => {
    const version = computeNextProfileVersion(null, {
      researchTopics: ["boilers", "air conditioning"],
      markets: [],
    });
    assert.equal(version, 1);
  });

  it("a later save that changes topics/markets triggers a recompute via versionBumped", () => {
    const existing = {
      researchTopics: ["boilers", "air conditioning"],
      markets: [],
      profileVersion: 1,
    };
    const next = { researchTopics: ["boilers", "faucets"], markets: [] };
    const nextVersion = computeNextProfileVersion(existing, next);
    const versionBumped = versionWasBumped(existing, nextVersion);
    assert.equal(nextVersion, 2);
    assert.equal(versionBumped, true);
    assert.equal(shouldRecomputeRelevanceOnSave(existing, versionBumped), true);
  });

  it("a period-only save on an existing row triggers NO recompute", () => {
    const existing = { researchTopics: ["boilers"], markets: [], profileVersion: 2 };
    // analysisPeriodDays is not part of computeNextProfileVersion's input —
    // topics/markets are unchanged, so the version does not move.
    const nextVersion = computeNextProfileVersion(existing, {
      researchTopics: ["boilers"],
      markets: [],
    });
    const versionBumped = versionWasBumped(existing, nextVersion);
    assert.equal(nextVersion, 2);
    assert.equal(versionBumped, false);
    assert.equal(shouldRecomputeRelevanceOnSave(existing, versionBumped), false);
  });

  it("a second, later save that changes NOTHING further (no-op re-save) triggers no recompute either", () => {
    const existing = { researchTopics: ["boilers", "faucets"], markets: [], profileVersion: 2 };
    const nextVersion = computeNextProfileVersion(existing, {
      researchTopics: ["boilers", "faucets"],
      markets: [],
    });
    const versionBumped = versionWasBumped(existing, nextVersion);
    assert.equal(shouldRecomputeRelevanceOnSave(existing, versionBumped), false);
  });
});

// ─── 2026-09-02 ownership-boundary fix ─────────────────────────────────────
describe("computeNextProfileVersion — analysisLanguage never participates", () => {
  it("does not accept analysisLanguage as an input at all — a language-only save has nothing that could bump the version", () => {
    // There is no `analysisLanguage` field in either parameter's type — this
    // is enforced by construction, not by a runtime branch. Passing the exact
    // same topics/markets (the only two fields this function ever looks at)
    // must leave the version exactly where it was, regardless of what else
    // changed on the save.
    const existing = { researchTopics: ["a", "b"], markets: ["BG"], profileVersion: 4 };
    const next = { researchTopics: ["a", "b"], markets: ["BG"] };
    assert.equal(computeNextProfileVersion(existing, next), 4);
  });
});

describe("shouldReopenStaleAnalysisOnSave", () => {
  it("(new Research Profile) the FIRST-EVER save must trigger recovery — extraction may have already run under the safe default", () => {
    // A company can have `completed` CompetitorIntelligence rows before ever
    // saving a Research Profile — extraction does not require one. The very
    // first save may set analysisLanguage to something those rows were never
    // analyzed under.
    assert.equal(shouldReopenStaleAnalysisOnSave(null, false), true);
  });

  it("a later save that changes analysisLanguage triggers recovery", () => {
    const existing = { analysisLanguage: "en" };
    assert.equal(shouldReopenStaleAnalysisOnSave(existing, true), true);
  });

  it("a later save that keeps analysisLanguage unchanged triggers NO recovery", () => {
    const existing = { analysisLanguage: "bg" };
    assert.equal(shouldReopenStaleAnalysisOnSave(existing, false), false);
  });

  it("a topics/markets/period-only save (analysisLanguage unchanged) triggers no recovery — mirrors shouldRecomputeRelevanceOnSave's own topics/markets-only case, for the orthogonal field", () => {
    const existing = { analysisLanguage: "bg" };
    const languageChanged = false; // the caller computes this independently of topics/markets
    assert.equal(shouldReopenStaleAnalysisOnSave(existing, languageChanged), false);
  });
});
