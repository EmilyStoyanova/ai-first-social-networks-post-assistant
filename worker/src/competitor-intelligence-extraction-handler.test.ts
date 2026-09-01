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
    remaining: 0,
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
  it("enqueues a continuation when rows remain", async () => {
    const spy = enqueueSpy();
    const handler = createCompetitorIntelligenceExtractionHandler(
      async () => summary({ remaining: 12 }),
      spy.fn
    );
    await handler({ job: job(), logger: silentLogger });
    assert.equal(spy.calls(), 1);
  });

  it("does NOT enqueue when nothing remains", async () => {
    const spy = enqueueSpy();
    const handler = createCompetitorIntelligenceExtractionHandler(
      async () => summary({ remaining: 0 }),
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
      async () => summary({ remaining: 3 }),
      failingEnqueue
    );
    const result = await handler({ job: job(), logger: silentLogger });
    assert.deepEqual(result, summary({ remaining: 3 }));
  });
});
