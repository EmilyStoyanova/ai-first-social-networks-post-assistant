/**
 * The polling framework (Phase 1). A single loop that repeatedly asks a `claim`
 * hook for work, drives the worker's busy/idle status around each unit, and
 * sleeps between empty polls. Shutdown-aware: an in-flight poll wait is
 * interrupted immediately by stop().
 *
 * Phase 1 injects a `claim` that always returns null and a no-op `processJob`,
 * so the worker starts, goes idle, and stays idle. Phase 2 supplies real atomic
 * claiming and a job dispatcher WITHOUT changing this loop.
 */

import type { WorkerConfig } from "./config";
import type { Logger } from "./logger";
import type { WorkerLifecycle } from "./store";

/** Minimal shape of a claimed job. Phase 2 will widen this. */
export interface ClaimedJob {
  id: string;
  type: string;
}

/** The runner only needs to drive status — not the whole registry. */
interface StatusSink {
  setStatus(status: WorkerLifecycle): Promise<void>;
}

interface RunnerDeps {
  config: WorkerConfig;
  logger: Logger;
  registry: StatusSink;
  /** Returns the next job to run, or null when the queue has nothing due. */
  claim: () => Promise<ClaimedJob | null>;
  /** Executes a claimed job. */
  processJob: (job: ClaimedJob) => Promise<void>;
}

export class PollingRunner {
  private running = false;
  private stopping = false;
  private loopPromise: Promise<void> | null = null;
  /** Resolver that ends an in-flight poll sleep early (set only while sleeping). */
  private wake: (() => void) | null = null;

  constructor(private readonly deps: RunnerDeps) {}

  isRunning(): boolean {
    return this.running;
  }

  /** Begin polling. Idempotent — a second call while running is a no-op. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.loopPromise = this.loop();
  }

  /**
   * Stop polling and wait for the loop to unwind. Interrupts a poll sleep so
   * shutdown does not block for a full poll interval. In Phase 2 the loop also
   * finishes any in-flight job before it returns here.
   */
  async stop(): Promise<void> {
    if (!this.loopPromise) return;
    this.stopping = true;
    this.wake?.();
    await this.loopPromise;
    this.loopPromise = null;
  }

  private async loop(): Promise<void> {
    await this.deps.registry.setStatus("idle");

    while (!this.stopping) {
      let job: ClaimedJob | null = null;
      try {
        job = await this.deps.claim();
      } catch (err) {
        this.deps.logger.error("claim failed", { error: String(err) });
      }

      if (this.stopping) break;

      if (job) {
        await this.deps.registry.setStatus("busy");
        try {
          await this.deps.processJob(job);
        } catch (err) {
          this.deps.logger.error("job failed", { id: job.id, error: String(err) });
        }
        if (!this.stopping) {
          await this.deps.registry.setStatus("idle");
        }
      } else {
        await this.sleep(this.deps.config.pollIntervalMs);
      }
    }

    this.running = false;
  }

  /** Sleep that resolves early when stop() calls wake(). */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }
}
