/**
 * The queue engine. Claims work, dispatches it to the registered handler, and
 * persists the outcome — completion, retry-with-backoff, or terminal failure —
 * plus stale-lease reaping. Contains orchestration only; all real work lives in
 * the handlers (thin adapters over existing services).
 *
 * Depends on the JobStore + HandlerRegistry seams, so it is unit-testable with
 * in-memory fakes and an injectable clock.
 */

import type { WorkerConfig } from "./config";
import type { Logger } from "./logger";
import type { JobRecord, JobStore, ReapResult } from "./job-store";
import type { HandlerRegistry } from "./handler-registry";
import { computeBackoffMs, type BackoffOptions } from "./backoff";

interface OrchestratorDeps {
  store: JobStore;
  registry: HandlerRegistry;
  config: WorkerConfig;
  logger: Logger;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Retry backoff tuning (and injectable RNG for tests). */
  backoff?: BackoffOptions;
}

export class JobOrchestrator {
  private readonly now: () => Date;

  constructor(private readonly deps: OrchestratorDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Atomically claim the next due job, leasing it to this worker. */
  async claim(): Promise<JobRecord | null> {
    const now = this.now();
    const leaseExpiresAt = new Date(now.getTime() + this.deps.config.leaseTtlMs);
    return this.deps.store.claim({
      workerId: this.deps.config.workerId,
      now,
      leaseExpiresAt,
    });
  }

  /** Dispatch a claimed job to its handler and persist the outcome. */
  async process(job: JobRecord): Promise<void> {
    const handler = this.deps.registry.get(job.type);
    if (!handler) {
      // Unknown type: terminal — retrying cannot make a missing handler appear.
      this.deps.logger.error("no handler for job type", { id: job.id, type: job.type });
      await this.deps.store.fail({
        id: job.id,
        error: `No handler registered for job type "${job.type}"`,
        now: this.now(),
        retryAt: null,
      });
      return;
    }

    const startedAt = Date.now();
    try {
      const result = await handler({ job, logger: this.deps.logger });
      await this.deps.store.complete(job.id, result ?? null, this.now());
      this.deps.logger.info("job completed", {
        id: job.id,
        type: job.type,
        ms: Date.now() - startedAt,
      });
    } catch (err) {
      await this.onFailure(job, err);
    }
  }

  /** Requeue/fail jobs whose lease expired (e.g. a crashed worker). */
  async reapOnce(): Promise<ReapResult> {
    const res = await this.deps.store.reapExpired(this.now());
    if (res.requeued > 0 || res.failed > 0) {
      this.deps.logger.warn("reaped stale jobs", { ...res });
    }
    return res;
  }

  private async onFailure(job: JobRecord, err: unknown): Promise<void> {
    const now = this.now();
    const message = err instanceof Error ? err.message : String(err);
    const exhausted = job.attempts >= job.maxAttempts;

    if (exhausted) {
      await this.deps.store.fail({ id: job.id, error: message, now, retryAt: null });
      this.deps.logger.error("job failed permanently", {
        id: job.id,
        type: job.type,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        error: message,
      });
      return;
    }

    const delayMs = computeBackoffMs(job.attempts, this.deps.backoff);
    const retryAt = new Date(now.getTime() + delayMs);
    await this.deps.store.fail({ id: job.id, error: message, now, retryAt });
    this.deps.logger.warn("job failed, will retry", {
      id: job.id,
      type: job.type,
      attempts: job.attempts,
      retryInMs: delayMs,
      error: message,
    });
  }
}
