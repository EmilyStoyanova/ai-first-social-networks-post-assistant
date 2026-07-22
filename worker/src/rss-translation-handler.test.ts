import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadWorkerConfig } from "./config";
import { createLogger } from "./logger";
import { HandlerRegistry } from "./handler-registry";
import { JobOrchestrator } from "./orchestrator";
import {
  createRssTranslationHandler,
  toDiagnostics,
  RSS_TRANSLATION_JOB_TYPE,
} from "./rss-translation-handler";
import type { ClaimInput, EnqueueInput, FailInput, JobRecord, JobStore } from "./job-store";
import type { TranslationCronSummary } from "@/lib/services/cron/run-translation-cron.service";

// ─── Helpers ────────────────────────────────────────────────────────────────

const silentLogger = createLogger("test", () => {});
const config = loadWorkerConfig({ DATABASE_URL: "postgres://localhost/test", WORKER_ID: "w1" });

function summary(overrides: Partial<TranslationCronSummary> = {}): TranslationCronSummary {
  return {
    runId: "run-1",
    status: "completed",
    kind: "translation",
    companiesExamined: 3,
    companiesProcessed: 3,
    translated: 7,
    failed: 1,
    skipped: 2,
    remaining: 4,
    durationMs: 1234,
    timings: {
      companySelectionMs: 0,
      translationMs: 1234,
      databaseWritesMs: 0,
      cleanupMs: 0,
      totalMs: 1234,
    },
    failures: [],
    timedOut: false,
    ...overrides,
  };
}

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "j1",
    type: RSS_TRANSLATION_JOB_TYPE,
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
    const d = toDiagnostics(summary({ failures: [{ companyId: "c1", message: "boom" }] }));
    assert.deepEqual(d, {
      runId: "run-1",
      examinedCompanies: 3,
      processedCompanies: 3,
      failedCompanies: 1,
      translated: 7,
      failed: 1,
      skipped: 2,
      remaining: 4,
      durationMs: 1234,
      timedOut: false,
    });
  });
});

describe("rssTranslationHandler", () => {
  it("delegates to the existing translation service exactly once", async () => {
    let calls = 0;
    const handler = createRssTranslationHandler(async () => {
      calls++;
      return summary();
    });
    await handler({ job: job(), logger: silentLogger });
    assert.equal(calls, 1);
  });

  it("completes with diagnostics when the run succeeds", async () => {
    const handler = createRssTranslationHandler(async () => summary({ translated: 7, failed: 1 }));
    const result = await handler({ job: job(), logger: silentLogger });
    assert.deepEqual(result, toDiagnostics(summary({ translated: 7, failed: 1 })));
  });

  it("throws when the run fails at the top level (so the queue retries)", async () => {
    const handler = createRssTranslationHandler(async () =>
      summary({ status: "failed", error: "createRun failed" })
    );
    await assert.rejects(() => handler({ job: job(), logger: silentLogger }), /createRun failed/);
  });

  it("does NOT throw on isolated per-company failures (completed run)", async () => {
    // failedCompanies > 0 but the run completed — must not trigger a retry.
    const handler = createRssTranslationHandler(async () =>
      summary({ status: "completed", failures: [{ companyId: "c1", message: "boom" }] })
    );
    await assert.doesNotReject(() => handler({ job: job(), logger: silentLogger }));
  });
});

describe("rssTranslationHandler + orchestrator (queue retry behaviour)", () => {
  const registry = () =>
    new HandlerRegistry().register(
      RSS_TRANSLATION_JOB_TYPE,
      createRssTranslationHandler(async () =>
        summary({ status: "failed", error: "translation provider down" })
      )
    );

  it("a run-level failure requeues with a retry when attempts remain", async () => {
    const { store, fails, completes } = fakeJobStore();
    const orch = new JobOrchestrator({ store, registry: registry(), config, logger: silentLogger });

    await orch.process(job({ attempts: 1, maxAttempts: 5 }));

    assert.equal(completes.length, 0);
    assert.equal(fails.length, 1);
    assert.equal(fails[0].error, "translation provider down");
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
        RSS_TRANSLATION_JOB_TYPE,
        createRssTranslationHandler(async () => summary({ status: "completed" }))
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
