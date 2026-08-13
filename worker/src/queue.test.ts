import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadWorkerConfig } from "./config";
import { createLogger } from "./logger";
import { computeBackoffMs } from "./backoff";
import { HandlerRegistry, type JobHandler } from "./handler-registry";
import { dummyHandler, DUMMY_JOB_TYPE } from "./dummy-handler";
import { JobOrchestrator } from "./orchestrator";
import { PollingRunner } from "./runner";
import type {
  ClaimInput,
  EnqueueInput,
  FailInput,
  JobRecord,
  JobStore,
  ReapResult,
  RenewLeaseInput,
  SaveProgressInput,
} from "./job-store";
import type { WorkerLifecycle } from "./store";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const silentLogger = createLogger("test", () => {});
const baseEnv: Record<string, string | undefined> = {
  DATABASE_URL: "postgres://localhost/test",
};
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function makeConfig(overrides: Record<string, string | undefined> = {}) {
  return loadWorkerConfig({
    ...baseEnv,
    WORKER_ID: "w1",
    WORKER_LEASE_TTL_MS: "1000",
    ...overrides,
  });
}

function fakeJobStore(queued: JobRecord[] = []) {
  const claims: ClaimInput[] = [];
  const completes: Array<{ id: string; result: unknown; now: Date }> = [];
  const fails: FailInput[] = [];
  const enqueues: EnqueueInput[] = [];
  const renewals: RenewLeaseInput[] = [];
  const progress: SaveProgressInput[] = [];
  let reap: ReapResult = { requeued: 0, failed: 0 };
  // Whether the fake still "belongs" to the renewing worker — flipped by a test
  // to simulate the reaper having taken the job away mid-run.
  let held = true;
  let renewThrows = false;
  const pending = [...queued];

  const store: JobStore = {
    enqueue: async (input) => {
      enqueues.push(input);
      return "job-id";
    },
    claim: async (input) => {
      claims.push(input);
      return pending.shift() ?? null;
    },
    renewLease: async (input) => {
      renewals.push(input);
      if (renewThrows) throw new Error("db down");
      return held;
    },
    saveProgress: async (input) => {
      progress.push(input);
      return held;
    },
    complete: async (id, result, now) => {
      completes.push({ id, result, now });
    },
    fail: async (input) => {
      fails.push(input);
    },
    reapExpired: async () => reap,
  };

  return {
    store,
    claims,
    completes,
    fails,
    enqueues,
    renewals,
    progress,
    setReap: (r: ReapResult) => (reap = r),
    loseLease: () => (held = false),
    breakRenewal: () => (renewThrows = true),
  };
}

/**
 * A renewal scheduler a test drives by hand. `scheduleRenewal` is injected with
 * this instead of a real timer so "the lease is renewed while the handler runs"
 * is asserted deterministically rather than by sleeping past an interval.
 */
function manualRenewalScheduler() {
  let tick: (() => void) | null = null;
  let intervalMs = 0;
  let cancelled = false;
  return {
    intervalMs: () => intervalMs,
    cancelled: () => cancelled,
    fire: () => tick?.(),
    schedule: (ms: number, fn: () => void) => {
      intervalMs = ms;
      tick = fn;
      return () => {
        cancelled = true;
      };
    },
  };
}

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "j1",
    type: DUMMY_JOB_TYPE,
    payload: { a: 1 },
    attempts: 1,
    maxAttempts: 5,
    result: null,
    ...overrides,
  };
}

// ─── Backoff ──────────────────────────────────────────────────────────────────

describe("computeBackoffMs", () => {
  const noJitter = { jitter: 0, random: () => 0.5 };

  it("grows exponentially from baseMs", () => {
    assert.equal(computeBackoffMs(1, { baseMs: 1000, ...noJitter }), 1000);
    assert.equal(computeBackoffMs(2, { baseMs: 1000, ...noJitter }), 2000);
    assert.equal(computeBackoffMs(3, { baseMs: 1000, ...noJitter }), 4000);
  });

  it("caps at maxMs", () => {
    assert.equal(computeBackoffMs(20, { baseMs: 1000, maxMs: 5000, ...noJitter }), 5000);
  });

  it("never returns a negative delay even with adverse jitter", () => {
    assert.ok(computeBackoffMs(1, { baseMs: 1000, jitter: 1, random: () => 0 }) >= 0);
  });
});

// ─── Handler registry ─────────────────────────────────────────────────────────

