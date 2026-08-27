/**
 * Regression suite for the dormant worker that could not be woken.
 *
 * The bug these exist for: `becomeDormant` awaited the disconnect hook BEFORE
 * constructing the wait that arms the fallback timer and subscribes to the wake
 * latch. `prisma.$disconnect()` ends the Neon pool, whose `end()` resolves only
 * once every checked-out client is released — a client leaked by a socket that
 * died mid-query never is — so a hung disconnect left the worker with no timer
 * and no listener. It logged `dormant` and then nothing, for as long as the
 * process lived, and only a restart recovered it.
 *
 * So the assertion running through most of what follows is deliberately about
 * ORDER rather than outcome: while the dormant hook is still hanging, the latch
 * must ALREADY have a subscriber. An outcome test would pass on a version that
 * merely got lucky with timing; that one only passes if the arming genuinely
 * happens first.
 *
 * Timings are milliseconds rather than minutes — the RATIOS are production's,
 * only the magnitudes shrink — so a full ACTIVE → DORMANT → wake → ACTIVE cycle
 * fits inside a test instead of inside half an hour.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadWorkerConfig } from "./config";
import { createLogger } from "./logger";
import { WakeSignal } from "./wake-signal";
import { PollingRunner, type ClaimedJob, type WakeReason } from "./runner";
import { JobOrchestrator } from "./orchestrator";
import { HandlerRegistry } from "./handler-registry";
import type { JobRecord, JobStore } from "./job-store";
import type { WorkerLifecycle } from "./store";
import { enqueueJob } from "@/lib/services/queue/enqueue-job.service";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Captures every line so tests can assert on the diagnostics, not just behaviour. */
function capturingLogger() {
  const lines: Array<{ level: string; msg: string; meta?: Record<string, unknown> }> = [];
  const logger = createLogger("test", (line) => {
    const parsed = JSON.parse(line) as {
      level: string;
      msg: string;
      meta?: Record<string, unknown>;
    };
    lines.push(parsed);
  });
  return {
    logger,
    lines,
    has: (msg: string) => lines.some((l) => l.msg === msg),
    find: (msg: string) => lines.find((l) => l.msg === msg),
  };
}

function wakeConfig(overrides: Record<string, string | undefined> = {}) {
  return loadWorkerConfig({
    DATABASE_URL: "postgres://localhost/test",
    WORKER_ID: "w-wake",
    WORKER_POLL_INTERVAL_MS: "5",
    WORKER_DORMANT_AFTER_MS: "40",
    WORKER_FALLBACK_POLL_MS: "10000",
    WORKER_DORMANT_CLEANUP_TIMEOUT_MS: "60",
    ...overrides,
  });
}

function fakeStatusSink() {
  const transitions: WorkerLifecycle[] = [];
  return {
    transitions,
    setStatus: async (status: WorkerLifecycle) => {
      transitions.push(status);
    },
  };
}

/** A claim seam that counts every call — the counter IS the Neon activity graph. */
function countingClaim(queue: ClaimedJob[] = []) {
  const pending = [...queue];
  let calls = 0;
  return {
    calls: () => calls,
    push: (...jobs: ClaimedJob[]) => pending.push(...jobs),
    claim: async (): Promise<ClaimedJob | null> => {
      calls += 1;
      return pending.shift() ?? null;
    },
  };
}

/** A dormant hook that never settles, and a handle on whether it was entered. */
function hangingDormantHook() {
  let entered = false;
  return {
    entered: () => entered,
    onDormant: () =>
      new Promise<void>(() => {
        entered = true;
        // Never resolves. This is `Pool.end()` waiting on a leaked client.
      }),
  };
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2_000,
  label = "condition"
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(2);
  }
  assert.fail(`timed out waiting for ${label}`);
}

// ─── The root cause ───────────────────────────────────────────────────────────

