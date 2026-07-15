import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSemanticGateReport,
  fineBucketFor,
  formatSemanticGateReport,
  getSemanticGateReport,
  TOP_ACCEPTED_LIMIT,
  type GateComparisonRecord,
} from "./semantic-gate-report.service";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function rec(overrides: Partial<GateComparisonRecord> = {}): GateComparisonRecord {
  return {
    decision: "accept",
    topSimilarity: 0.5,
    topic: "A topic",
    coreMessage: "A central claim.",
    matchedTopic: "Matched topic",
    matchedCoreMessage: "Matched claim.",
    ...overrides,
  };
}

// ─── fineBucketFor ─────────────────────────────────────────────────────────────

describe("fineBucketFor — boundaries", () => {
  it("assigns each half-open range and splits 0.70-0.80 at 0.75", () => {
    assert.equal(fineBucketFor(0.0), "<0.60");
    assert.equal(fineBucketFor(0.599), "<0.60");
    assert.equal(fineBucketFor(0.6), "0.60-0.70");
    assert.equal(fineBucketFor(0.699), "0.60-0.70");
    assert.equal(fineBucketFor(0.7), "0.70-0.75");
    assert.equal(fineBucketFor(0.749), "0.70-0.75");
    assert.equal(fineBucketFor(0.75), "0.75-0.80");
    assert.equal(fineBucketFor(0.799), "0.75-0.80");
    assert.equal(fineBucketFor(0.8), "0.80-0.86");
    assert.equal(fineBucketFor(0.859), "0.80-0.86");
    assert.equal(fineBucketFor(0.86), ">=0.86");
    assert.equal(fineBucketFor(1.0), ">=0.86");
  });
});

// ─── buildSemanticGateReport ───────────────────────────────────────────────────

describe("buildSemanticGateReport — aggregates", () => {
  it("counts records, comparisons, average, max, and buckets", () => {
    const report = buildSemanticGateReport([
      rec({ topSimilarity: 0.55 }),
      rec({ topSimilarity: 0.78 }),
      rec({ decision: "gray_zone", topSimilarity: 0.82 }),
      rec({ decision: "regenerate", topSimilarity: 0.9 }),
      // Skipped / no-history rows have no similarity and are excluded from stats.
      rec({ topSimilarity: null }),
    ]);

    assert.equal(report.totalRecords, 5);
    assert.equal(report.totalComparisons, 4);
    assert.equal(report.maxSimilarity, 0.9);
    assert.ok(Math.abs(report.averageSimilarity! - (0.55 + 0.78 + 0.82 + 0.9) / 4) < 1e-9);
    assert.deepEqual(report.buckets, {
      "<0.60": 1,
      "0.60-0.70": 0,
      "0.70-0.75": 0,
      "0.75-0.80": 1,
      "0.80-0.86": 1,
      ">=0.86": 1,
    });
  });

  it("returns null stats and zero buckets when there are no comparisons", () => {
    const report = buildSemanticGateReport([rec({ topSimilarity: null })]);
    assert.equal(report.totalRecords, 1);
    assert.equal(report.totalComparisons, 0);
    assert.equal(report.averageSimilarity, null);
    assert.equal(report.maxSimilarity, null);
    assert.equal(report.topAccepted.length, 0);
  });
});

describe("buildSemanticGateReport — top accepted", () => {
  it("includes only decision=accept, sorted by similarity descending", () => {
    const report = buildSemanticGateReport([
      rec({ decision: "accept", topSimilarity: 0.72, coreMessage: "mid" }),
      rec({ decision: "gray_zone", topSimilarity: 0.83, coreMessage: "gray — excluded" }),
      rec({ decision: "accept", topSimilarity: 0.79, coreMessage: "high" }),
      rec({ decision: "regenerate", topSimilarity: 0.91, coreMessage: "regen — excluded" }),
      rec({ decision: "accept", topSimilarity: 0.61, coreMessage: "low" }),
    ]);

    assert.deepEqual(
      report.topAccepted.map((s) => s.coreMessage),
      ["high", "mid", "low"]
    );
    assert.equal(report.topAccepted[0].similarity, 0.79);
    assert.equal(report.topAccepted[0].matchedCoreMessage, "Matched claim.");
  });

  it(`caps the accepted samples at TOP_ACCEPTED_LIMIT (${TOP_ACCEPTED_LIMIT})`, () => {
    const many: GateComparisonRecord[] = Array.from({ length: 30 }, (_, i) =>
      rec({ decision: "accept", topSimilarity: 0.5 + i * 0.001 })
    );
    const report = buildSemanticGateReport(many);
    assert.equal(report.topAccepted.length, TOP_ACCEPTED_LIMIT);
    // Highest similarity first.
    assert.equal(report.topAccepted[0].similarity, 0.5 + 29 * 0.001);
  });
});

// ─── getSemanticGateReport (injectable fetch) ──────────────────────────────────

describe("getSemanticGateReport — injectable fetch", () => {
  it("builds the report from whatever the injected fetch returns", async () => {
    let capturedLimit: number | undefined = -1;
    const report = await getSemanticGateReport(
      { limit: 42 },
      {
        fetch: async (filter) => {
          capturedLimit = filter.limit;
          return [rec({ topSimilarity: 0.77 }), rec({ topSimilarity: 0.5 })];
        },
      }
    );

    assert.equal(capturedLimit, 42);
    assert.equal(report.totalComparisons, 2);
    assert.equal(report.maxSimilarity, 0.77);
  });
});

// ─── formatSemanticGateReport ──────────────────────────────────────────────────

describe("formatSemanticGateReport — output", () => {
  it("renders the headline stats, buckets, and a non-mutating statistics note", () => {
    const report = buildSemanticGateReport([
      rec({
        decision: "accept",
        topSimilarity: 0.78,
        topic: "Beaches",
        coreMessage: "Shallow bays.",
      }),
      rec({ decision: "gray_zone", topSimilarity: 0.83 }),
    ]);
    const out = formatSemanticGateReport(report);

    assert.match(out, /Semantic Gate Calibration Report/);
    assert.match(out, /Total comparisons:\s+2/);
    assert.match(out, /Max similarity:\s+0\.8300/);
    assert.match(out, /0\.75-0\.80\s*:\s+1/);
    assert.match(out, /0\.80-0\.86\s*:\s+1/);
    // The top accepted table shows the accepted sample, not the gray-zone one.
    assert.match(out, /Shallow bays\./);
    // Thresholds are reported, never changed.
    assert.match(out, /no thresholds changed/i);
    assert.match(out, /gray zone ≥ 0\.8, regenerate ≥ 0\.86 \(unchanged\)/);
  });

  it("handles an empty report without throwing", () => {
    const out = formatSemanticGateReport(buildSemanticGateReport([]));
    assert.match(out, /Total comparisons:\s+0/);
    assert.match(out, /Average similarity:\s+n\/a/);
    assert.match(out, /\(none\)/);
  });
});