describe("HandlerRegistry", () => {
  it("registers and resolves a handler", () => {
    const h: JobHandler = async () => ({ ok: true });
    const reg = new HandlerRegistry().register("t", h);
    assert.equal(reg.get("t"), h);
    assert.equal(reg.get("missing"), undefined);
    assert.deepEqual(reg.types(), ["t"]);
  });

  it("rejects a duplicate registration", () => {
    const reg = new HandlerRegistry().register("t", async () => {});
    assert.throws(() => reg.register("t", async () => {}), /already registered/);
  });
});

// ─── Dummy handler ──────────────────────────────────────────────────────────

describe("dummyHandler", () => {
  it("echoes the payload", async () => {
    const res = await dummyHandler({
      job: job({ payload: { hello: "world" } }),
      logger: silentLogger,
    });
    assert.deepEqual((res as { echoed: unknown }).echoed, { hello: "world" });
  });

  it("throws when payload.fail is set", async () => {
    await assert.rejects(
      () => dummyHandler({ job: job({ payload: { fail: true } }), logger: silentLogger }),
      /forced failure/
    );
  });
});

// ─── Orchestrator ─────────────────────────────────────────────────────────────

describe("JobOrchestrator", () => {
  const fixedNow = new Date("2026-07-22T00:00:00.000Z");

  it("claim leases with now + leaseTtlMs and this worker's id", async () => {
    const { store, claims } = fakeJobStore([job()]);
    const orch = new JobOrchestrator({
      store,
      registry: new HandlerRegistry().register(DUMMY_JOB_TYPE, dummyHandler),
      config: makeConfig(),
      logger: silentLogger,
      now: () => fixedNow,
    });

    const claimed = await orch.claim();
    assert.equal(claimed?.id, "j1");
    assert.equal(claims[0].workerId, "w1");
    assert.deepEqual(claims[0].now, fixedNow);
    assert.equal(claims[0].leaseExpiresAt.getTime(), fixedNow.getTime() + 1000);
  });

  it("completes a job with the handler's result", async () => {
    const { store, completes, fails } = fakeJobStore();
    const orch = new JobOrchestrator({
      store,
      registry: new HandlerRegistry().register("t", async () => ({ done: true })),
      config: makeConfig(),
      logger: silentLogger,
      now: () => fixedNow,
    });

    await orch.process(job({ type: "t" }));
    assert.equal(fails.length, 0);
    assert.equal(completes.length, 1);
    assert.deepEqual(completes[0].result, { done: true });
  });

  it("fails terminally (no retry) for an unknown job type", async () => {
    const { store, fails, completes } = fakeJobStore();
    const orch = new JobOrchestrator({
      store,
      registry: new HandlerRegistry(),
      config: makeConfig(),
      logger: silentLogger,
      now: () => fixedNow,
    });

    await orch.process(job({ type: "nope" }));
    assert.equal(completes.length, 0);
    assert.equal(fails.length, 1);
    assert.equal(fails[0].retryAt, null);
    assert.match(fails[0].error, /No handler registered/);
  });

  it("requeues with backoff when a retryable attempt fails", async () => {
    const { store, fails } = fakeJobStore();
    const orch = new JobOrchestrator({
      store,
      registry: new HandlerRegistry().register("t", async () => {
        throw new Error("boom");
      }),
      config: makeConfig(),
      logger: silentLogger,
      now: () => fixedNow,
      backoff: { baseMs: 1000, jitter: 0, random: () => 0.5 },
    });

    await orch.process(job({ type: "t", attempts: 2, maxAttempts: 5 }));
    assert.equal(fails.length, 1);
    assert.equal(fails[0].error, "boom");
    // attempt 2 → 1000 * 2^(2-1) = 2000ms
    assert.equal(fails[0].retryAt?.getTime(), fixedNow.getTime() + 2000);
  });

  it("fails terminally when attempts are exhausted", async () => {
    const { store, fails } = fakeJobStore();
    const orch = new JobOrchestrator({
      store,
      registry: new HandlerRegistry().register("t", async () => {
        throw new Error("boom");
      }),
      config: makeConfig(),
      logger: silentLogger,
      now: () => fixedNow,
    });

    await orch.process(job({ type: "t", attempts: 5, maxAttempts: 5 }));
    assert.equal(fails.length, 1);
    assert.equal(fails[0].retryAt, null);
  });

  // ── Lease renewal ────────────────────────────────────────────────────────
  // Verified in production before this existed: `rss-translation` jobs finished
  // carrying `last_error = "lease expired — requeued by reaper"` with attempts 2
  // and 3 — the reaper had requeued them mid-run and they were executed twice.

  it("renews the lease while the handler is still running", async () => {
    const { store, renewals } = fakeJobStore();
    const timer = manualRenewalScheduler();
    let released!: () => void;
    const handlerDone = new Promise<void>((resolve) => (released = resolve));

    const orch = new JobOrchestrator({
      store,
      registry: new HandlerRegistry().register("t", async () => {
        await handlerDone;
        return { ok: true };
      }),
      config: makeConfig({ WORKER_LEASE_TTL_MS: "9000" }),
      logger: silentLogger,
      now: () => fixedNow,
      scheduleRenewal: timer.schedule,
    });

    const running = orch.process(job({ type: "t" }));
    timer.fire();
    timer.fire();
    // Let the renewal promises settle before the handler resolves.
    await delay(5);
    released();
    await running;

    assert.equal(renewals.length, 2);
    assert.equal(renewals[0].id, "j1");
    assert.equal(renewals[0].workerId, "w1");
    // now + full TTL each time, not the remaining slice.
    assert.equal(renewals[0].leaseExpiresAt.getTime(), fixedNow.getTime() + 9000);
  });

  it("renews at a third of the lease TTL", async () => {
    const { store } = fakeJobStore();
    const timer = manualRenewalScheduler();
    const orch = new JobOrchestrator({
      store,
      registry: new HandlerRegistry().register("t", async () => ({})),
      config: makeConfig({ WORKER_LEASE_TTL_MS: "600000" }),
      logger: silentLogger,
      scheduleRenewal: timer.schedule,
    });

    await orch.process(job({ type: "t" }));
    assert.equal(timer.intervalMs(), 200_000);
  });

  it("never renews faster than the floor, however short the TTL", async () => {
    const { store } = fakeJobStore();
    const timer = manualRenewalScheduler();
    const orch = new JobOrchestrator({
      store,
      registry: new HandlerRegistry().register("t", async () => ({})),
      config: makeConfig({ WORKER_LEASE_TTL_MS: "300" }),
      logger: silentLogger,
      scheduleRenewal: timer.schedule,
    });

    await orch.process(job({ type: "t" }));
    assert.equal(timer.intervalMs(), 1_000);
  });

  it("stops renewing once the lease is lost, instead of taking it back", async () => {
    const { store, renewals, loseLease } = fakeJobStore();
    const timer = manualRenewalScheduler();
    let released!: () => void;
    const handlerDone = new Promise<void>((resolve) => (released = resolve));

    const orch = new JobOrchestrator({
      store,
      registry: new HandlerRegistry().register("t", async () => {
        await handlerDone;
      }),
      config: makeConfig(),
      logger: silentLogger,
      scheduleRenewal: timer.schedule,
    });

    const running = orch.process(job({ type: "t" }));
    loseLease();
    timer.fire();
    await delay(5);
    // Further ticks must be no-ops — the job belongs to another attempt now.
    timer.fire();
    timer.fire();
    await delay(5);

    // Asserted while the handler is STILL running: the loop must cancel itself
    // on the lost lease, not merely be cancelled by process()'s finally block.
    assert.ok(timer.cancelled(), "renewal loop should have cancelled itself");
    assert.equal(renewals.length, 1);

    released();
    await running;
  });

  it("keeps renewing when one renewal round trip throws", async () => {
    const { store, renewals, breakRenewal } = fakeJobStore();
    const timer = manualRenewalScheduler();
    let released!: () => void;
    const handlerDone = new Promise<void>((resolve) => (released = resolve));

    const orch = new JobOrchestrator({
      store,
      registry: new HandlerRegistry().register("t", async () => {
        await handlerDone;
      }),
      config: makeConfig(),
      logger: silentLogger,
      scheduleRenewal: timer.schedule,
    });

    const running = orch.process(job({ type: "t" }));
    breakRenewal();
    timer.fire();
    await delay(5);
    timer.fire();
    await delay(5);

    // Asserted before the handler finishes, since process() cancels on the way
    // out either way. A transient database error is not "the lease is gone",
    // so the loop must still be alive here.
    assert.equal(renewals.length, 2);
    assert.equal(timer.cancelled(), false);

    released();
    await running;
  });

  it("cancels renewal when the handler finishes, and when it throws", async () => {
    for (const throws of [false, true]) {
      const { store } = fakeJobStore();
      const timer = manualRenewalScheduler();
      const orch = new JobOrchestrator({
        store,
        registry: new HandlerRegistry().register("t", async () => {
          if (throws) throw new Error("boom");
          return {};
        }),
        config: makeConfig(),
        logger: silentLogger,
        scheduleRenewal: timer.schedule,
      });

      await orch.process(job({ type: "t" }));
      assert.ok(timer.cancelled(), `renewal not cancelled (handler threw: ${throws})`);
    }
  });

  // ── Progress ─────────────────────────────────────────────────────────────

  it("passes reportProgress to the handler and guards it with the worker id", async () => {
    const { store, progress } = fakeJobStore();
    const orch = new JobOrchestrator({
      store,
      registry: new HandlerRegistry().register("t", async (ctx) => {
        await ctx.reportProgress?.({ phase: "running", generated: 2 });
        return { phase: "done", generated: 5 };
      }),
      config: makeConfig(),
      logger: silentLogger,
    });

    await orch.process(job({ type: "t" }));

    assert.equal(progress.length, 1);
    assert.equal(progress[0].id, "j1");
    assert.equal(progress[0].workerId, "w1");
    assert.deepEqual(progress[0].progress, { phase: "running", generated: 2 });
  });

  it("a rejected progress write neither throws nor fails the job", async () => {
    const { store, completes, fails, loseLease } = fakeJobStore();
    loseLease();
    const orch = new JobOrchestrator({
      store,
      registry: new HandlerRegistry().register("t", async (ctx) => {
        await ctx.reportProgress?.({ phase: "running" });
        return { phase: "done" };
      }),
      config: makeConfig(),
      logger: silentLogger,
    });

    await orch.process(job({ type: "t" }));

    assert.equal(fails.length, 0);
    assert.equal(completes.length, 1);
    assert.deepEqual(completes[0].result, { phase: "done" });
  });

  it("a throwing progress write is swallowed", async () => {
    const { completes, fails } = fakeJobStore();
    const throwingStore: JobStore = {
      enqueue: async () => "id",
      claim: async () => null,
      renewLease: async () => true,
      saveProgress: async () => {
        throw new Error("db down");
      },
      complete: async (id, result, now) => {
        completes.push({ id, result, now });
      },
      fail: async (input) => {
        fails.push(input);
      },
      reapExpired: async () => ({ requeued: 0, failed: 0 }),
    };

    const orch = new JobOrchestrator({
      store: throwingStore,
      registry: new HandlerRegistry().register("t", async (ctx) => {
        await ctx.reportProgress?.({ phase: "running" });
        return { phase: "done" };
      }),
      config: makeConfig(),
      logger: silentLogger,
    });

    await orch.process(job({ type: "t" }));
    assert.equal(fails.length, 0);
    assert.equal(completes.length, 1);
  });

  it("reapOnce returns the store's counts", async () => {
    const { store, setReap } = fakeJobStore();
    setReap({ requeued: 2, failed: 1 });
    const orch = new JobOrchestrator({
      store,
      registry: new HandlerRegistry(),
      config: makeConfig(),
      logger: silentLogger,
    });
    assert.deepEqual(await orch.reapOnce(), { requeued: 2, failed: 1 });
  });
});