describe("dormant transition ordering", () => {
  it("arms the wake subscription BEFORE the dormant hook is awaited", async () => {
    // The sharpest statement of the bug. With a hook that never settles, the old
    // code had subscribed to nothing and armed no timer; the fixed code has both
    // in place while the hook is still hanging.
    const signal = new WakeSignal();
    const hook = hangingDormantHook();
    const runner = new PollingRunner({
      config: wakeConfig({ WORKER_DORMANT_CLEANUP_TIMEOUT_MS: "100000" }),
      logger: capturingLogger().logger,
      registry: fakeStatusSink(),
      claim: countingClaim().claim,
      processJob: async () => {},
      wakeSignal: signal,
      onDormant: hook.onDormant,
    });

    runner.start();
    await waitUntil(() => hook.entered(), 2_000, "the hook to be entered");

    // The hook is hanging right now and will never return. Even so:
    assert.equal(signal.listenerCount(), 1, "the latch already has its subscriber");
    assert.equal(runner.isDormant(), true);

    // And shutdown does not have to sit out the (deliberately huge) bound to get
    // the loop back — the bound keeps a RUNNING worker live, it is not a debt
    // stop() has to pay.
    const startedAt = Date.now();
    await runner.stop();
    assert.ok(Date.now() - startedAt < 1_000, "stop() interrupted the stuck cleanup");
    assert.equal(runner.isRunning(), false);
  });

  it("a wake delivered while the hook hangs resumes at once, not after the bound", async () => {
    // The bound alone would make this pass eventually, and eventually is not the
    // requirement: if the pool really is stuck then EVERY wake goes through this
    // path, and waiting the bound out each time would turn "immediate" into ten
    // seconds. The wake cancels the wait for a disconnect it has just made
    // pointless — we are reconnecting next regardless.
    const signal = new WakeSignal();
    const hook = hangingDormantHook();
    const claim = countingClaim();
    const log = capturingLogger();
    const runner = new PollingRunner({
      // Far longer than the test could tolerate, so only the cancellation can
      // explain a prompt resume.
      config: wakeConfig({ WORKER_DORMANT_CLEANUP_TIMEOUT_MS: "100000" }),
      logger: log.logger,
      registry: fakeStatusSink(),
      claim: claim.claim,
      processJob: async () => {},
      wakeSignal: signal,
      onDormant: hook.onDormant,
    });

    runner.start();
    await waitUntil(() => hook.entered(), 2_000, "dormancy");
    const atDormancy = claim.calls();

    // Signal arrives while the disconnect is still stuck, and always will be.
    const startedAt = Date.now();
    signal.notify();

    await waitUntil(() => claim.calls() > atDormancy, 2_000, "post-wake claim");
    assert.ok(Date.now() - startedAt < 500, "it did not serve out the cleanup bound");
    assert.equal(log.find("waking")?.meta?.reason, "signal", "resumed on the signal");

    await runner.stop();
  });

  it("the cleanup bound still rescues a hang that nothing wakes", async () => {
    // The other half: with no signal, the bound is the only thing that gets the
    // loop back, and it must.
    const hook = hangingDormantHook();
    const log = capturingLogger();
    const runner = new PollingRunner({
      config: wakeConfig({ WORKER_DORMANT_CLEANUP_TIMEOUT_MS: "40" }),
      logger: log.logger,
      registry: fakeStatusSink(),
      claim: countingClaim().claim,
      processJob: async () => {},
      wakeSignal: new WakeSignal(),
      onDormant: hook.onDormant,
    });

    runner.start();
    await waitUntil(() => log.has("dormant cleanup timed out"), 2_000, "the bound to expire");
    assert.equal(
      log.find("dormant cleanup timed out")?.level,
      "warn",
      "logged loudly enough to find"
    );
    await runner.stop();
  });

  it("the fallback still fires when the hook hangs", async () => {
    // Same hang, no signal at all — the safety net has to work on its own.
    const hook = hangingDormantHook();
    const claim = countingClaim();
    const processed: string[] = [];
    const wakes: WakeReason[] = [];
    const log = capturingLogger();
    const runner = new PollingRunner({
      config: wakeConfig({
        WORKER_FALLBACK_POLL_MS: "80",
        WORKER_DORMANT_CLEANUP_TIMEOUT_MS: "30",
      }),
      logger: log.logger,
      registry: fakeStatusSink(),
      claim: claim.claim,
      processJob: async (job) => void processed.push(job.id),
      onDormant: hook.onDormant,
      onActiveBurst: async (reason) => void wakes.push(reason),
    });

    runner.start();
    await waitUntil(() => hook.entered(), 2_000, "dormancy");
    claim.push({ id: "stranded", type: "t" });

    await waitUntil(() => processed.length === 1, 3_000, "fallback pickup");
    await runner.stop();

    assert.deepEqual(processed, ["stranded"]);
    assert.deepEqual(wakes, ["fallback"]);
  });

  it("a hook that rejects long after the timeout does not become an unhandled rejection", async () => {
    // Racing a timer against the hook would leave the loser unhandled; a
    // `$disconnect()` that fails after we stopped waiting would then take the
    // process down, which is worse than the hang it replaced.
    const rejections: unknown[] = [];
    const onUnhandled = (err: unknown) => rejections.push(err);
    process.on("unhandledRejection", onUnhandled);

    const log = capturingLogger();
    const signal = new WakeSignal();
    const runner = new PollingRunner({
      config: wakeConfig({ WORKER_DORMANT_CLEANUP_TIMEOUT_MS: "20" }),
      logger: log.logger,
      registry: fakeStatusSink(),
      claim: countingClaim().claim,
      processJob: async () => {},
      wakeSignal: signal,
      onDormant: async () => {
        await delay(80);
        throw new Error("pool ended badly, long after nobody was waiting");
      },
    });

    try {
      runner.start();
      await waitUntil(() => runner.isDormant(), 2_000, "dormancy");
      await waitUntil(() => log.has("dormant cleanup timed out"), 2_000, "the timeout");
      // Past the point where the hook rejects.
      await delay(120);
      await runner.stop();
      // Give any stray rejection a turn of the loop to surface.
      await delay(20);

      assert.deepEqual(rejections, [], "nothing escaped");
      assert.equal(log.has("dormant cleanup failed late"), true, "and the failure was logged");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a hook that finishes late is reported rather than silently forgotten", async () => {
    const log = capturingLogger();
    const runner = new PollingRunner({
      config: wakeConfig({ WORKER_DORMANT_CLEANUP_TIMEOUT_MS: "20" }),
      logger: log.logger,
      registry: fakeStatusSink(),
      claim: countingClaim().claim,
      processJob: async () => {},
      wakeSignal: new WakeSignal(),
      onDormant: () => delay(70),
    });

    runner.start();
    await waitUntil(() => log.has("dormant cleanup finished late"), 3_000, "the late notice");
    await runner.stop();
  });
});

// ─── Enqueue → wake, over the shared path ─────────────────────────────────────

describe("a dormant worker and a newly enqueued job", () => {
  /**
   * Wires the real `enqueueJob` to a real `WakeSignal`, standing in for the
   * network hop the notifier makes in production. What is under test is that the
   * SHARED enqueue path signals at all, and that the signal reaches a sleeping
   * worker — not any individual producer, none of which have wake code of their
   * own.
   */
  function enqueueThrough(signal: WakeSignal, onInsert: (type: string) => void) {
    let n = 0;
    return (type: string) =>
      enqueueJob(
        { type },
        {
          insertJob: async () => {
            n += 1;
            onInsert(type);
            return { id: `job-${n}` };
          },
          notifyWake: () => signal.notify(),
        }
      );
  }

  it("wakes and claims without the runner being restarted", async () => {
    const signal = new WakeSignal();
    const claim = countingClaim();
    const processed: string[] = [];
    const log = capturingLogger();

    const runner = new PollingRunner({
      config: wakeConfig(),
      logger: log.logger,
      registry: fakeStatusSink(),
      claim: claim.claim,
      processJob: async (job) => void processed.push(job.type),
      wakeSignal: signal,
      onDormant: async () => {},
    });

    runner.start();
    await waitUntil(() => runner.isDormant(), 2_000, "dormancy");

    // Someone presses Generate. The job row lands, then the wake goes out.
    const enqueue = enqueueThrough(signal, (type) => claim.push({ id: "j-topic", type }));
    const result = await enqueue("topic-generation");
    assert.equal(result.enqueued, true);

    await waitUntil(() => processed.length === 1, 2_000, "the job to run");

    // The point of the test: this is the same runner object throughout, never
    // stopped and never replaced. A restart is what used to be required.
    assert.equal(runner.isRunning(), true, "no restart happened");
    assert.deepEqual(processed, ["topic-generation"]);
    assert.equal(log.find("waking")?.meta?.reason, "signal");

    await runner.stop();
  });

  it("orders the wake after the row, so the claim cannot outrun the insert", async () => {
    // The race worth being explicit about: signal first, worker claims, finds
    // nothing, sleeps again, and the row lands afterwards into a queue nobody is
    // going to look at for half an hour.
    const order: string[] = [];
    const signal = new WakeSignal();
    signal.subscribe(() => order.push("wake"));

    await enqueueJob(
      { type: "rss-ingestion" },
      {
        insertJob: async () => {
          order.push("insert");
          return { id: "j1" };
        },
        notifyWake: () => signal.notify(),
      }
    );

    assert.deepEqual(order, ["insert", "wake"], "committed before signalled");
  });

  it("signals on a deduplicated enqueue too, which is what recovers a dropped wake", async () => {
    // The collided-with job is `queued`, which means a worker went dormant and
    // missed the signal sent when it was created. Without this the retrying
    // caller is told "already queued" forever while nothing moves.
    let woken = 0;
    const signal = new WakeSignal();
    signal.subscribe(() => (woken += 1));

    const err = Object.assign(new Error("unique violation"), { code: "P2002" });
    Object.setPrototypeOf(
      err,
      (await import("@prisma/client")).Prisma.PrismaClientKnownRequestError.prototype
    );

    const result = await enqueueJob(
      { type: "rss-classification", dedupeKey: "cron:rss-classification" },
      {
        insertJob: async () => {
          throw err;
        },
        notifyWake: () => signal.notify(),
      }
    );

    assert.equal(result.deduplicated, true);
    assert.equal(woken, 1, "a deduplicated enqueue still pokes the worker");
  });
});

// ─── Draining ─────────────────────────────────────────────────────────────────

describe("one wake, all the work", () => {
  it("drains every queued job from a single signal", async () => {
    const signal = new WakeSignal();
    const claim = countingClaim();
    const processed: string[] = [];
    const wakes: WakeReason[] = [];
    const runner = new PollingRunner({
      config: wakeConfig(),
      logger: capturingLogger().logger,
      registry: fakeStatusSink(),
      claim: claim.claim,
      processJob: async (job) => void processed.push(job.id),
      wakeSignal: signal,
      onActiveBurst: async (reason) => void wakes.push(reason),
    });

    runner.start();
    await waitUntil(() => runner.isDormant(), 2_000, "dormancy");

    claim.push(
      { id: "a", type: "t" },
      { id: "b", type: "t" },
      { id: "c", type: "t" },
      { id: "d", type: "t" },
      { id: "e", type: "t" }
    );
    signal.notify();

    await waitUntil(() => processed.length === 5, 2_000, "the drain");
    await runner.stop();

    assert.deepEqual(processed, ["a", "b", "c", "d", "e"]);
    assert.deepEqual(wakes, ["signal"], "one wake covered all five");
  });

  it("runs a job chained from another without a second wake", async () => {
    // rss-translation completing enqueues rss-classification. The worker is
    // already ACTIVE at that moment, so the follow-up must be picked up by the
    // loop it is already running — which is also why the worker never signals
    // itself.
    const queue: JobRecord[] = [
      {
        id: "j-translate",
        type: "rss-translation",
        payload: {},
        attempts: 1,
        maxAttempts: 5,
        result: null,
      },
    ];
    const completed: string[] = [];
    let nextId = 0;

    const store: JobStore = {
      enqueue: async (input) => {
        nextId += 1;
        const id = `chained-${nextId}`;
        queue.push({
          id,
          type: input.type,
          payload: input.payload ?? {},
          attempts: 0,
          maxAttempts: 5,
          result: null,
        });
        return id;
      },
      claim: async () => queue.shift() ?? null,
      renewLease: async () => true,
      saveProgress: async () => true,
      complete: async (id) => void completed.push(id),
      fail: async () => {},
      reapExpired: async () => ({ requeued: 0, failed: 0 }),
    };

    const handlers = new HandlerRegistry()
      .register("rss-translation", async () => {
        // The handler's own follow-up, enqueued in-process exactly as the real
        // translation handler does.
        await store.enqueue({ type: "rss-classification", payload: {} });
        return { translated: 1 };
      })
      .register("rss-classification", async () => ({ classified: 1 }));

    const config = wakeConfig();
    const orchestrator = new JobOrchestrator({
      store,
      registry: handlers,
      config,
      logger: capturingLogger().logger,
    });

    const signal = new WakeSignal();
    const wakes: WakeReason[] = [];
    const runner = new PollingRunner<JobRecord>({
      config,
      logger: capturingLogger().logger,
      registry: fakeStatusSink(),
      claim: () => orchestrator.claim(),
      processJob: (job) => orchestrator.process(job),
      wakeSignal: signal,
      onActiveBurst: async (reason) => void wakes.push(reason),
    });

    runner.start();
    await waitUntil(() => completed.length === 2, 3_000, "both jobs");
    await runner.stop();

    assert.deepEqual(completed, ["j-translate", "chained-1"]);
    assert.deepEqual(wakes, [], "the chain never needed a wake — it never slept");
  });
});

// ─── The fallback ─────────────────────────────────────────────────────────────

describe("fallback polling", () => {
  it("checks the queue once when the interval expires and finds the waiting job", async () => {
    const claim = countingClaim();
    const processed: string[] = [];
    const log = capturingLogger();
    const runner = new PollingRunner({
      config: wakeConfig({ WORKER_FALLBACK_POLL_MS: "70" }),
      logger: log.logger,
      registry: fakeStatusSink(),
      claim: claim.claim,
      processJob: async (job) => void processed.push(job.id),
      // No wakeSignal: the strongest form of "the signal never came".
    });

    runner.start();
    await waitUntil(() => runner.isDormant(), 2_000, "dormancy");
    claim.push({ id: "late", type: "t" });

    await waitUntil(() => processed.length === 1, 3_000, "fallback pickup");
    await runner.stop();

    assert.deepEqual(processed, ["late"]);
    assert.equal(log.find("waking")?.meta?.reason, "fallback");
  });

  it("returns safely to dormancy when the fallback finds nothing", async () => {
    const claim = countingClaim();
    const wakes: WakeReason[] = [];
    const runner = new PollingRunner({
      config: wakeConfig({ WORKER_FALLBACK_POLL_MS: "60" }),
      logger: capturingLogger().logger,
      registry: fakeStatusSink(),
      claim: claim.claim,
      processJob: async () => {},
      onActiveBurst: async (reason) => void wakes.push(reason),
    });

    runner.start();
    await waitUntil(() => runner.isDormant(), 2_000, "first dormancy");
    await waitUntil(() => wakes.length >= 2, 3_000, "two empty fallback ticks");
    await waitUntil(() => runner.isDormant(), 2_000, "back to sleep");

    assert.ok(
      wakes.every((r) => r === "fallback"),
      "every burst was a fallback"
    );
    assert.equal(runner.isDormant(), true, "and it is asleep again, not spinning");
    await runner.stop();
  });
});

// ─── No regression to aggressive polling ──────────────────────────────────────

describe("Neon compute is left alone", () => {
  it("a dormant worker issues no claims at all", async () => {
    const claim = countingClaim();
    const runner = new PollingRunner({
      config: wakeConfig({ WORKER_FALLBACK_POLL_MS: "600000" }),
      logger: capturingLogger().logger,
      registry: fakeStatusSink(),
      claim: claim.claim,
      processJob: async () => {},
      wakeSignal: new WakeSignal(),
      onDormant: async () => {},
    });

    runner.start();
    await waitUntil(() => runner.isDormant(), 2_000, "dormancy");
    const atDormancy = claim.calls();

    // Forty poll intervals of wall clock. An ACTIVE worker makes forty claims
    // here; a dormant one makes none.
    await delay(200);

    assert.equal(claim.calls(), atDormancy, "not one query while asleep");
    await runner.stop();
  });

  it("survives many wake/sleep cycles without leaking subscribers", async () => {
    // The latched-wake path used to drop its unsubscribe: `subscribe` fires the
    // listener synchronously when a wake is already pending, so `finish` ran
    // before the unsubscribe handle had been assigned and the listener stayed
    // registered for the life of the process.
    const signal = new WakeSignal();
    const wakes: WakeReason[] = [];
    let claims = 0;
    const runner = new PollingRunner({
      config: wakeConfig(),
      logger: capturingLogger().logger,
      registry: fakeStatusSink(),
      // Signalling from inside the claim is what reproduces the latch precisely:
      // the loop consumed any pending wake immediately BEFORE this call, so the
      // flag set here survives to `dormantWait`, whose `subscribe` then fires its
      // listener synchronously — the exact path that dropped the unsubscribe.
      claim: async () => {
        claims += 1;
        signal.notify();
        return null;
      },
      processJob: async () => {},
      wakeSignal: signal,
      onActiveBurst: async (reason) => void wakes.push(reason),
    });

    runner.start();
    await waitUntil(() => wakes.length >= 5, 3_000, "five latched-wake cycles");
    await runner.stop();

    assert.ok(claims > 5, "the loop really did keep cycling");

    assert.ok(
      wakes.every((r) => r === "signal"),
      "each cycle woke on the latched signal"
    );
    assert.equal(signal.listenerCount(), 0, "and left no subscriber behind");
  });
});
