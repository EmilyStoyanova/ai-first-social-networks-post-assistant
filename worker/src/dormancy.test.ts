/**
 * The dormancy state machine: when the worker stops polling, what it stops
 * doing while asleep, and what wakes it.
 *
 * The property under test throughout is the one the whole design exists for —
 * that a DORMANT worker issues NO database calls at all. Every test that asserts
 * it does so by counting calls to the claim seam across a window in which a
 * polling worker would have made many, which is the same thing Neon's activity
 * graph measures, only deterministically.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadWorkerConfig } from "./config";
import { createLogger } from "./logger";
import { decideIdleAction } from "./dormancy";
import { WakeSignal } from "./wake-signal";
import { PollingRunner, type ClaimedJob, type WakeReason } from "./runner";
import { WorkerRegistry } from "./registry";
import { JobOrchestrator } from "./orchestrator";
import { HandlerRegistry } from "./handler-registry";
import type { JobRecord, JobStore, ReapResult } from "./job-store";
import type { WorkerLifecycle, WorkerPatch, WorkerStore } from "./store";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const silentLogger = createLogger("test", () => {});
const baseEnv: Record<string, string | undefined> = {
  DATABASE_URL: "postgres://localhost/test",
};
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Config tuned to milliseconds so a full ACTIVE → DORMANT → wake → ACTIVE cycle
 * completes inside a test rather than inside half an hour. The RATIOS are what
 * production uses; only the magnitudes shrink.
 */
