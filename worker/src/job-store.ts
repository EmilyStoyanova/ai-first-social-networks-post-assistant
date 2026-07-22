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
  /** Mark a job completed, clearing its lease and storing the result. */
  complete(id: string, result: unknown, now: Date): Promise<void>;
  /** Requeue (with retryAt) or terminally fail a job, clearing its lease. */
  fail(input: FailInput): Promise<void>;
  /** Recover jobs whose lease expired: requeue if attempts remain, else fail. */
  reapExpired(now: Date): Promise<ReapResult>;
}
