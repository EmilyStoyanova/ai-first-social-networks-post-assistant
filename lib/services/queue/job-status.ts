/**
 * Reading ONE queue row on behalf of the person who asked for it.
 *
 * This is the only path by which the app exposes a `jobs` row to a client, so it
 * is also the only place that decides what a job row is allowed to say. Two
 * rules, and they are the whole reason this is shared rather than written once
 * per job type:
 *
 *   • SCOPED BY COMPANY AND TYPE. The job is matched on its id, its `companyId`
 *     AND its `type`, in the query rather than in a check afterwards — so there
 *     is no moment at which an out-of-scope row has been read. A job id from
 *     another company, or a bulk id handed to the topic endpoint, answers
 *     NOT_FOUND rather than confirming that something exists. The ids are uuids,
 *     but "unguessable" is not an access control.
 *   • NEVER RETURNS `payload`. It holds the requester's user id and the whole
 *     instruction; nothing in any UI needs it, and a status poll is not the place
 *     to hand back the contents of a queue row.
 *
 * `result` IS returned — parsed by the caller's own reader — because that is the
 * run's report of itself, written progressively as it commits. The UI polls this
 * and renders from it directly.
 *
 * Extracted from the bulk status service when a second job type needed exactly
 * these guarantees. Two copies of an access rule is how one of them ends up
 * missing a clause.
 */

import { prisma } from "@/lib/db/client";
import type { JobStatus } from "@prisma/client";

/**
 * What a run is doing, in the terms a UI actually needs.
 *
 * `queued` is split from the rest deliberately: it is the state that means "no
 * worker has picked this up yet", and — when it lasts — the state that means the
 * worker is down. That is a genuinely different thing to tell a user than
 * "working on it", so it is never smoothed into one "pending".
 */
export type JobLifecycleState = "queued" | "running" | "completed" | "failed" | "cancelled";

/** The columns a status read is allowed to touch. Note the absent `payload`. */
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

/** The status of one job, with its progress parsed into the caller's shape. */
export interface JobStatusView<TProgress> {
  jobId: string;
  state: JobLifecycleState;
  /** How many attempts have been started, and the ceiling. */
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  /**
   * The run's report as far as it has got — the SAME shape it finally ends with,
   * so a poll mid-flight and a poll after completion parse one thing. Null until
   * the run first records something.
   */
  progress: TProgress | null;
  /**
   * Why the last attempt failed, when one did. Present on a `queued` job too:
   * that is a run which failed and is now waiting to be retried, and hiding the
   * reason would make the wait look like the first one.
   */
  lastError: string | null;
}

export type JobStatusResult<TProgress> =
  { success: true; data: JobStatusView<TProgress> } | { success: false; code: "NOT_FOUND" };

/** Resolves a company and whether this user may read its jobs. */
export type ResolveJobAccess = (
  slug: string,
  userId: string,
  isGlobalAdmin: boolean
) => Promise<{ companyId: string } | null>;

/** Finds one job, already scoped to a company and a type. */
export type FindJobRow = (jobId: string, companyId: string, type: string) => Promise<JobRow | null>;

export interface JobStatusDeps {
  resolveAccess?: ResolveJobAccess;
  findJob?: FindJobRow;
}

/** Maps the queue's lifecycle onto what a UI distinguishes between. */
export function toJobState(status: JobStatus, startedAt: Date | null): JobLifecycleState {
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

/**
 * The company, if this user may read its jobs.
 *
 * The same shape every mutating service uses: a global admin bypasses the
 * membership check, and a non-member is told NOT_FOUND rather than FORBIDDEN so
 * the existence of another company's slug is never confirmed.
 */
export async function resolveJobAccessFromDb(
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
async function findJobRowFromDb(
  jobId: string,
  companyId: string,
  type: string
): Promise<JobRow | null> {
  return prisma.job.findFirst({
    where: { id: jobId, companyId, type },
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

/**
 * Reads one job for a client, parsing its `result` with the caller's own reader.
 *
 * `parseProgress` is passed in rather than inferred because each job type
 * records a different report, and the parse is what stops an arbitrary blob —
 * whatever last wrote to that column — from crossing back out to a browser.
 * A reader that cannot make sense of the value must answer null, not throw.
 */
export async function readJobStatus<TProgress>(params: {
  slug: string;
  jobId: string;
  userId: string;
  isGlobalAdmin: boolean;
  /** The job type this endpoint serves. Part of the scoping, not a filter. */
  type: string;
  parseProgress: (value: unknown) => TProgress | null;
  deps?: JobStatusDeps;
}): Promise<JobStatusResult<TProgress>> {
  const resolveAccess = params.deps?.resolveAccess ?? resolveJobAccessFromDb;
  const findJob = params.deps?.findJob ?? findJobRowFromDb;

  const access = await resolveAccess(params.slug, params.userId, params.isGlobalAdmin);
  if (!access) return { success: false, code: "NOT_FOUND" };

  const job = await findJob(params.jobId, access.companyId, params.type);
  if (!job) return { success: false, code: "NOT_FOUND" };

  return {
    success: true,
    data: {
      jobId: job.id,
      state: toJobState(job.status, job.startedAt),
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      progress: params.parseProgress(job.result),
      lastError: job.lastError,
    },
  };
}
