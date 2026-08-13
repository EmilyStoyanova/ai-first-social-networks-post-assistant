/**
 * Storage seam for the job queue — the counterpart to WorkerStore.
 *
 * The orchestrator depends on this narrow interface rather than the Prisma
 * client directly, so claim/retry/reap logic is unit-testable without a
 * database. The Prisma-backed adapter (raw SQL for the atomic claim) lives in
 * prisma-adapters.ts; tests inject a fake.
 *
 * `JobLifecycle` mirrors the JobStatus enum in prisma/schema.prisma exactly.
 */

export type JobLifecycle = "queued" | "active" | "completed" | "failed" | "cancelled";

/** A job as handed to the orchestrator after a successful claim. */
export interface JobRecord {
  id: string;
  type: string;
  payload: unknown;
  /** Attempt count AFTER this claim (claiming increments it). Starts at 1. */
  attempts: number;
  maxAttempts: number;
  /**
   * Whatever the PREVIOUS attempt left behind via `saveProgress`, or null on a
   * first attempt.
   *
   * This is what makes a job resumable rather than merely retryable. Requeueing
   * on failure deliberately does not clear `result` (see the Prisma adapter), so
   * an attempt that wrote nine of fifteen posts and then lost its lease hands
   * the tenth attempt a record of the nine — which it skips instead of writing
   * again. Without it, "retry" would mean "pay for all of that a second time".
   *
   * Unvalidated by design: only the handler for this job type knows what shape
   * its own progress has, and the queue must not need to know.
   */
  result: unknown;
}

export interface EnqueueInput {
  type: string;
  payload: unknown;
  dedupeKey?: string | null;
  priority?: number;
  runAt?: Date;
  maxAttempts?: number;
  companyId?: string | null;
  createdBy?: string | null;
  cronRunId?: string | null;
}

export interface ClaimInput {
  workerId: string;
  now: Date;
  leaseExpiresAt: Date;
}

/**
 * Extending the lease on a job this worker is still running.
 *
 * Without this a job simply had to finish inside `WORKER_LEASE_TTL_MS` or the
 * reaper would requeue it mid-flight and a second worker would run it again —
 * observed in production on `rss-translation` (`attempts` 2 and 3 with
 * `last_error = "lease expired — requeued by reaper"`). Idempotent jobs survived
 * that; a job that writes posts and spends LLM credits would not.
 *
 * `workerId` is part of the identity of the operation, not a courtesy: a worker
 * whose lease has ALREADY been reaped must not be able to take it back from
 * whoever now holds it.
 */
export interface RenewLeaseInput {
  id: string;
  /** Only the worker currently holding the lease may extend it. */
  workerId: string;
  leaseExpiresAt: Date;
}

/**
 * Writing partial diagnostics while a job is still running.
 *
 * The queue only ever wrote `result` at the very end, which is fine for work
 * nobody is watching. A job a PERSON is waiting on has to be able to say how far
 * it has got — and, for a resumable job, to record what it has already done so a
 * retry can continue rather than repeat.
 *
 * Guarded by `workerId` for the same reason as the lease: a reaped worker must
 * not keep overwriting the progress of the attempt that replaced it.
 */
export interface SaveProgressInput {
  id: string;
  workerId: string;
  /** Replaces the job's `result` while it runs; the same shape it ends with. */
  progress: unknown;
}

export interface FailInput {
  id: string;
  error: string;
  now: Date;
  /** Set → requeue to run at this time; null → terminal failure. */
  retryAt: Date | null;
}

export interface ReapResult {
  requeued: number;
  failed: number;
}

export interface JobStore {
  /** Insert a queued job. Returns its id. Used by enqueuers (Phase 3) and tests. */
  enqueue(input: EnqueueInput): Promise<string>;
  /** Atomically lease the next due job to a worker (FOR UPDATE SKIP LOCKED). */
  claim(input: ClaimInput): Promise<JobRecord | null>;
  /**
   * Push this worker's lease further out. Returns false when the job is no
   * longer ours — reaped, completed, or cancelled — which the caller must treat
   * as "stop renewing", never as a transient error to retry.
   */
  renewLease(input: RenewLeaseInput): Promise<boolean>;
  /**
   * Store partial diagnostics on a running job. Returns false on the same
   * "no longer ours" condition as `renewLease`.
   */
  saveProgress(input: SaveProgressInput): Promise<boolean>;
  /** Mark a job completed, clearing its lease and storing the result. */
  complete(id: string, result: unknown, now: Date): Promise<void>;
  /** Requeue (with retryAt) or terminally fail a job, clearing its lease. */
  fail(input: FailInput): Promise<void>;
  /** Recover jobs whose lease expired: requeue if attempts remain, else fail. */
  reapExpired(now: Date): Promise<ReapResult>;
}