// ─── Runner + orchestrator integration ─────────────────────────────────────────

describe("PollingRunner with the orchestrator", () => {
  function statusSink() {
    const transitions: WorkerLifecycle[] = [];
    return {
      transitions,
      setStatus: async (status: WorkerLifecycle) => {
        transitions.push(status);
      },
    };
  }

  it("claims a job, runs it to completion, and returns to idle", async () => {
    const { store, completes } = fakeJobStore([job({ type: DUMMY_JOB_TYPE })]);
    const orch = new JobOrchestrator({
      store,
      registry: new HandlerRegistry().register(DUMMY_JOB_TYPE, dummyHandler),
      config: makeConfig({ WORKER_POLL_INTERVAL_MS: "20" }),
      logger: silentLogger,
    });
    const sink = statusSink();

    const runner = new PollingRunner<JobRecord>({
      config: makeConfig({ WORKER_POLL_INTERVAL_MS: "20" }),
      logger: silentLogger,
      registry: sink,
      claim: () => orch.claim(),
      processJob: (j) => orch.process(j),
    });

    runner.start();
    // give it enough to claim (once) + process + go idle, then poll empty
    while (completes.length === 0) await delay(5);
    await runner.stop();

    assert.equal(completes.length, 1);
    assert.equal(completes[0].id, "j1");
    assert.equal(sink.transitions[0], "idle");
    assert.ok(sink.transitions.includes("busy"));
    assert.equal(runner.isRunning(), false);
  });
});
