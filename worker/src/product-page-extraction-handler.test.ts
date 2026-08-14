import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createProductPageExtractionHandler,
  toDiagnostics,
} from "./product-page-extraction-handler";
import type { PendingExtractionsSummary } from "@/lib/services/ai/run-pending-extractions.service";
import type { EnqueueJobResult } from "@/lib/services/queue/enqueue-job.service";

function summary(overrides: Partial<PendingExtractionsSummary> = {}): PendingExtractionsSummary {
  return {
    examined: 1,
    extracted: 1,
    notFound: 0,
    failed: 0,
    skipped: 0,
    remaining: 0,
    durationMs: 12,
    ...overrides,
  };
}

const job = { id: "job-1", attempts: 1 } as never;
const logger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
} as never;

const ENQUEUED: EnqueueJobResult = { enqueued: true, deduplicated: false, jobId: "job-2" };

describe("product-page extraction handler", () => {
  it("runs the drain and returns its counts as diagnostics", async () => {
    const handler = createProductPageExtractionHandler(
      async () => summary({ examined: 3, extracted: 2, notFound: 1 }),
      async () => ENQUEUED
    );

    const result = await handler({ job, logger });

    assert.deepEqual(result, toDiagnostics(summary({ examined: 3, extracted: 2, notFound: 1 })));
  });

  it("chains a continuation while work remains", async () => {
    let continuations = 0;
    const handler = createProductPageExtractionHandler(
      async () => summary({ remaining: 4 }),
      async () => {
        continuations += 1;
        return ENQUEUED;
      }
    );

    await handler({ job, logger });

    assert.equal(continuations, 1);
  });

  it("does not chain when the queue is drained", async () => {
    let continuations = 0;
    const handler = createProductPageExtractionHandler(
      async () => summary({ remaining: 0 }),
      async () => {
        continuations += 1;
        return ENQUEUED;
      }
    );

    await handler({ job, logger });

    assert.equal(continuations, 0);
  });

  it("does not chain when the run examined nothing", async () => {
    // Otherwise a backlog of items nobody can claim (all in flight) would spawn
    // job after job that changes nothing.
    let continuations = 0;
    const handler = createProductPageExtractionHandler(
      async () => summary({ examined: 0, extracted: 0, remaining: 5 }),
      async () => {
        continuations += 1;
        return ENQUEUED;
      }
    );

    await handler({ job, logger });

    assert.equal(continuations, 0);
  });

  it("does not fail a successful run when the continuation cannot be queued", async () => {
    const handler = createProductPageExtractionHandler(
      async () => summary({ remaining: 2 }),
      async () => {
        throw new Error("queue unavailable");
      }
    );

    const result = await handler({ job, logger });

    assert.equal((result as { extracted: number }).extracted, 1);
  });

  it("lets a run-level fault reach the queue's retry policy", async () => {
    const handler = createProductPageExtractionHandler(async () => {
      throw new Error("database unreachable");
    });

    await assert.rejects(() => handler({ job, logger }), /database unreachable/);
  });

  it("does not retry a run that had per-item failures — those are data", async () => {
    const handler = createProductPageExtractionHandler(
      async () => summary({ examined: 2, extracted: 1, failed: 1 }),
      async () => ENQUEUED
    );

    const result = await handler({ job, logger });

    assert.equal((result as { failed: number }).failed, 1);
  });
});
