/**
 * Owns this process's row in the `workers` table: registration, status
 * transitions (starting → idle → busy → draining → stopped), and heartbeats.
 *
 * Depends only on WorkerStore + WorkerConfig + Logger, so its lifecycle logic is
 * unit-testable with an in-memory fake and no database.
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

  /** Transition to a new lifecycle status, stamping a heartbeat alongside it. */
  async setStatus(status: WorkerLifecycle): Promise<void> {
    this.status = status;
    await this.deps.store.update(this.deps.config.workerId, {
      status,
      lastHeartbeatAt: this.now(),
    });
    this.deps.logger.info("status", { status });
  }

  /** Begin periodic heartbeats. Idempotent — a second call is a no-op. */
  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeatOnce();
    }, this.deps.config.heartbeatIntervalMs);
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
