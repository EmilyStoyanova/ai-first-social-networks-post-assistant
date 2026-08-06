import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadWorkerConfig } from "./config";
import { createLogger } from "./logger";
import { HandlerRegistry } from "./handler-registry";
import { JobOrchestrator } from "./orchestrator";
import {
  createPostGenerationHandler,
  toDiagnostics,
  POST_GENERATION_JOB_TYPE,
} from "./post-generation-handler";
import type { ClaimInput, EnqueueInput, FailInput, JobRecord, JobStore } from "./job-store";
import type { GenerationCronSummary } from "@/lib/services/cron/run-generation-cron.service";

// ─── Helpers ────────────────────────────────────────────────────────────────

const silentLogger = createLogger("test", () => {});
const config = loadWorkerConfig({ DATABASE_URL: "postgres://localhost/test", WORKER_ID: "w1" });

function summary(overrides: Partial<GenerationCronSummary> = {}): GenerationCronSummary {
  return {
    runId: "run-1",
    status: "completed",
    kind: "generation",
    examined: 3,
    processed: 2,
    failed: 0,
    skipped: 1,
    remaining: 4,
    durationMs: 240386,
    timings: {
      companySelectionMs: 0,
      generationMs: 0,
      databaseWritesMs: 0,
      cleanupMs: 0,
      totalMs: 240386,
      weeklyGenerationMs: 0,
      llmMs: 0,
      imageMs: 0,
      approvalMs: 0,
      publishingMs: 0,
      retryMs: 0,
      backfillMs: 0,
    },
    companies: [],
    companyFailures: [],
    timedOut: false,
    ...overrides,
  };
}

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "j1",
    type: POST_GENERATION_JOB_TYPE,
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
    const d = toDiagnostics(
      summary({ companyFailures: [{ slug: "acme", message: "boom" }], failed: 1 })
    );
    assert.deepEqual(d, {
      runId: "run-1",
      examinedCompanies: 3,
      processedCompanies: 2,
      failedCompanies: 1,
      skippedCompanies: 1,
      remainingCompanies: 4,
      durationMs: 240386,
      timedOut: false,
    });
  });
});

describe("postGenerationHandler", () => {
  it("delegates to the existing generation service exactly once", async () => {
    let calls = 0;
    const handler = createPostGenerationHandler(async () => {
      calls++;
      return summary();
    });
    await handler({ job: job(), logger: silentLogger });
    assert.equal(calls, 1);
  });

  it("completes with diagnostics when the run succeeds", async () => {
    const handler = createPostGenerationHandler(async () => summary({ processed: 2, skipped: 1 }));
    const result = await handler({ job: job(), logger: silentLogger });
    assert.deepEqual(result, toDiagnostics(summary({ processed: 2, skipped: 1 })));
  });

  it("throws when the run fails at the top level (so the queue retries)", async () => {
    const handler = createPostGenerationHandler(async () =>
      summary({ status: "failed", error: "createRun failed" })
    );
    await assert.rejects(() => handler({ job: job(), logger: silentLogger }), /createRun failed/);
  });

  it("does NOT throw on isolated per-company failures (completed run)", async () => {
    // failedCompanies > 0 but the run completed — must not trigger a retry. Those
    // companies resume on the next cron tick, exactly as they did inline.
    const handler = createPostGenerationHandler(async () =>
      summary({
        status: "completed",
        failed: 1,
        companyFailures: [{ slug: "acme", message: "boom" }],
      })
    );
    await assert.doesNotReject(() => handler({ job: job(), logger: silentLogger }));
  });

  it("does NOT throw when a completed run merely timed out (resumes next run)", async () => {
    // timedOut is the normal continuation signal, not a failure — never a retry.
    const handler = createPostGenerationHandler(async () =>
      summary({ status: "completed", timedOut: true })
    );
    await assert.doesNotReject(() => handler({ job: job(), logger: silentLogger }));
  });
});

describe("postGenerationHandler + orchestrator (queue retry behaviour)", () => {
  const registry = () =>
    new HandlerRegistry().register(
      POST_GENERATION_JOB_TYPE,
      createPostGenerationHandler(async () =>
        summary({ status: "failed", error: "database unavailable" })
      )
    );

  it("a run-level failure requeues with a retry when attempts remain", async () => {
    const { store, fails, completes } = fakeJobStore();
    const orch = new JobOrchestrator({ store, registry: registry(), config, logger: silentLogger });

    await orch.process(job({ attempts: 1, maxAttempts: 5 }));

    assert.equal(completes.length, 0);
    assert.equal(fails.length, 1);
    assert.equal(fails[0].error, "database unavailable");
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
        POST_GENERATION_JOB_TYPE,
        createPostGenerationHandler(async () => summary({ status: "completed" }))
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
