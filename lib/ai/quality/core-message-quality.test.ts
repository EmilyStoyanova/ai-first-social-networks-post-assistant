import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assessCoreMessage, isGenericCoreMessage } from "./core-message-quality";

// ─── 1. Rejecting generic core messages ───────────────────────────────────────

describe("isGenericCoreMessage — rejects generic destination/product praise", () => {
  it("flags the observed Corfu generic claim", () => {
    assert.ok(isGenericCoreMessage("Corfu is ideal for family holidays."));
  });

  it("flags 'perfect choice' praise with no reason", () => {
    assert.ok(isGenericCoreMessage("This resort is the perfect choice for couples."));
  });

  it("flags 'unforgettable experience' praise", () => {
    assert.ok(isGenericCoreMessage("A stay here is an unforgettable experience."));
  });

  it("flags 'something for everyone'", () => {
    assert.ok(isGenericCoreMessage("The island has something for everyone."));
  });

  it("flags 'a must-visit destination'", () => {
    assert.ok(isGenericCoreMessage("Santorini is a must-visit destination this summer."));
  });

  it("flags empty / whitespace-only core messages", () => {
    assert.ok(isGenericCoreMessage(""));
    assert.ok(isGenericCoreMessage("   "));
    assert.ok(isGenericCoreMessage(null));
  });

  it("reports a reason for a flagged message", () => {
    const assessment = assessCoreMessage("Corfu is ideal for family holidays.");
    assert.equal(assessment.generic, true);
    assert.ok(assessment.reasons.length > 0);
  });
});

// ─── 2. Producing concrete, aspect-based core messages ────────────────────────

describe("isGenericCoreMessage — accepts concrete, aspect-based claims", () => {
  it("accepts a specific, testable claim with a concrete differentiator", () => {
    assert.ok(
      !isGenericCoreMessage(
        "Corfu's shallow, calm north-east bays let toddlers wade safely, which is why families favour it."
      )
    );
  });

  it("accepts a claim with no praise language at all", () => {
    assert.ok(
      !isGenericCoreMessage(
        "Automating repetitive marketing work frees small businesses to focus on growth."
      )
    );
  });

  it("accepts praise when it is immediately backed by a specific number", () => {
    assert.ok(
      !isGenericCoreMessage(
        "Corfu is ideal for families because 3 of its east-coast beaches stay under knee-deep for 30 metres."
      )
    );
  });

  it("accepts praise backed by a 'because' reason clause", () => {
    assert.ok(
      !isGenericCoreMessage(
        "The resort is a perfect choice for remote workers because every room has fibre internet and a standing desk."
      )
    );
  });

  it("does not flag a neutral, non-praise central claim used in tests", () => {
    assert.ok(!isGenericCoreMessage("A single central claim for this post."));
    assert.ok(
      !isGenericCoreMessage(
        "Anticipation for an upcoming launch builds excitement and keeps the audience engaged."
      )
    );
  });
});
