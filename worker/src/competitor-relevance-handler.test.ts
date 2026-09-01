import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { createLogger } from "./logger";
import {
  createCompetitorRelevanceHandler,
  defaultEnqueueRelevanceContinuation,
  COMPETITOR_RELEVANCE_JOB_TYPE,
} from "./competitor-relevance-handler";
import { competitorRelevanceDedupeKey } from "@/lib/queue/job-types";
import type { RecomputeStaleRelevanceSummary } from "@/lib/services/competitive-analysis/recompute-stale-relevance.service";
import type { JobRecord } from "./job-store";
import {
  enqueueJob,
  type EnqueueJobInput,
  type EnqueueJobResult,
  type JobInsert,
} from "@/lib/services/queue/enqueue-job.service";

const silentLogger = createLogger("test", () => {});

function summary(
  overrides: Partial<RecomputeStaleRelevanceSummary> = {}
): RecomputeStaleRelevanceSummary {
  return {
    companyId: "co-1",
    processed: 10,
    updated: 8,
    failed: 1,
    skipped: 1,
    remaining: 0,
    progressed: true,
    ...overrides,
  };
}

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "j1",
    type: COMPETITOR_RELEVANCE_JOB_TYPE,
    payload: { companyId: "co-1" },
    attempts: 1,
    maxAttempts: 5,
    result: null,
    ...overrides,
  };
}

function enqueueSpy(result: Partial<EnqueueJobResult> = {}) {
  const calls: string[] = [];
  const fn = async (companyId: string): Promise<EnqueueJobResult> => {
    calls.push(companyId);
    return { enqueued: true, deduplicated: false, jobId: "cont-job-1", ...result };
  };
  return { fn, calls };
}

describe("competitorRelevanceHandler", () => {
  it("reads companyId from the payload and delegates to the recompute service", async () => {
    let received: string | null = null;
    const handler = createCompetitorRelevanceHandler(async (companyId) => {
      received = companyId;
      return summary({ companyId });
    });
    const result = await handler({
      job: job({ payload: { companyId: "co-42" } }),
      logger: silentLogger,
    });
    assert.equal(received, "co-42");
    assert.deepEqual(result, summary({ companyId: "co-42" }));
  });

  it("skips without throwing when the payload carries no companyId", async () => {
    let calls = 0;
    const handler = createCompetitorRelevanceHandler(async () => {
      calls++;
      return summary();
    });
    const result = await handler({ job: job({ payload: {} }), logger: silentLogger });
    assert.equal(calls, 0);
    assert.deepEqual(result, { skipped: true, reason: "missing_company_id" });
  });

  it("skips without throwing when the payload is malformed (not an object)", async () => {
    const handler = createCompetitorRelevanceHandler(async () => summary());
    await assert.doesNotReject(() =>
      handler({ job: job({ payload: "not-an-object" }), logger: silentLogger })
    );
  });
});

describe("competitorRelevanceHandler — self-continuation", () => {
  it("enqueues a continuation FOR THE SAME COMPANY when rows remain", async () => {
    const spy = enqueueSpy();
    const handler = createCompetitorRelevanceHandler(async () => summary({ remaining: 7 }), spy.fn);
    await handler({ job: job({ payload: { companyId: "co-9" } }), logger: silentLogger });
    assert.deepEqual(spy.calls, ["co-9"]);
  });

  it("does NOT enqueue when nothing remains", async () => {
    const spy = enqueueSpy();
    const handler = createCompetitorRelevanceHandler(async () => summary({ remaining: 0 }), spy.fn);
    await handler({ job: job(), logger: silentLogger });
    assert.deepEqual(spy.calls, []);
  });

  // 2026-09 relevance-retry fix — the exact hot-loop this guard closes: rows
  // remain (every one is a permanently-failing row that keeps NOT resolving)
  // but this run made zero progress. Before this fix the handler enqueued a
  // continuation on `remaining > 0` alone, which would have looped forever.
  it("does NOT enqueue when rows remain but the run made zero progress — the hot-loop guard", async () => {
    const spy = enqueueSpy();
    const handler = createCompetitorRelevanceHandler(
      async () => summary({ remaining: 5, progressed: false }),
      spy.fn
    );
    await handler({ job: job(), logger: silentLogger });
    assert.deepEqual(spy.calls, []);
  });

  it("swallows a continuation enqueue failure", async () => {
    const failingEnqueue = async (): Promise<never> => {
      throw new Error("enqueue exploded");
    };
    const handler = createCompetitorRelevanceHandler(
      async () => summary({ remaining: 2 }),
      failingEnqueue
    );
    const result = await handler({ job: job(), logger: silentLogger });
    assert.deepEqual(result, summary({ remaining: 2 }));
  });
});

describe("defaultEnqueueRelevanceContinuation — dedupe-key fix (§2 verification pass)", () => {
  it("enqueues WITHOUT a dedupe key (it must not collide with the still-active parent)", async () => {
    // Reproduces the exact bug found in the verification pass: an earlier
    // version of this file passed `competitorRelevanceDedupeKey(companyId)`
    // on the continuation. Since the continuation is enqueued from INSIDE the
    // handler while the spawning job is still `active` and holds that exact
    // key, that always collided with its own parent and never actually
    // enqueued anything.
    let seen: EnqueueJobInput | undefined;
    const enqueue = (async (input: EnqueueJobInput) => {
      seen = input;
      return { enqueued: true, deduplicated: false, jobId: "job-1" };
    }) as typeof enqueueJob;

    await defaultEnqueueRelevanceContinuation("co-1", enqueue);

    assert.equal(seen?.type, COMPETITOR_RELEVANCE_JOB_TYPE);
    assert.equal(seen?.dedupeKey, undefined);
  });

  it("still enqueues even when a shared-key relevance job for the SAME company is already active", async () => {
    // Reproduces the production race precisely: a relevance job holding the
    // shared per-company dedupe key is currently active (the spawning
    // parent). Before the fix, this is exactly the scenario where the
    // continuation silently vanished.
    const companyId = "co-1";
    const key = competitorRelevanceDedupeKey(companyId);
    const active = new Set<string>([key]);
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

    // The OLD behaviour (reusing the shared key) would have deduped against
    // the active parent, exactly like this direct call does:
    const old = await enqueueJob(
      { type: COMPETITOR_RELEVANCE_JOB_TYPE, dedupeKey: key },
      { insertJob }
    );
    assert.deepEqual(old, { enqueued: false, deduplicated: true, jobId: null });

    // The FIX: the continuation carries no dedupe key, so it enqueues a real
    // follow-up even while the parent is still active.
    const result = await defaultEnqueueRelevanceContinuation(companyId, enqueue);
    assert.equal(result.enqueued, true);
    assert.equal(result.deduplicated, false);
    assert.notEqual(result.jobId, null);
  });
});