function dormancyConfig(overrides: Record<string, string | undefined> = {}) {
  return loadWorkerConfig({
    ...baseEnv,
    WORKER_ID: "w-dormancy",
    WORKER_POLL_INTERVAL_MS: "5",
    WORKER_DORMANT_AFTER_MS: "40",
    WORKER_FALLBACK_POLL_MS: "10000",
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

/**
 * A claim seam that counts every call and can be handed a queue to drain.
 *
 * The count IS the assertion in most of what follows: "zero database activity
 * while dormant" is exactly "this counter did not move".
 */
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

/** Records the disconnect/reconnect hooks in the order they actually fired. */
function connectionSpy() {
  const events: string[] = [];
  return {
    events,
    onDormant: async () => {
      events.push("disconnect");
    },
    onActiveBurst: async (reason: WakeReason) => {
      events.push(`connect:${reason}`);
    },
  };
}

/** Polls a predicate rather than sleeping a guessed duration. */
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

// ─── The idle decision ────────────────────────────────────────────────────────

describe("decideIdleAction", () => {
  const base = { dormantAfterMs: 60_000, pollIntervalMs: 2_000 };

  it("polls at the configured interval while the quiet window is young", () => {
    const d = decideIdleAction({ ...base, emptySinceMs: 0, nowMs: 1_000 });
    assert.deepEqual(d, { action: "poll", sleepMs: 2_000 });
  });

  it("goes dormant once the queue has been empty for the whole window", () => {
    const d = decideIdleAction({ ...base, emptySinceMs: 0, nowMs: 60_000 });
    assert.deepEqual(d, { action: "dormant", quietMs: 60_000 });
  });

  it("does not overshoot the dormancy deadline with a full poll interval", () => {
    // 500ms of quiet left, a 2s poll interval: sleeping the interval would sit
    // awake 1.5s longer than configured, every cycle.
    const d = decideIdleAction({ ...base, emptySinceMs: 0, nowMs: 59_500 });
    assert.deepEqual(d, { action: "poll", sleepMs: 500 });
  });

  it("never goes dormant when dormancy is switched off", () => {
    const d = decideIdleAction({
      ...base,
      dormantAfterMs: 0,
      emptySinceMs: 0,
      nowMs: 10_000_000,
    });
    assert.deepEqual(d, { action: "poll", sleepMs: 2_000 });
  });

  it("treats a clock that went backwards as no quiet time, not negative time", () => {
    const d = decideIdleAction({ ...base, emptySinceMs: 5_000, nowMs: 1_000 });
    assert.deepEqual(d, { action: "poll", sleepMs: 2_000 });
  });
});

// ─── The wake latch ───────────────────────────────────────────────────────────

describe("WakeSignal", () => {
  it("delivers a wake to a live subscriber", () => {
    const signal = new WakeSignal();
    let woken = 0;
    signal.subscribe(() => (woken += 1));
    signal.notify();
    assert.equal(woken, 1);
  });

  it("latches a wake that arrives before anyone is listening", () => {
    // The race the latch exists for: a signal landing between the last empty
    // claim and the moment the loop commits to sleeping.
    const signal = new WakeSignal();
    signal.notify();

    let woken = 0;
    signal.subscribe(() => (woken += 1));
    assert.equal(woken, 1, "a pending wake fires the instant someone subscribes");
    assert.equal(signal.hasPending(), false, "and is consumed, not re-delivered");
  });

  it("coalesces a burst of wakes into one", () => {
    const signal = new WakeSignal();
    for (let i = 0; i < 25; i += 1) signal.notify();

    let woken = 0;
    signal.subscribe(() => (woken += 1));
    assert.equal(woken, 1, "twenty-five wakes mean the same thing as one");
  });

  it("consumePending clears a wake taken while already awake", () => {
    const signal = new WakeSignal();
    signal.notify();
    assert.equal(signal.consumePending(), true);
    assert.equal(signal.consumePending(), false);
  });

  it("unsubscribe leaves no listener behind", () => {
    const signal = new WakeSignal();
    const off = signal.subscribe(() => {});
    assert.equal(signal.listenerCount(), 1);
    off();
    assert.equal(signal.listenerCount(), 0);
  });

  it("a throwing listener does not stop the others or the notifier", () => {
    const signal = new WakeSignal();
    let reached = false;
    signal.subscribe(() => {
      throw new Error("listener exploded");
    });
    signal.subscribe(() => (reached = true));
    assert.doesNotThrow(() => signal.notify());
    assert.equal(reached, true);
  });
});

// ─── ACTIVE → DORMANT ─────────────────────────────────────────────────────────

describe("PollingRunner dormancy", () => {
  it("goes dormant after the queue has been empty for the grace window", async () => {
    const sink = fakeStatusSink();
    const claim = countingClaim();
    const runner = new PollingRunner({
      config: dormancyConfig(),
      logger: silentLogger,
      registry: sink,
      claim: claim.claim,
      processJob: async () => {},
    });

    runner.start();
    await waitUntil(() => runner.isDormant(), 2_000, "dormancy");
    await runner.stop();

    assert.ok(claim.calls() > 1, "it polled while the window was open");
  });

  it("issues ZERO database calls while dormant", async () => {
    const claim = countingClaim();
    const runner = new PollingRunner({
      config: dormancyConfig(),
      logger: silentLogger,
      registry: fakeStatusSink(),
      claim: claim.claim,
      processJob: async () => {},
    });

    runner.start();
    await waitUntil(() => runner.isDormant(), 2_000, "dormancy");
    const atDormancy = claim.calls();

    // Ten poll intervals' worth of wall clock. A polling worker would have made
    // roughly sixty more claims in this window; a dormant one makes none.
    await delay(200);

    assert.equal(claim.calls(), atDormancy, "the queue was not touched while dormant");
    assert.equal(runner.isDormant(), true, "and it is still asleep");
    await runner.stop();
  });

  it("closes the connection on the way down and reopens it on the way up", async () => {
    const conn = connectionSpy();
    const signal = new WakeSignal();
    const claim = countingClaim();
    const runner = new PollingRunner({
      config: dormancyConfig(),
      logger: silentLogger,
      registry: fakeStatusSink(),
      claim: claim.claim,
      processJob: async () => {},
      wakeSignal: signal,
      onDormant: conn.onDormant,
      onActiveBurst: conn.onActiveBurst,
    });

    runner.start();
    await waitUntil(() => runner.isDormant(), 2_000, "dormancy");
    assert.deepEqual(conn.events, ["disconnect"]);

    signal.notify();
    await waitUntil(() => conn.events.length >= 2, 2_000, "reconnect");
    await runner.stop();

    assert.deepEqual(
      conn.events,
      ["disconnect", "connect:signal"],
      "disconnect strictly before the last claim, reconnect strictly before the next"
    );
  });

  it("reconnects before it claims, never after", async () => {
    const order: string[] = [];
    const signal = new WakeSignal();
    let claims = 0;
    const runner = new PollingRunner({
      config: dormancyConfig(),
      logger: silentLogger,
      registry: fakeStatusSink(),
      claim: async () => {
        claims += 1;
        order.push("claim");
        return null;
      },
      processJob: async () => {},
      wakeSignal: signal,
      onDormant: async () => void order.push("disconnect"),
      onActiveBurst: async () => void order.push("connect"),
    });

    runner.start();
    await waitUntil(() => runner.isDormant(), 2_000, "dormancy");
    const before = claims;
    signal.notify();
    await waitUntil(() => claims > before, 2_000, "post-wake claim");
    await runner.stop();

    const disconnectAt = order.indexOf("disconnect");
    const connectAt = order.indexOf("connect");
    assert.ok(connectAt > disconnectAt, "reconnect follows the disconnect");
    assert.equal(
      order.slice(disconnectAt, connectAt).includes("claim"),
      false,
      "no claim happened between them"
    );
    assert.equal(order[connectAt + 1], "claim", "the burst opens with a claim");
  });

  it("never goes dormant when dormancy is disabled", async () => {
    const claim = countingClaim();
    const runner = new PollingRunner({
      config: dormancyConfig({ WORKER_DORMANT_AFTER_MS: "0" }),
      logger: silentLogger,
      registry: fakeStatusSink(),
      claim: claim.claim,
      processJob: async () => {},
    });

    runner.start();
    await delay(120);
    assert.equal(runner.isDormant(), false);
    assert.ok(claim.calls() > 5, "it kept polling throughout");
    await runner.stop();
  });
});

// ─── Waking ───────────────────────────────────────────────────────────────────

describe("PollingRunner wake handling", () => {
  it("wakes on a signal and drains the whole queue before sleeping again", async () => {
    const signal = new WakeSignal();
    const claim = countingClaim();
    const processed: string[] = [];
    const runner = new PollingRunner({
      config: dormancyConfig(),
      logger: silentLogger,
      registry: fakeStatusSink(),
      claim: claim.claim,
      processJob: async (job) => void processed.push(job.id),
      wakeSignal: signal,
    });

    runner.start();
    await waitUntil(() => runner.isDormant(), 2_000, "first dormancy");

    // Three jobs land while it sleeps, and one signal announces them. Draining
    // is not a function of how many wakes arrived.
    claim.push({ id: "j1", type: "t" }, { id: "j2", type: "t" }, { id: "j3", type: "t" });
    signal.notify();

    await waitUntil(() => processed.length === 3, 2_000, "queue drain");
    // And then it goes back to sleep on its own.
    await waitUntil(() => runner.isDormant(), 2_000, "second dormancy");
    await runner.stop();

    assert.deepEqual(processed, ["j1", "j2", "j3"]);
  });

  it("survives a burst of wakes without waking twice or leaking listeners", async () => {
    const signal = new WakeSignal();
    const claim = countingClaim();
    const wakes: WakeReason[] = [];
    const runner = new PollingRunner({
      config: dormancyConfig(),
      logger: silentLogger,
      registry: fakeStatusSink(),
      claim: claim.claim,
      processJob: async () => {},
      wakeSignal: signal,
      onActiveBurst: async (reason) => void wakes.push(reason),
    });

    runner.start();
    await waitUntil(() => runner.isDormant(), 2_000, "dormancy");

    for (let i = 0; i < 50; i += 1) signal.notify();
    await waitUntil(() => wakes.length >= 1, 2_000, "wake");
    await waitUntil(() => runner.isDormant(), 2_000, "return to dormancy");
    await runner.stop();

    assert.deepEqual(wakes, ["signal"], "fifty signals produced exactly one burst");
    assert.equal(signal.listenerCount(), 0, "no subscription outlived the loop");
  });

  it("a wake arriving while ACTIVE changes nothing and is not carried into the next sleep", async () => {
    const signal = new WakeSignal();
    const claim = countingClaim();
    const wakes: WakeReason[] = [];
    const runner = new PollingRunner({
      config: dormancyConfig(),
      logger: silentLogger,
      registry: fakeStatusSink(),
      claim: claim.claim,
      processJob: async () => {},
      wakeSignal: signal,
      onActiveBurst: async (reason) => void wakes.push(reason),
    });

    runner.start();
    // Still inside the grace window — the loop is awake and already polling, so
    // a signal here is redundant by definition.
    await delay(10);
    signal.notify();
    signal.notify();

    await waitUntil(() => runner.isDormant(), 2_000, "dormancy");
    // The critical assertion: those wakes were absorbed by the active loop and
    // did not immediately cancel the sleep they preceded.
    await delay(60);
    assert.equal(runner.isDormant(), true, "it stayed asleep");
    assert.deepEqual(wakes, [], "and never entered a burst");
    await runner.stop();
  });

  it("picks the queue up on the fallback tick when no wake ever arrives", async () => {
    // The missed-signal case: nothing signals, the tunnel is down, Vercel never
    // called. The job must still run.
    const claim = countingClaim();
    const processed: string[] = [];
    const wakes: WakeReason[] = [];
    const runner = new PollingRunner({
      config: dormancyConfig({ WORKER_FALLBACK_POLL_MS: "60" }),
      logger: silentLogger,
      registry: fakeStatusSink(),
      claim: claim.claim,
      processJob: async (job) => void processed.push(job.id),
      // No wakeSignal at all — the strongest form of "the signal never came".
      onActiveBurst: async (reason) => void wakes.push(reason),
    });

    runner.start();
    await waitUntil(() => runner.isDormant(), 2_000, "dormancy");
    claim.push({ id: "late", type: "t" });

    await waitUntil(() => processed.length === 1, 3_000, "fallback pickup");
    await runner.stop();

    assert.deepEqual(processed, ["late"]);
    assert.deepEqual(wakes, ["fallback"], "recovered by the timer, not by a signal");
  });

  it("stop() interrupts a dormant wait instead of blocking for the fallback", async () => {
    const runner = new PollingRunner({
      config: dormancyConfig({ WORKER_FALLBACK_POLL_MS: "600000" }),
      logger: silentLogger,
      registry: fakeStatusSink(),
      claim: async () => null,
      processJob: async () => {},
      wakeSignal: new WakeSignal(),
    });

    runner.start();
    await waitUntil(() => runner.isDormant(), 2_000, "dormancy");

    const startedAt = Date.now();
    await runner.stop();

    assert.ok(Date.now() - startedAt < 1_000, "shutdown did not wait ten minutes");
    assert.equal(runner.isRunning(), false);
  });

  it("a failing disconnect hook does not stop the worker sleeping or waking", async () => {
    const signal = new WakeSignal();
    const claim = countingClaim();
    const runner = new PollingRunner({
      config: dormancyConfig(),
      logger: silentLogger,
      registry: fakeStatusSink(),
      claim: claim.claim,
      processJob: async () => {},
      wakeSignal: signal,
      onDormant: async () => {
        throw new Error("connection would not close");
      },
    });

    runner.start();
    await waitUntil(() => runner.isDormant(), 2_000, "dormancy despite the failure");

    const atDormancy = claim.calls();
    claim.push({ id: "j1", type: "t" });
    signal.notify();
    await waitUntil(() => claim.calls() > atDormancy, 2_000, "wake despite the failure");
    await runner.stop();
  });
});

// ─── Heartbeats ───────────────────────────────────────────────────────────────

describe("WorkerRegistry heartbeat scheduling", () => {
  function makeRegistry() {
    const updates: Array<{ name: string; patch: WorkerPatch }> = [];
    const store: WorkerStore = {
      upsert: async () => {},
      update: async (name, patch) => void updates.push({ name, patch }),
    };
    const config = dormancyConfig({ WORKER_HEARTBEAT_INTERVAL_MS: "10" });
    return {
      updates,
      registry: new WorkerRegistry({ store, config, logger: silentLogger }),
    };
  }

  it("does not beat while idle", async () => {
    const { registry, updates } = makeRegistry();
    await registry.setStatus("idle");
    assert.equal(registry.isHeartbeating(), false);

    const after = updates.length;
    await delay(60); // six heartbeat intervals
    assert.equal(updates.length, after, "an idle worker wrote nothing");
  });

  it("beats while busy", async () => {
    const { registry, updates } = makeRegistry();
    await registry.setStatus("busy");
    assert.equal(registry.isHeartbeating(), true);

    const after = updates.length;
    await delay(60);
    assert.ok(updates.length > after, "a busy worker kept proving it was alive");
    registry.stopHeartbeat();
  });

  it("stops beating the moment the job ends", async () => {
    const { registry, updates } = makeRegistry();
    await registry.setStatus("busy");
    await registry.setStatus("idle");
    assert.equal(registry.isHeartbeating(), false);

    const after = updates.length;
    await delay(60);
    assert.equal(updates.length, after);
  });

  it("stops beating on draining and on stopped", async () => {
    const { registry } = makeRegistry();
    await registry.setStatus("busy");
    await registry.setStatus("draining");
    assert.equal(registry.isHeartbeating(), false);

    await registry.setStatus("busy");
    await registry.markStopped();
    assert.equal(registry.isHeartbeating(), false);
  });

  it("beats across a whole busy→idle→busy cycle driven by the runner", async () => {
    const updates: Array<{ name: string; patch: WorkerPatch }> = [];
    const store: WorkerStore = {
      upsert: async () => {},
      update: async (name, patch) => void updates.push({ name, patch }),
    };
    const config = dormancyConfig({ WORKER_HEARTBEAT_INTERVAL_MS: "5" });
    const registry = new WorkerRegistry({ store, config, logger: silentLogger });

    let handed = false;
    const runner = new PollingRunner({
      config,
      logger: silentLogger,
      registry,
      claim: async () => {
        if (handed) return null;
        handed = true;
        return { id: "j1", type: "t" };
      },
      // Long enough to span several heartbeat intervals.
      processJob: async () => {
        await delay(40);
      },
    });

    runner.start();
    await waitUntil(() => runner.isDormant(), 2_000, "dormancy after the job");
    await runner.stop();

    const beats = updates.filter((u) => u.patch.status === "busy").length;
    assert.ok(beats > 1, `expected repeated busy heartbeats, saw ${beats}`);
    assert.equal(registry.isHeartbeating(), false, "and none once it went quiet");
  });
});

// ─── Reaping ──────────────────────────────────────────────────────────────────

describe("stale-lease reaping under dormancy", () => {
  function reapingStore(counts: ReapResult = { requeued: 0, failed: 0 }) {
    let reaps = 0;
    const store: JobStore = {
      enqueue: async () => "id",
      claim: async () => null,
      renewLease: async () => true,
      saveProgress: async () => true,
      complete: async () => {},
      fail: async () => {},
      reapExpired: async () => {
        reaps += 1;
        return counts;
      },
    };
    return { store, reaps: () => reaps };
  }

  it("reaps once at the head of every active burst", async () => {
    const { store, reaps } = reapingStore();
    const config = dormancyConfig();
    const orchestrator = new JobOrchestrator({
      store,
      registry: new HandlerRegistry(),
      config,
      logger: silentLogger,
    });
    const signal = new WakeSignal();

    const runner = new PollingRunner<JobRecord>({
      config,
      logger: silentLogger,
      registry: fakeStatusSink(),
      claim: () => orchestrator.claim(),
      processJob: (job) => orchestrator.process(job),
      wakeSignal: signal,
      onActiveBurst: async () => void (await orchestrator.reapOnce()),
    });

    runner.start();
    await waitUntil(() => runner.isDormant(), 2_000, "dormancy");
    assert.equal(reaps(), 0, "no reaping while merely polling");

    signal.notify();
    await waitUntil(() => reaps() === 1, 2_000, "burst reap");
    await waitUntil(() => runner.isDormant(), 2_000, "return to dormancy");

    signal.notify();
    await waitUntil(() => reaps() === 2, 2_000, "second burst reap");
    await runner.stop();
  });

  it("does not reap on a timer while dormant", async () => {
    // The periodic reaper is opt-in precisely because a timer here would be a
    // recurring query against a database that is supposed to be suspended.
    const { store, reaps } = reapingStore();
    const config = dormancyConfig();
    assert.equal(config.reapIntervalMs, 0, "burst-only is the default");

    const orchestrator = new JobOrchestrator({
      store,
      registry: new HandlerRegistry(),
      config,
      logger: silentLogger,
    });
    const runner = new PollingRunner<JobRecord>({
      config,
      logger: silentLogger,
      registry: fakeStatusSink(),
      claim: () => orchestrator.claim(),
      processJob: (job) => orchestrator.process(job),
    });

    runner.start();
    await waitUntil(() => runner.isDormant(), 2_000, "dormancy");
    await delay(150);
    assert.equal(reaps(), 0);
    await runner.stop();
  });

  it("still reports what it recovered when a burst does find stale leases", async () => {
    const { store } = reapingStore({ requeued: 2, failed: 1 });
    const orchestrator = new JobOrchestrator({
      store,
      registry: new HandlerRegistry(),
      config: dormancyConfig(),
      logger: silentLogger,
    });
    assert.deepEqual(await orchestrator.reapOnce(), { requeued: 2, failed: 1 });
  });

  it("a positive WORKER_REAP_INTERVAL_MS is available for multi-worker use", () => {
    const config = dormancyConfig({ WORKER_REAP_INTERVAL_MS: "150000" });
    assert.equal(config.reapIntervalMs, 150_000);
  });
});

// ─── Lease renewal is untouched ───────────────────────────────────────────────

describe("lease renewal under the new config", () => {
  it("still renews at a third of the TTL, with the dormancy knobs present", async () => {
    let scheduledInterval = 0;
    let tick: (() => void) | null = null;
    const renewals: string[] = [];

    const store: JobStore = {
      enqueue: async () => "id",
      claim: async () => null,
      renewLease: async ({ id }) => {
        renewals.push(id);
        return true;
      },
      saveProgress: async () => true,
      complete: async () => {},
      fail: async () => {},
      reapExpired: async () => ({ requeued: 0, failed: 0 }),
    };

    const handlers = new HandlerRegistry().register("slow", async () => {
      tick?.();
      tick?.();
      return {};
    });

    const orchestrator = new JobOrchestrator({
      store,
      registry: handlers,
      config: dormancyConfig({ WORKER_LEASE_TTL_MS: "300000" }),
      logger: silentLogger,
      scheduleRenewal: (ms, fn) => {
        scheduledInterval = ms;
        tick = fn;
        return () => {
          tick = null;
        };
      },
    });

    await orchestrator.process({
      id: "j1",
      type: "slow",
      payload: {},
      attempts: 1,
      maxAttempts: 5,
      result: null,
    });

    // 300_000 / 3 — the pre-existing RENEWAL_FRACTION, unchanged by dormancy.
    assert.equal(scheduledInterval, 100_000);
    // Renewals are fire-and-forget inside the tick; let them settle.
    await delay(10);
    assert.deepEqual(renewals, ["j1", "j1"]);
  });
});
