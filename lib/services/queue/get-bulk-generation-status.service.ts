/**
 * Reads the state of one queued bulk generation, for the person who asked for it.
 *
 * This is the only path by which the app exposes a `jobs` row, so it is also the
 * only place that decides what a job row is allowed to say. Two rules:
 *
 *   • SCOPED BY COMPANY. The job is matched on its id AND its `companyId`, so a
 *     job id belonging to another company reads as NOT_FOUND rather than as a
 *     job somebody else is running. The id is a uuid, but "unguessable" is not
 *     an access control.
 *   • NEVER RETURNS `payload`. It holds the requester's user id and the whole
 *     instruction; nothing in the UI needs it, and a status poll is not the
 *     place to hand back the contents of a queue row.
 *
 * `result` IS returned, because that is the batch summary itself — the same
 * object the synchronous route used to answer with, written progressively as the
 * run commits each topic. The UI polls this and renders from it directly.
 */

import { prisma } from "@/lib/db/client";
import type { JobStatus } from "@prisma/client";
import {
  parseBulkGenerationProgress,
  type BulkGenerationProgress,
} from "@/lib/queue/bulk-generation-payload";
import { BULK_GENERATION_JOB_TYPE } from "@/lib/queue/job-types";

/**
 * What the run is doing, in the terms the UI actually needs.
 *
 * `queued` is split from the rest deliberately: it is the state that means "no
 * worker has picked this up yet", and — when it lasts — the state that means the
 * worker is down. That is a genuinely different thing to tell a user than
 * "working on it", so it is never smoothed into one "pending".
 */
export type BulkGenerationJobState = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface BulkGenerationStatus {
  jobId: string;
  state: BulkGenerationJobState;
  /** How many attempts have been started, and the ceiling. */
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  /**
   * The batch summary as far as it has got — the SAME shape the run finally
   * ends with, so a poll mid-flight and a poll after completion parse one thing.
   * Null until the first topic commits.
   */
  progress: BulkGenerationProgress | null;
  /**
   * Why the last attempt failed, when one did. Present on a `queued` job too:
   * that is a run which failed and is now waiting to be retried, and hiding the
   * reason would make the wait look like the first one.
   */
  lastError: string | null;
}

export type GetBulkGenerationStatusResult =
  { success: true; data: BulkGenerationStatus } | { success: false; code: "NOT_FOUND" };

/** Maps the queue's lifecycle onto what the UI distinguishes between. */
function toState(status: JobStatus, startedAt: Date | null): BulkGenerationJobState {
  switch (status) {
    case "active":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "queued":
      // A requeued job has a `startedAt` from its earlier attempt but is not
      // running now — it is waiting for a worker, exactly like a fresh one.
      return "queued";
    default:
      return startedAt ? "running" : "queued";
  }
}

export interface GetBulkGenerationStatusDeps {
  /** Resolves the company, and whether this user may read its jobs. */
  resolveAccess?: (
    slug: string,
    userId: string,
    isGlobalAdmin: boolean
  ) => Promise<{ companyId: string } | null>;
  findJob?: (jobId: string, companyId: string) => Promise<JobRow | null>;
}

export interface JobRow {
  id: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  result: unknown;
  lastError: string | null;
}

async function resolveAccessFromDb(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<{ companyId: string } | null> {
  const company = await prisma.company.findUnique({ where: { slug }, select: { id: true } });
  if (!company) return null;
  if (isGlobalAdmin) return { companyId: company.id };

  const membership = await prisma.companyMember.findFirst({
    where: { companyId: company.id, userId },
    select: { id: true },
  });
  return membership ? { companyId: company.id } : null;
}

/**
 * The job, scoped to the company AND the type.
 *
 * `findFirst` with both in the where clause rather than `findUnique` by id then
 * a check: the scoping is part of the query, so there is no moment at which an
 * out-of-scope row has been read.
 */
async function findJobFromDb(jobId: string, companyId: string): Promise<JobRow | null> {
  return prisma.job.findFirst({
    where: { id: jobId, companyId, type: BULK_GENERATION_JOB_TYPE },
    select: {
      id: true,
      status: true,
      attempts: true,
      maxAttempts: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
      result: true,
      lastError: true,
    },
  });
}

export async function getBulkGenerationStatus(
  slug: string,
  jobId: string,
  userId: string,
  isGlobalAdmin: boolean,
  deps: GetBulkGenerationStatusDeps = {}
): Promise<GetBulkGenerationStatusResult> {
  const resolveAccess = deps.resolveAccess ?? resolveAccessFromDb;
  const findJob = deps.findJob ?? findJobFromDb;

  const access = await resolveAccess(slug, userId, isGlobalAdmin);
  if (!access) return { success: false, code: "NOT_FOUND" };

  const job = await findJob(jobId, access.companyId);
  if (!job) return { success: false, code: "NOT_FOUND" };

  return {
    success: true,
    data: {
      jobId: job.id,
      state: toState(job.status, job.startedAt),
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      // Parsed rather than passed through raw: this crosses back out to a client,
      // and an unparseable diary entry should read as "nothing yet", not as an
      // arbitrary blob shaped by whatever last wrote to the column.
      progress: parseBulkGenerationProgress(job.result),
      lastError: job.lastError,
    },
  };
}
