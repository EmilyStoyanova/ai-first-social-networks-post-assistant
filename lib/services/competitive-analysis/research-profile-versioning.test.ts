import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeNextProfileVersion,
  defaultResearchTopicsFromBrand,
  sameStringSet,
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
