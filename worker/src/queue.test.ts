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
} from "./job-store";
import type { WorkerLifecycle } from "./store";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const silentLogger = createLogger("test", () => {});
const baseEnv: Record<string, string | undefined> = {
  DATABASE_URL: "postgres://localhost/test",
};
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function makeConfig(overrides: Record<string, string | undefined> = {}) {
  return loadWorkerConfig({ ...baseEnv, WORKER_ID: "w1", WORKER_LEASE_TTL_MS: "1000", ...overrides });
}

function fakeJobStore(queued: JobRecord[] = []) {
  const claims: ClaimInput[] = [];
  const completes: Array<{ id: string; result: unknown; now: Date }> = [];
  const fails: FailInput[] = [];
  const enqueues: EnqueueInput[] = [];
  let reap: ReapResult = { requeued: 0, failed: 0 };
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
    complete: async (id, result, now) => {
      completes.push({ id, result, now });
    },
    fail: async (input) => {
      fails.push(input);
    },
    reapExpired: async () => reap,
  };

  return { store, claims, completes, fails, enqueues, setReap: (r: ReapResult) => (reap = r) };
}

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return { id: "j1", type: DUMMY_JOB_TYPE, payload: { a: 1 }, attempts: 1, maxAttempts: 5, ...overrides };
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
    const res = await dummyHandler({ job: job({ payload: { hello: "world" } }), logger: silentLogger });
    assert.deepEqual((res as { echoed: unknown }).echoed, { hello: "world" });
  });

  it("throws when payload.fail is set", async () => {
    await assert.rejects(
      () => dummyHandler({ job: job({ payload: { fail: true } }), logger: silentLogger }),
      /forced failure/,
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
