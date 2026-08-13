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
import type { HandlerRegistry, JobProgress } from "./handler-registry";
import { computeBackoffMs, type BackoffOptions } from "./backoff";

/**
 * Floor under the lease-renewal cadence, so a very short TTL (tests use 1s)
 * cannot turn into a tight write loop against the database.
 */
const MIN_RENEWAL_INTERVAL_MS = 1_000;

/**
 * Renew at a THIRD of the TTL, not a half: a renewal that is merely late must
 * not be the difference between holding the lease and losing it. Two
 * consecutive misses are survivable, which is what makes this robust against a
 * slow database round trip rather than only against a fast one.
 */
const RENEWAL_FRACTION = 3;

interface OrchestratorDeps {
  store: JobStore;
  registry: HandlerRegistry;
  config: WorkerConfig;
  logger: Logger;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Retry backoff tuning (and injectable RNG for tests). */
  backoff?: BackoffOptions;
  /**
   * Timer seam for the lease-renewal loop, injected so the renewal can be driven
   * deterministically in tests instead of by waiting on a real clock. Returns
   * the canceller.
   */
  scheduleRenewal?: (intervalMs: number, tick: () => void) => () => void;
}

function defaultScheduleRenewal(intervalMs: number, tick: () => void): () => void {
  const timer = setInterval(tick, intervalMs);
  // Never hold the process open for a renewal timer; the job it belongs to is
  // always awaited, and shutdown must not wait for an interval to elapse.
  timer.unref?.();
  return () => clearInterval(timer);
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
    // Keeps the lease alive for as long as the handler runs, so a job that
    // legitimately takes longer than WORKER_LEASE_TTL_MS is not requeued out
    // from under itself and run a second time in parallel.
    const stopRenewal = this.startLeaseRenewal(job);
    try {
      const result = await handler({
        job,
        logger: this.deps.logger,
        reportProgress: (progress) => this.reportProgress(job, progress),
      });
      await this.deps.store.complete(job.id, result ?? null, this.now());
      this.deps.logger.info("job completed", {
        id: job.id,
        type: job.type,
        ms: Date.now() - startedAt,
      });
    } catch (err) {
      await this.onFailure(job, err);
    } finally {
      stopRenewal();
    }
  }

  /**
   * Starts the renewal loop for a job this worker holds, returning its canceller.
   *
   * A renewal that comes back false means the lease is already gone — the reaper
   * requeued the job, or it was cancelled — so renewing stops immediately rather
   * than trying to take it back from whichever attempt now owns it. The handler
   * is deliberately NOT aborted: it holds no cancellation seam, and killing it
   * mid-write would trade a duplicated job for a torn one. It is logged at error
   * level because it means a second execution is now possible, which is exactly
   * the condition this loop exists to prevent.
   */
  private startLeaseRenewal(job: JobRecord): () => void {
    const schedule = this.deps.scheduleRenewal ?? defaultScheduleRenewal;
    const intervalMs = Math.max(
      MIN_RENEWAL_INTERVAL_MS,
      Math.floor(this.deps.config.leaseTtlMs / RENEWAL_FRACTION)
    );

    let cancelled = false;
    const cancel = schedule(intervalMs, () => {
      if (cancelled) return;
      void this.renewOnce(job).then((held) => {
        if (!held && !cancelled) {
          cancelled = true;
          cancel();
        }
      });
    });

    return () => {
      cancelled = true;
      cancel();
    };
  }

  /** One renewal attempt. Never throws — a failed renewal is not a failed job. */
  private async renewOnce(job: JobRecord): Promise<boolean> {
    try {
      const held = await this.deps.store.renewLease({
        id: job.id,
        workerId: this.deps.config.workerId,
        leaseExpiresAt: new Date(this.now().getTime() + this.deps.config.leaseTtlMs),
      });
      if (!held) {
        this.deps.logger.error("lease lost while job was still running", {
          id: job.id,
          type: job.type,
        });
      }
      return held;
    } catch (err) {
      // A transient database error must not stop the loop: the next tick is
      // still inside the TTL (renewal runs at a third of it), so one failed
      // round trip is recoverable and two are still not fatal.
      this.deps.logger.warn("lease renewal failed", { id: job.id, error: String(err) });
      return true;
    }
  }

  /**
   * Best-effort progress write. Swallows everything: a handler reporting how far
   * it has got must never be the reason its work is lost.
   */
  private async reportProgress(job: JobRecord, progress: JobProgress): Promise<void> {
    try {
      const held = await this.deps.store.saveProgress({
        id: job.id,
        workerId: this.deps.config.workerId,
        progress,
      });
      if (!held) {
        this.deps.logger.warn("progress discarded — job no longer held by this worker", {
          id: job.id,
          type: job.type,
        });
      }
    } catch (err) {
      this.deps.logger.warn("progress write failed", { id: job.id, error: String(err) });
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
