import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";

import { loadWorkerConfig } from "./config";
import { createLogger } from "./logger";
import { HandlerRegistry } from "./handler-registry";
import { JobOrchestrator } from "./orchestrator";
import {
  createRssTranslationHandler,
  defaultEnqueueTranslationContinuation,
  toDiagnostics,
  RSS_TRANSLATION_JOB_TYPE,
} from "./rss-translation-handler";
import { RSS_TRANSLATION_DEDUPE_KEY } from "@/lib/queue/job-types";
import {
  enqueueJob,
  type EnqueueJobInput,
  type JobInsert,
} from "@/lib/services/queue/enqueue-job.service";
import type { ClaimInput, EnqueueInput, FailInput, JobRecord, JobStore } from "./job-store";
import type { TranslationCronSummary } from "@/lib/services/cron/run-translation-cron.service";
import type { EnqueueJobResult } from "@/lib/services/queue/enqueue-job.service";

// ─── Helpers ────────────────────────────────────────────────────────────────

const silentLogger = createLogger("test", () => {});
const config = loadWorkerConfig({ DATABASE_URL: "postgres://localhost/test", WORKER_ID: "w1" });

/** A continuation-enqueue spy that records calls and returns a canned result. */
function enqueueSpy(result: Partial<EnqueueJobResult> = {}) {
  let calls = 0;
  const fn = async (): Promise<EnqueueJobResult> => {
    calls++;
    return { enqueued: true, deduplicated: false, jobId: "cont-job-1", ...result };
  };
  return { fn, calls: () => calls };
}

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
    result: null,
    ...overrides,
  };
}

function fakeJobStore() {
  const completes: Array<{ id: string; result: unknown }> = [];
  const fails: FailInput[] = [];
  const store: JobStore = {
    enqueue: async (_i: EnqueueInput) => "id",
    claim: async (_i: ClaimInput) => null,
    renewLease: async () => true,
    saveProgress: async () => true,
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

describe("rssTranslationHandler — self-continuation follow-up", () => {
  it("enqueues one continuation job when the run left work remaining", async () => {
    const spy = enqueueSpy();
    const handler = createRssTranslationHandler(async () => summary({ remaining: 16 }), spy.fn);
    await handler({ job: job(), logger: silentLogger });
    assert.equal(spy.calls(), 1);
  });

  it("does NOT enqueue when nothing remains (remaining === 0)", async () => {
    const spy = enqueueSpy();
    const handler = createRssTranslationHandler(async () => summary({ remaining: 0 }), spy.fn);
    await handler({ job: job(), logger: silentLogger });
    assert.equal(spy.calls(), 0);
  });

  it("does NOT enqueue when the run failed at the top level (throws first)", async () => {
    const spy = enqueueSpy();
    const handler = createRssTranslationHandler(
      // remaining > 0 but the run failed — the throw happens before the continuation.
      async () => summary({ status: "failed", error: "boom", remaining: 9 }),
      spy.fn
    );
    await assert.rejects(() => handler({ job: job(), logger: silentLogger }), /boom/);
    assert.equal(spy.calls(), 0);
  });

  it("still returns unchanged diagnostics and does NOT throw when the continuation enqueue fails", async () => {
    const failingEnqueue = async (): Promise<never> => {
      throw new Error("enqueue exploded");
    };
    const handler = createRssTranslationHandler(
      async () => summary({ remaining: 5 }),
      failingEnqueue
    );
    const result = await handler({ job: job(), logger: silentLogger });
    // Best-effort: a swallowed enqueue failure must not fail the successful run, and the
    // translation diagnostics contract is unchanged.
    assert.deepEqual(result, toDiagnostics(summary({ remaining: 5 })));
  });

  it("a deduplicated continuation is a success (no throw, diagnostics intact)", async () => {
    const spy = enqueueSpy({ enqueued: false, deduplicated: true, jobId: null });
    const handler = createRssTranslationHandler(async () => summary({ remaining: 3 }), spy.fn);
    const result = await handler({ job: job(), logger: silentLogger });
    assert.equal(spy.calls(), 1);
    assert.deepEqual(result, toDiagnostics(summary({ remaining: 3 })));
  });
});

describe("defaultEnqueueTranslationContinuation — dedupe-key fix", () => {
  it("enqueues WITHOUT a dedupe key (it must not collide with the still-active parent)", async () => {
    // The continuation is enqueued from inside the handler while the spawning job is still
    // `active` and holds the shared key. Passing that key would dedupe against the parent
    // and never enqueue — so the production input must carry no dedupeKey at all.
    let seen: EnqueueJobInput | undefined;
    const enqueue = (async (input: EnqueueJobInput) => {
      seen = input;
      return { enqueued: true, deduplicated: false, jobId: "job-1" };
    }) as typeof enqueueJob;

    await defaultEnqueueTranslationContinuation(enqueue);

    assert.equal(seen?.type, RSS_TRANSLATION_JOB_TYPE);
    assert.equal(seen?.dedupeKey, undefined);
  });

  it("still enqueues even when a shared-key translation job is already active", async () => {
    // Reproduce the exact production state: a translation job holding the shared dedupe key
    // is currently active (the spawning parent). The partial unique index blocks a second
    // active/queued row for that key.
    const active = new Set<string>([RSS_TRANSLATION_DEDUPE_KEY]);
    let seq = 0;
    const insertJob = async (data: JobInsert): Promise<{ id: string }> => {
      if (data.dedupeKey !== null && active.has(data.dedupeKey)) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "test",
          meta: { target: "jobs_dedupe_active_key" },
        });
      }
      if (data.dedupeKey !== null) active.add(data.dedupeKey);
      return { id: `job-${++seq}` };
    };
    const enqueue = ((input: EnqueueJobInput) =>
      enqueueJob(input, { insertJob })) as typeof enqueueJob;

    // The OLD behaviour (reusing the shared key) would have deduped against the active parent.
    const old = await enqueueJob(
      { type: RSS_TRANSLATION_JOB_TYPE, dedupeKey: RSS_TRANSLATION_DEDUPE_KEY },
      { insertJob }
    );
    assert.deepEqual(old, { enqueued: false, deduplicated: true, jobId: null });

    // The FIX: the continuation carries no dedupe key, so it enqueues a real follow-up.
    const result = await defaultEnqueueTranslationContinuation(enqueue);
    assert.equal(result.enqueued, true);
    assert.equal(result.deduplicated, false);
    assert.notEqual(result.jobId, null);
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
