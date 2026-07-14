import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SocialChannel } from "@prisma/client";
import {
  recordSemanticCalibration,
  summarizeCalibration,
  getSemanticCalibrationSummary,
  type SemanticCalibrationInput,
  type SemanticCalibrationRecord,
  type SemanticCalibrationStore,
} from "./semantic-calibration.service";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function record(overrides: Partial<SemanticCalibrationRecord> = {}): SemanticCalibrationRecord {
  return {
    decision: "accept",
    topSimilarity: 0.5,
    attempts: 1,
    gateSkipped: false,
    ...overrides,
  };
}

function makeInput(overrides: Partial<SemanticCalibrationInput> = {}): SemanticCalibrationInput {
  return {
    postId: "post-1",
    companyId: "co-1",
    channel: "linkedin" as SocialChannel,
    postCreatedAt: new Date("2026-07-14T00:00:00Z"),
    topSimilarity: 0.736,
    matchedPostId: "match-1",
    decision: "accept",
    attempts: 2,
    gateSkipped: false,
    evaluatedAt: new Date("2026-07-14T01:00:00Z"),
    ...overrides,
  };
}

// ─── 4. Diagnostic persistence ────────────────────────────────────────────────

describe("recordSemanticCalibration — persistence", () => {
  it("passes the gate diagnostics to the store", async () => {
    let captured: SemanticCalibrationInput | null = null;
    const store: SemanticCalibrationStore = {
      record: async (input) => {
        captured = input;
      },
    };

    await recordSemanticCalibration(makeInput(), { store });

    assert.ok(captured, "store.record should have been called");
    const c = captured as SemanticCalibrationInput;
    assert.equal(c.postId, "post-1");
    assert.equal(c.topSimilarity, 0.736);
    assert.equal(c.matchedPostId, "match-1");
    assert.equal(c.decision, "accept");
    assert.equal(c.attempts, 2);
    assert.equal(c.gateSkipped, false);
  });

  it("never throws when the store fails (best-effort)", async () => {
    const store: SemanticCalibrationStore = {
      record: async () => {
        throw new Error("db exploded");
      },
    };
    await assert.doesNotReject(() => recordSemanticCalibration(makeInput(), { store }));
  });

  it("records a skipped-gate outcome with a null similarity", async () => {
    let captured: SemanticCalibrationInput | null = null;
    const store: SemanticCalibrationStore = {
      record: async (input) => {
        captured = input;
      },
    };
    await recordSemanticCalibration(
      makeInput({ gateSkipped: true, topSimilarity: null, matchedPostId: null }),
      { store }
    );
    const c = captured as unknown as SemanticCalibrationInput;
    assert.equal(c.gateSkipped, true);
    assert.equal(c.topSimilarity, null);
  });
});

// ─── 5. Calibration summary ───────────────────────────────────────────────────

describe("summarizeCalibration — decision counts and rates", () => {
  it("returns a zeroed summary for no records", () => {
    const summary = summarizeCalibration([]);
    assert.equal(summary.total, 0);
    assert.deepEqual(summary.byDecision, { accept: 0, gray_zone: 0, regenerate: 0 });
    assert.equal(summary.averageSimilarity, null);
    assert.equal(summary.maxSimilarity, null);
    assert.equal(summary.retryRate, 0);
    assert.equal(summary.skippedGateRate, 0);
  });

  it("counts records by decision", () => {
    const summary = summarizeCalibration([
      record({ decision: "accept" }),
      record({ decision: "accept" }),
      record({ decision: "gray_zone" }),
      record({ decision: "regenerate" }),
    ]);
    assert.equal(summary.total, 4);
    assert.deepEqual(summary.byDecision, { accept: 2, gray_zone: 1, regenerate: 1 });
  });

  it("computes average and max similarity over non-null similarities only", () => {
    const summary = summarizeCalibration([
      record({ topSimilarity: 0.4 }),
      record({ topSimilarity: 0.8 }),
      record({ topSimilarity: null, gateSkipped: true }), // excluded from stats
    ]);
    assert.ok(Math.abs((summary.averageSimilarity ?? 0) - 0.6) < 1e-9);
    assert.equal(summary.maxSimilarity, 0.8);
  });

  it("buckets similarities at the correct boundaries", () => {
    const summary = summarizeCalibration([
      record({ topSimilarity: 0.59 }), // <0.60
      record({ topSimilarity: 0.6 }), // 0.60-0.70
      record({ topSimilarity: 0.736 }), // 0.70-0.80 (the observed Corfu case)
      record({ topSimilarity: 0.8 }), // 0.80-0.86
      record({ topSimilarity: 0.86 }), // >=0.86
      record({ topSimilarity: 0.99 }), // >=0.86
    ]);
    assert.deepEqual(summary.buckets, {
      "<0.60": 1,
      "0.60-0.70": 1,
      "0.70-0.80": 1,
      "0.80-0.86": 1,
      ">=0.86": 2,
    });
  });

  it("computes retry rate over all records", () => {
    const summary = summarizeCalibration([
      record({ attempts: 1 }),
      record({ attempts: 2 }),
      record({ attempts: 3 }),
      record({ attempts: 1 }),
    ]);
    assert.equal(summary.retryRate, 0.5);
  });

  it("computes skipped-gate rate over all records", () => {
    const summary = summarizeCalibration([
      record({ gateSkipped: true, topSimilarity: null }),
      record({ gateSkipped: false }),
      record({ gateSkipped: false }),
      record({ gateSkipped: false }),
    ]);
    assert.equal(summary.skippedGateRate, 0.25);
  });
});

describe("getSemanticCalibrationSummary — injectable fetch", () => {
  it("summarizes whatever the injected fetch returns", async () => {
    const summary = await getSemanticCalibrationSummary(
      { companyId: "co-1" },
      { fetch: async () => [record({ decision: "gray_zone", topSimilarity: 0.83 })] }
    );
    assert.equal(summary.total, 1);
    assert.equal(summary.byDecision.gray_zone, 1);
    assert.equal(summary.buckets["0.80-0.86"], 1);
  });
});
