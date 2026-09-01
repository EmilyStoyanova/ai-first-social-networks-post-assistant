import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { relevanceDisplayState } from "./relevance-display-state";

describe("relevanceDisplayState — profile not configured takes priority", () => {
  it("returns profile_not_configured regardless of the row's own relevance", () => {
    for (const relevance of ["relevant", "related", "out_of_scope", "pending"]) {
      assert.equal(
        relevanceDisplayState({ relevance, relevanceReason: null }, false),
        "profile_not_configured",
        `expected profile_not_configured for relevance="${relevance}"`
      );
    }
  });

  it("overrides even a row that failed and exhausted its retries", () => {
    assert.equal(
      relevanceDisplayState({ relevance: "pending", relevanceReason: "exhausted retries" }, false),
      "profile_not_configured"
    );
  });
});

describe("relevanceDisplayState — genuine verdicts pass through unchanged", () => {
  it("relevant", () => {
    assert.equal(
      relevanceDisplayState({ relevance: "relevant", relevanceReason: "why" }, true),
      "relevant"
    );
  });
  it("related", () => {
    assert.equal(
      relevanceDisplayState({ relevance: "related", relevanceReason: "why" }, true),
      "related"
    );
  });
  it("out_of_scope", () => {
    assert.equal(
      relevanceDisplayState({ relevance: "out_of_scope", relevanceReason: "why" }, true),
      "out_of_scope"
    );
  });
});

describe("relevanceDisplayState — pending vs failed", () => {
  it("a genuinely awaiting row (pending, no reason yet) reads as pending", () => {
    assert.equal(
      relevanceDisplayState({ relevance: "pending", relevanceReason: null }, true),
      "pending"
    );
  });

  it("an exhausted-retries row (pending, reason set) reads as failed", () => {
    assert.equal(
      relevanceDisplayState(
        {
          relevance: "pending",
          relevanceReason:
            "Relevance evaluation failed after 3 attempts against this Research Profile version.",
        },
        true
      ),
      "failed"
    );
  });
});
