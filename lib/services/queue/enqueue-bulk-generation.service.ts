/**
 * Queues one manual bulk-generation request.
 *
 * Sits between the route and the generic `enqueueJob`, and owns the four things
 * that are specific to THIS job type rather than to queueing in general:
 *
 *   1. the access check — the queue has no idea who may generate for a company;
 *   2. the request check — every rule that can be decided before generation
 *      starts, run HERE so a malformed request is refused with a 422 while there
 *      is still an HTTP response to refuse it with. The rules themselves live in
 *      `validate-bulk-request.service.ts` and are shared with the service the
 *      worker runs, so neither end re-states them;
 *   3. the plan — the batch id and one content-group id per topic, minted here
 *      so they are stable across every attempt the worker makes;
 *   4. the honest answer to a collision — see below.
 *
 * Point 2 is what keeps moving this work onto a queue from being a regression.
 * A request for eleven topics, or a period that started last week, or a content
 * mix that does not add up is wrong the moment it is typed; accepting it with a
 * 202 and failing in a worker log would leave the person who typed it watching a
 * progress bar for a job that was never going to write anything.
 *
 * ── Why a rejected dedupe is reported, not swallowed ────────────────────────
 *
 * Every other enqueuer in this app treats deduplication as success, and rightly:
 * a cron sweep holds no per-tick state, so the run already in flight covers
 * exactly what the rejected one would have. A bulk request is the opposite. It
 * carries specific instructions — these channels, this many topics, this period,
 * this content mix — so the run already under way is NOT the run the second
 * person asked for. Telling them "done!" would be a lie that costs them a batch.
 */

import { prisma } from "@/lib/db/client";
import { enqueueJob } from "./enqueue-job.service";
import {
  BULK_GENERATION_JOB_TYPE,
  BULK_GENERATION_MAX_ATTEMPTS,
  bulkGenerationDedupeKey,
} from "@/lib/queue/job-types";
import {
  bulkGenerationPayloadSchema,
  type BulkGenerationPayload,
} from "@/lib/queue/bulk-generation-payload";
import {
  validateBulkRequest,
  type BulkRequestErrorCode,
} from "@/lib/services/ai/validate-bulk-request.service";
import { parseManualContentSource } from "@/lib/ai/manual-content-source";
import type { Prisma } from "@prisma/client";

/** The request, before the plan is minted onto it. */
export type BulkGenerationRequest = Omit<
  BulkGenerationPayload,
  "slug" | "userId" | "batchId" | "contentGroupIds"
>;

export interface EnqueuedBulkGeneration {
  jobId: string;
  /** Stamped on every post the run writes; the UI can show it immediately. */
  batchId: string;
  /** One per topic, in order — the groups the run will fill. */
  contentGroupIds: string[];
}

export type EnqueueBulkGenerationResult =
  | { success: true; data: EnqueuedBulkGeneration }
  | { success: false; code: "NOT_FOUND" }
  | { success: false; code: "FORBIDDEN" }
  | { success: false; code: "INVALID_PAYLOAD"; message: string }
  /**
   * The request itself is wrong, in one of the five ways that were always
   * answered synchronously. Same codes and same wording as before this work ran
   * on a queue — a caller cannot tell the difference.
   */
  | { success: false; code: BulkRequestErrorCode; message: string }
  /** A run for this company is already queued or in flight. */
  | {
      success: false;
      code: "ALREADY_RUNNING";
      message: string;
      /**
       * The run that is already going, when it could be identified. Lets the
       * caller resume watching it instead of being left with a dead end — see
       * the lookup below for why this is safe.
       */
      jobId: string | null;
    };

export interface EnqueueBulkGenerationDeps {
  /** Resolves the company and whether this user may generate for it. */
  resolveAccess?: (
    slug: string,
    userId: string,
    isGlobalAdmin: boolean
  ) => Promise<{ companyId: string } | null>;
  enqueue?: typeof enqueueJob;
  newBatchId?: () => string;
  newContentGroupId?: () => string;
  /** The company's enabled content-source ids, for a submitted mix. */
  loadEnabledSourceIds?: (slug: string) => Promise<Set<string>>;
  /** A channel's saved posting windows, for an even distribution. */
  loadPostingWindows?: (slug: string, channel: string) => Promise<unknown>;
  /** Finds the non-terminal run this company already has, for a collision. */
  findRunningJob?: (companyId: string) => Promise<{ id: string } | null>;
  /** Wall clock, injected so "is the start date in the past" is fixed in tests. */
  now?: () => number;
}

/**
 * The bulk job this company already has queued or running.
 *
 * Read only to answer a collision, and scoped by the same `companyId` the caller
 * was just granted access to — so this can only ever return a job the caller is
 * already entitled to read through the status endpoint. Nothing about the job
 * but its id is returned.
 */
