import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "./logger";
import {
  createCompetitorIntelligenceExtractionHandler,
  COMPETITOR_INTELLIGENCE_EXTRACTION_JOB_TYPE,
} from "./competitor-intelligence-extraction-handler";
import type { CompetitorIntelligenceExtractionSummary } from "@/lib/services/competitive-analysis/run-competitor-intelligence-extraction.service";
import type { JobRecord } from "./job-store";
import type { EnqueueJobResult } from "@/lib/services/queue/enqueue-job.service";

const silentLogger = createLogger("test", () => {});

function summary(
  overrides: Partial<CompetitorIntelligenceExtractionSummary> = {}
): CompetitorIntelligenceExtractionSummary {
  return {
    runId: "run-1",
    processed: 5,
    extracted: 4,
    failed: 1,
    skipped: 0,
    skippedByReason: {},
    progressed: true,
    remainingReady: 0,
    remainingDeferred: 0,
    durationMs: 100,
    ...overrides,
  };
}

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "j1",
    type: COMPETITOR_INTELLIGENCE_EXTRACTION_JOB_TYPE,
    payload: {},
    attempts: 1,
    maxAttempts: 5,
    result: null,
    ...overrides,
  };
}

function enqueueSpy(result: Partial<EnqueueJobResult> = {}) {
  let calls = 0;
  const fn = async (): Promise<EnqueueJobResult> => {
    calls++;
    return { enqueued: true, deduplicated: false, jobId: "cont-job-1", ...result };
  };
  return { fn, calls: () => calls };
}

describe("competitorIntelligenceExtractionHandler", () => {
  it("delegates to the extraction drain exactly once and returns its summary", async () => {
    let calls = 0;
    const handler = createCompetitorIntelligenceExtractionHandler(async () => {
      calls++;
      return summary();
    });
    const result = await handler({ job: job(), logger: silentLogger });
    assert.equal(calls, 1);
    assert.deepEqual(result, summary());
  });

  it("never throws — a per-row failure is data, not a job-level fault", async () => {
    const handler = createCompetitorIntelligenceExtractionHandler(async () =>
      summary({ failed: 5, extracted: 0 })
    );
    await assert.doesNotReject(() => handler({ job: job(), logger: silentLogger }));
  });
});

describe("competitorIntelligenceExtractionHandler — self-continuation", () => {
  it("enqueues a continuation when ready rows remain AND the run made progress", async () => {
    const spy = enqueueSpy();
    const handler = createCompetitorIntelligenceExtractionHandler(
      async () => summary({ remainingReady: 12, progressed: true }),
      spy.fn
    );
    await handler({ job: job(), logger: silentLogger });
    assert.equal(spy.calls(), 1);
  });

  it("does NOT enqueue when nothing remains", async () => {
    const spy = enqueueSpy();
    const handler = createCompetitorIntelligenceExtractionHandler(
      async () => summary({ remainingReady: 0, remainingDeferred: 0, progressed: true }),
      spy.fn
    );
    await handler({ job: job(), logger: silentLogger });
    assert.equal(spy.calls(), 0);
  });

  // 2026-09 production livelock fix — see this handler's module comment.
  // This is the exact real-world shape that hot-looped: ready rows remain,
  // but the run made zero progress (every row was a no-op skip), so
  // enqueuing again immediately would just reproduce the same result forever.
  it("does NOT enqueue when ready rows remain but the run made ZERO progress", async () => {
    const spy = enqueueSpy();
    const handler = createCompetitorIntelligenceExtractionHandler(
      async () =>
        summary({
          processed: 10,
          extracted: 0,
          failed: 0,
          skipped: 10,
          skippedByReason: { claimed: 10 },
          progressed: false,
          remainingReady: 10,
          remainingDeferred: 0,
        }),
      spy.fn
    );
    await handler({ job: job(), logger: silentLogger });
    assert.equal(spy.calls(), 0);
  });

  it("does NOT enqueue when the only remaining rows are deferred behind an active lease elsewhere", async () => {
    const spy = enqueueSpy();
    const handler = createCompetitorIntelligenceExtractionHandler(
      async () => summary({ remainingReady: 0, remainingDeferred: 7, progressed: true }),
      spy.fn
    );
    await handler({ job: job(), logger: silentLogger });
    assert.equal(spy.calls(), 0);
  });

  it("swallows a continuation enqueue failure without affecting the returned summary", async () => {
    const failingEnqueue = async (): Promise<never> => {
      throw new Error("enqueue exploded");
    };
    const handler = createCompetitorIntelligenceExtractionHandler(
      async () => summary({ remainingReady: 3, progressed: true }),
      failingEnqueue
    );
    const result = await handler({ job: job(), logger: silentLogger });
    assert.deepEqual(result, summary({ remainingReady: 3, progressed: true }));
  });
});
