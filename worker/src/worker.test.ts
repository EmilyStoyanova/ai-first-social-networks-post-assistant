import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadWorkerConfig } from "./config";
import { createLogger } from "./logger";
import { WorkerRegistry } from "./registry";
import { PollingRunner, type ClaimedJob } from "./runner";
import type { WorkerLifecycle, WorkerPatch, WorkerStore, WorkerUpsertInput } from "./store";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const silentLogger = createLogger("test", () => {});
const baseEnv: Record<string, string | undefined> = {
  DATABASE_URL: "postgres://localhost/test",
};
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function fakeStore() {
  const upserts: WorkerUpsertInput[] = [];
  const updates: Array<{ name: string; patch: WorkerPatch }> = [];
  const store: WorkerStore = {
    upsert: async (input) => {
      upserts.push(input);
    },
    update: async (name, patch) => {
      updates.push({ name, patch });
    },
  };
  return { store, upserts, updates };
}

function makeRegistry() {
  const { store, upserts, updates } = fakeStore();
  const config = loadWorkerConfig({ ...baseEnv, WORKER_ID: "w-test" });
  const fixedNow = new Date("2026-07-22T00:00:00.000Z");
  const registry = new WorkerRegistry({ store, config, logger: silentLogger, now: () => fixedNow });
  return { registry, upserts, updates, fixedNow };
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

// ─── Config ─────────────────────────────────────────────────────────────────

describe("loadWorkerConfig", () => {
  it("applies defaults and derives workerId from hostname:pid", () => {
    const c = loadWorkerConfig({ ...baseEnv });
    assert.equal(c.concurrency, 1);
    assert.equal(c.pollIntervalMs, 2_000);
    assert.equal(c.heartbeatIntervalMs, 15_000);
    assert.equal(c.shutdownGraceMs, 30_000);
    assert.equal(c.pid, process.pid);
    assert.match(c.workerId, new RegExp(`:${process.pid}$`));
  });

  it("honors WORKER_ID and coerces numeric overrides", () => {
    const c = loadWorkerConfig({
      ...baseEnv,
      WORKER_ID: "w1",
      WORKER_CONCURRENCY: "4",
      WORKER_POLL_INTERVAL_MS: "500",
    });
    assert.equal(c.workerId, "w1");
    assert.equal(c.concurrency, 4);
    assert.equal(c.pollIntervalMs, 500);
  });

  it("throws when DATABASE_URL is missing", () => {
    assert.throws(() => loadWorkerConfig({}));
  });

  it("throws on a non-positive concurrency", () => {
    assert.throws(() => loadWorkerConfig({ ...baseEnv, WORKER_CONCURRENCY: "0" }));
  });
});

// ─── Registry lifecycle ───────────────────────────────────────────────────────

describe("WorkerRegistry", () => {
  it("registers the worker with status starting", async () => {
    const { registry, upserts } = makeRegistry();
    await registry.register();
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].name, "w-test");
    assert.equal(upserts[0].status, "starting");
    assert.equal(upserts[0].concurrency, 1);
    assert.equal(registry.currentStatus(), "starting");
  });

  it("setStatus writes the new status plus a heartbeat", async () => {
    const { registry, updates, fixedNow } = makeRegistry();
    await registry.setStatus("idle");
    const last = updates.at(-1);
    assert.equal(last?.patch.status, "idle");
    assert.deepEqual(last?.patch.lastHeartbeatAt, fixedNow);
    assert.equal(registry.currentStatus(), "idle");
  });

  it("heartbeatOnce preserves the current status and stamps lastHeartbeatAt", async () => {
    const { registry, updates } = makeRegistry();
    await registry.setStatus("idle");
    await registry.heartbeatOnce();
    const last = updates.at(-1);
    assert.equal(last?.patch.status, "idle");
    assert.ok(last?.patch.lastHeartbeatAt);
  });

  it("markStopped transitions to stopped with a stoppedAt", async () => {
    const { registry, updates, fixedNow } = makeRegistry();
    await registry.markStopped();
    const last = updates.at(-1);
    assert.equal(last?.patch.status, "stopped");
    assert.deepEqual(last?.patch.stoppedAt, fixedNow);
    assert.equal(registry.currentStatus(), "stopped");
  });
});

// ─── Polling runner ─────────────────────────────────────────────────────────

describe("PollingRunner", () => {
  it("transitions to idle on start and stays idle with no work", async () => {
    const sink = fakeStatusSink();
    const config = loadWorkerConfig({ ...baseEnv, WORKER_POLL_INTERVAL_MS: "20" });
    const runner = new PollingRunner({
      config,
      logger: silentLogger,
      registry: sink,
      claim: async () => null,
      processJob: async () => {},
    });

    runner.start();
    await delay(40);
    await runner.stop();

    assert.equal(sink.transitions[0], "idle");
    assert.ok(!sink.transitions.includes("busy"));
    assert.equal(runner.isRunning(), false);
  });

  it("goes busy→idle around a claimed job and executes it", async () => {
    const sink = fakeStatusSink();
    const config = loadWorkerConfig({ ...baseEnv, WORKER_POLL_INTERVAL_MS: "20" });
    const processed: string[] = [];
    let handedOut = false;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => (resolveDone = resolve));

    const runner = new PollingRunner({
      config,
      logger: silentLogger,
      registry: sink,
      claim: async () => {
        if (handedOut) return null;
        handedOut = true;
        return { id: "j1", type: "noop" } satisfies ClaimedJob;
      },
      processJob: async (job) => {
        processed.push(job.id);
        resolveDone();
      },
    });

    runner.start();
    await done;
    await runner.stop();

    assert.deepEqual(processed, ["j1"]);
    assert.equal(sink.transitions[0], "idle");
    assert.ok(sink.transitions.includes("busy"));
  });

  it("stop() interrupts a poll wait promptly instead of blocking a full interval", async () => {
    const sink = fakeStatusSink();
    const config = loadWorkerConfig({ ...baseEnv, WORKER_POLL_INTERVAL_MS: "10000" });
    const runner = new PollingRunner({
      config,
      logger: silentLogger,
      registry: sink,
      claim: async () => null,
      processJob: async () => {},
    });

    runner.start();
    await delay(20);
    const startedAt = Date.now();
    await runner.stop();

    assert.ok(Date.now() - startedAt < 1_000);
    assert.equal(runner.isRunning(), false);
  });
});