async function findRunningJobFromDb(companyId: string): Promise<{ id: string } | null> {
  return prisma.job.findFirst({
    where: {
      companyId,
      type: BULK_GENERATION_JOB_TYPE,
      status: { in: ["queued", "active"] },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
}

/**
 * The company, if this user may generate for it.
 *
 * The same shape every mutating service uses: a global admin bypasses the
 * membership check, and a non-member is told NOT_FOUND rather than FORBIDDEN so
 * the existence of another company's slug is never confirmed.
 */
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

export async function enqueueBulkGeneration(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean,
  request: BulkGenerationRequest,
  deps: EnqueueBulkGenerationDeps = {}
): Promise<EnqueueBulkGenerationResult> {
  const resolveAccess = deps.resolveAccess ?? resolveAccessFromDb;
  const enqueue = deps.enqueue ?? enqueueJob;
  const newBatchId = deps.newBatchId ?? (() => crypto.randomUUID());
  const newContentGroupId = deps.newContentGroupId ?? (() => crypto.randomUUID());
  const findRunningJob = deps.findRunningJob ?? findRunningJobFromDb;
  const now = deps.now ?? Date.now;

  // Checked before anything is minted or written: a caller who may not generate
  // for this company must not be able to occupy its dedupe slot.
  const access = await resolveAccess(slug, userId, isGlobalAdmin);
  if (!access) return { success: false, code: "NOT_FOUND" };

  // Every rule that can be decided before generation starts, answered NOW —
  // the same five codes, the same wording, the same order as when this route ran
  // the batch inline. Runtime outcomes (a dry pool, a duplicate candidate, an
  // unreachable provider) are deliberately not among them: those are results,
  // not request errors, and are reported per topic while the run happens.
  const problem = await validateBulkRequest(
    slug,
    {
      // Read by the posting-window check: an even spread over a channel with no
      // schedule has no times to spread across, and that is answerable now.
      channels: request.channels,
      numberOfPosts: request.numberOfPosts,
      startDate: request.startDate,
      endDate: request.endDate,
      customDistribution: request.distribution,
      // Parsed to the same ref the service compares against, so "a mix and a
      // single picked source together" is refused identically at both ends.
      contentSource: parseManualContentSource(request.contentSource),
      sourceMix: request.sourceMix,
    },
    new Date(now()),
    {
      loadEnabledSourceIds: deps.loadEnabledSourceIds,
      loadPostingWindows: deps.loadPostingWindows,
    }
  );
  if (problem !== null) return { success: false, ...problem };

  // The plan. Both ids are decided HERE — once — because the worker cannot mint
  // them: attempt 2 would mint different ones, and a retry would then open a
  // second content group beside every half-written one.
  const batchId = newBatchId();
  const contentGroupIds = Array.from({ length: request.numberOfPosts }, () => newContentGroupId());

  // Validated on the way in as well as on the way out. The payload crosses a
  // process boundary, so the moment to find out it is malformed is now — while
  // there is still an HTTP response to say so on — not in a worker log.
  const payload = bulkGenerationPayloadSchema.safeParse({
    ...request,
    slug,
    userId,
    batchId,
    contentGroupIds,
  });
  if (!payload.success) {
    return {
      success: false,
      code: "INVALID_PAYLOAD",
      message: payload.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }

  const result = await enqueue({
    type: BULK_GENERATION_JOB_TYPE,
    payload: payload.data as unknown as Prisma.InputJsonValue,
    // One bulk run per company at a time. Two concurrent batches would draw on
    // the same article pool while each measures uniqueness against a history the
    // other is concurrently writing.
    dedupeKey: bulkGenerationDedupeKey(slug),
    // Above the recurring sweeps: someone is watching this one.
    priority: 10,
    maxAttempts: BULK_GENERATION_MAX_ATTEMPTS,
    // Written with the row, not patched on after: this is what the status
    // endpoint scopes its read by, so a job that existed for even a moment
    // without it would be a job momentarily readable by the wrong company.
    companyId: access.companyId,
    createdBy: userId,
  });

  if (!result.enqueued || result.jobId === null) {
    // Hand back the run that IS going, so the caller can resume watching it
    // rather than being left with an error and no way back to their batch. Safe
    // and minimal: the lookup is scoped to the company access was just granted
    // for, and the id only unlocks the status endpoint, which is scoped the same
    // way. Null when the collision resolved before it could be read — a race,
    // and the caller simply retries.
    const running = await findRunningJob(access.companyId).catch(() => null);
    return {
      success: false,
      code: "ALREADY_RUNNING",
      message: "A bulk generation for this company is already running. Wait for it to finish.",
      jobId: running?.id ?? null,
    };
  }

  return {
    success: true,
    data: { jobId: result.jobId, batchId, contentGroupIds },
  };
}
