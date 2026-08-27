/**
 * Owns this process's row in the `workers` table: registration, status
 * transitions (starting → idle → busy → draining → stopped), and heartbeats.
 *
 * Depends only on WorkerStore + WorkerConfig + Logger, so its lifecycle logic is
 * unit-testable with an in-memory fake and no database.
 *
 * ── Heartbeats run while BUSY and only while BUSY ────────────────────────────
 *
 * A heartbeat answers one question: is the process holding this job still
 * alive? That question only exists while a job is held. An idle worker's
 * heartbeat proves nothing anyone reads — no code path in this repository reads
 * `lastHeartbeatAt`, and stale-lease recovery is driven by `leaseExpiresAt`,
 * which lease renewal maintains independently — while costing a write every
 * fifteen seconds, forever, against a database that bills for being awake.
 *
 * So the timer is bound to the status rather than to the process: `setStatus`
 * starts it on `busy` and stops it on everything else. That makes "no heartbeats
 * while idle" a property of the state machine instead of a rule callers have to
 * remember, which matters because the worker now spends nearly all of its time
 * idle and then dormant with no connection at all.
 */

import type { WorkerConfig } from "./config";
import type { Logger } from "./logger";
import type { WorkerLifecycle, WorkerStore } from "./store";

interface RegistryDeps {
  store: WorkerStore;
  config: WorkerConfig;
  logger: Logger;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export class WorkerRegistry {
  private status: WorkerLifecycle = "starting";
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => Date;

  constructor(private readonly deps: RegistryDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  currentStatus(): WorkerLifecycle {
    return this.status;
  }

  /** Insert or refresh this worker's row and mark it `starting`. */
  async register(): Promise<void> {
    const t = this.now();
    this.status = "starting";
    await this.deps.store.upsert({
      name: this.deps.config.workerId,
      status: "starting",
      hostname: this.deps.config.hostname,
      pid: this.deps.config.pid,
      concurrency: this.deps.config.concurrency,
      metadata: { node: process.version },
      startedAt: t,
      lastHeartbeatAt: t,
    });
    this.deps.logger.info("registered", {
      name: this.deps.config.workerId,
      concurrency: this.deps.config.concurrency,
    });
  }

  /**
   * Transition to a new lifecycle status, stamping a heartbeat alongside it.
   *
   * The heartbeat timer follows the status: running while `busy`, stopped
   * otherwise. The timer is adjusted only AFTER the write lands, so a failed
   * transition does not leave the process beating for a state it never reached.
   */
  async setStatus(status: WorkerLifecycle): Promise<void> {
    this.status = status;
    await this.deps.store.update(this.deps.config.workerId, {
      status,
      lastHeartbeatAt: this.now(),
    });
    if (status === "busy") this.startHeartbeat();
    else this.stopHeartbeat();
    this.deps.logger.info("status", { status });
  }

  /**
   * Begin periodic heartbeats. Idempotent — a second call is a no-op.
   *
   * Called by `setStatus` rather than at boot; calling it directly is for tests.
   */
  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeatOnce();
    }, this.deps.config.heartbeatIntervalMs);
    // The job this beats for is always awaited, so the timer must never be the
    // reason the process stays up.
    this.heartbeatTimer.unref?.();
  }

  /** Whether the heartbeat timer is currently running. For tests and diagnostics. */
  isHeartbeating(): boolean {
    return this.heartbeatTimer !== null;
  }

  /** One heartbeat write, preserving the current status. Public for testing. */
  async heartbeatOnce(): Promise<void> {
    try {
      await this.deps.store.update(this.deps.config.workerId, {
        status: this.status,
        lastHeartbeatAt: this.now(),
      });
    } catch (err) {
      // A dropped heartbeat is survivable — the reaper only acts after the lease
      // TTL, which spans many beats. Log and keep going.
      this.deps.logger.error("heartbeat failed", { error: String(err) });
    }
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Final transition: stop heartbeats and mark the row `stopped`. */
  async markStopped(): Promise<void> {
    this.stopHeartbeat();
    this.status = "stopped";
    const t = this.now();
    await this.deps.store.update(this.deps.config.workerId, {
      status: "stopped",
      stoppedAt: t,
      lastHeartbeatAt: t,
    });
    this.deps.logger.info("stopped", {});
  }
}
