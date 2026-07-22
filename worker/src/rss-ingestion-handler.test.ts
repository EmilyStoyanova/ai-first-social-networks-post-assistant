import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadWorkerConfig } from "./config";
import { createLogger } from "./logger";
import { HandlerRegistry } from "./handler-registry";
import { JobOrchestrator } from "./orchestrator";
import {
  createRssIngestionHandler,
  toDiagnostics,
  RSS_INGESTION_JOB_TYPE,
} from "./rss-ingestion-handler";
import type { ClaimInput, EnqueueInput, FailInput, JobRecord, JobStore } from "./job-store";
import type { IngestionCronSummary } from "@/lib/services/cron/run-ingestion-cron.service";

// ─── Helpers ────────────────────────────────────────────────────────────────

const silentLogger = createLogger("test", () => {});
const config = loadWorkerConfig({ DATABASE_URL: "postgres://localhost/test", WORKER_ID: "w1" });

function summary(overrides: Partial<IngestionCronSummary> = {}): IngestionCronSummary {
  return {
    runId: "run-1",
    status: "completed",
    kind: "ingestion",
    examined: 3,
    succeeded: 2,
    failed: 1,
    skipped: 0,
    remaining: 4,
    durationMs: 1234,
    timings: {
      sourceSelectionMs: 0,
      sourceIngestionMs: 0,
      databaseWritesMs: 0,
      cleanupMs: 0,
      totalMs: 1234,
    },
    itemsCreated: 5,
    itemsUpdated: 6,
    sourceFailures: [],
    timedOut: false,
    ...overrides,
  };
}

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "j1",
    type: RSS_INGESTION_JOB_TYPE,
    payload: {},
    attempts: 1,
    maxAttempts: 5,
    ...overrides,
  };
}

function fakeJobStore() {
  const completes: Array<{ id: string; result: unknown }> = [];
  const fails: FailInput[] = [];
  const store: JobStore = {
    enqueue: async (_i: EnqueueInput) => "id",
    claim: async (_i: ClaimInput) => null,
    complete: async (id, result) => {
      completes.push({ id, result });
    },
    fail: async (input) => {
      fails.push(input);
    },
    reapExpired: async () => ({ requeued: 0, failed: 0 }),
  };
  return { store, completes, fails };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("toDiagnostics", () => {
  it("maps the cron summary to compact, operator-facing diagnostics", () => {
    const d = toDiagnostics(summary());
    assert.deepEqual(d, {
      runId: "run-1",
      processedSources: 3,
      successfulSources: 2,
      failedSources: 1,
      skippedSources: 0,
      remainingSources: 4,
      itemsCreated: 5,
      itemsUpdated: 6,
      durationMs: 1234,
      timedOut: false,
    });
  });
});

describe("rssIngestionHandler", () => {
  it("delegates to the existing ingestion service exactly once", async () => {
    let calls = 0;
    const handler = createRssIngestionHandler(async () => {
      calls++;
      return summary();
    });
    await handler({ job: job(), logger: silentLogger });
    assert.equal(calls, 1);
  });

  it("completes with diagnostics when the run succeeds", async () => {
    const handler = createRssIngestionHandler(async () => summary({ succeeded: 2, failed: 1 }));
    const result = await handler({ job: job(), logger: silentLogger });
    assert.deepEqual(result, toDiagnostics(summary({ succeeded: 2, failed: 1 })));
  });

  it("throws when the run fails at the top level (so the queue retries)", async () => {
    const handler = createRssIngestionHandler(async () =>
      summary({ status: "failed", error: "createRun failed" })
    );
    await assert.rejects(() => handler({ job: job(), logger: silentLogger }), /createRun failed/);
  });

  it("does NOT throw on isolated per-source failures (completed run)", async () => {
    // failedSources > 0 but the run completed — must not trigger a retry.
    const handler = createRssIngestionHandler(async () =>
      summary({ status: "completed", failed: 2 })
    );
    await assert.doesNotReject(() => handler({ job: job(), logger: silentLogger }));
  });
});

describe("rssIngestionHandler + orchestrator (queue retry behaviour)", () => {
  const registry = () =>
    new HandlerRegistry().register(
      RSS_INGESTION_JOB_TYPE,
      createRssIngestionHandler(async () => summary({ status: "failed", error: "feed source down" }))
    );

  it("a run-level failure requeues with a retry when attempts remain", async () => {
    const { store, fails, completes } = fakeJobStore();
    const orch = new JobOrchestrator({ store, registry: registry(), config, logger: silentLogger });

    await orch.process(job({ attempts: 1, maxAttempts: 5 }));

    assert.equal(completes.length, 0);
    assert.equal(fails.length, 1);
    assert.equal(fails[0].error, "feed source down");
    assert.notEqual(fails[0].retryAt, null); // requeued for retry
  });

  it("fails terminally once attempts are exhausted", async () => {
    const { store, fails } = fakeJobStore();
    const orch = new JobOrchestrator({ store, registry: registry(), config, logger: silentLogger });

    await orch.process(job({ attempts: 5, maxAttempts: 5 }));

    assert.equal(fails.length, 1);
    assert.equal(fails[0].retryAt, null); // terminal
  });

  it("completes the job (no retry) when the run succeeds", async () => {
    const { store, completes, fails } = fakeJobStore();
    const orch = new JobOrchestrator({
      store,
      registry: new HandlerRegistry().register(
        RSS_INGESTION_JOB_TYPE,
        createRssIngestionHandler(async () => summary({ status: "completed" }))
      ),
      config,
      logger: silentLogger,
    });

    await orch.process(job());

    assert.equal(fails.length, 0);
    assert.equal(completes.length, 1);
    assert.equal((completes[0].result as { runId: string }).runId, "run-1");
  });
});
