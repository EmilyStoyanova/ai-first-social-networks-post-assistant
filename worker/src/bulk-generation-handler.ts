/**
 * Manual bulk generation job handler — a THIN ADAPTER over `bulkGeneratePosts`.
 *
 * The worker is an orchestrator only: nothing about generation, prompts, images,
 * scheduling, duplicate protection or content mixes lives here. This handler
 * does four things and delegates everything else:
 *
 *   1. validates the payload (the schema is shared with the enqueuing route),
 *   2. re-resolves the requester's admin rights AT EXECUTION TIME,
 *   3. rebuilds the resume state from what a previous attempt recorded,
 *   4. runs the service, reporting its summary as progress after every topic.
 *
 * ── What is and is not a retry ──────────────────────────────────────────────
 *
 * A per-topic or per-channel generation failure is DATA, not an exception: the
 * pool ran dry, a candidate stayed a duplicate, one channel's text was too long
 * with its source link. The service already reports each of those with a code
 * and a reason, and every post it did write is committed. So the handler returns
 * normally and the job COMPLETES — a partial batch, honestly described.
 *
 * Retrying those would be actively wrong. `classifyBulkFailure` explains why per
 * failure, but the short version is that none of them are different a minute
 * later, and each attempt spends real money to find that out again.
 *
 * What DOES throw — and so reaches the queue's retry policy — is a job-level
 * fault: an unparseable payload, a requester who no longer exists, or the
 * service refusing the request outright. Plus anything genuinely exceptional
 * (the database going away), which propagates on its own.
 *
 * ── Resumption ──────────────────────────────────────────────────────────────
 *
 * Progress is written after every topic, and requeueing does not clear it, so
 * attempt 2 starts from attempt 1's record: the groups it opened, the channels
 * it committed, and — the load-bearing part — the ANCHOR each half-written group
 * settled on. Without that last one the channels still missing would each decide
 * a topic of their own and the group would fragment into unrelated posts.
 */

import type { JobHandler } from "./handler-registry";
import type { WorkerConfig } from "./config";
import {
  bulkGenerationPayloadSchema,
  parseBulkGenerationProgress,
  type BulkGenerationPayload,
} from "@/lib/queue/bulk-generation-payload";
import { BULK_GENERATION_JOB_TYPE } from "@/lib/queue/job-types";
import {
  bulkGeneratePosts,
  type BulkGeneratePostsResult,
  type BulkGeneratedPost,
  type BulkResumeState,
} from "@/lib/services/ai/bulk-generate-posts.service";
import type { TopicAnchor } from "@/lib/services/ai/generate-topic-across-channels.service";
import { parseManualContentSource } from "@/lib/ai/manual-content-source";

export { BULK_GENERATION_JOB_TYPE };

/**
 * Compact, operator-facing diagnostics persisted as the job's `result` — and,
 * because it is the same object the UI polls, the batch summary itself.
 *
 * A `type` (not `interface`) so it carries an index signature and satisfies
 * `JobResult`.
 */
export type BulkGenerationDiagnostics = Record<string, unknown>;

/** Reads the requester's CURRENT admin rights. Null when the user is gone. */
export type ResolveRequester = (userId: string) => Promise<{ isGlobalAdmin: boolean } | null>;

async function defaultResolveRequester(userId: string): Promise<{ isGlobalAdmin: boolean } | null> {
  const { prisma } = await import("@/lib/db/client");
  return prisma.user.findUnique({
    where: { id: userId },
    select: { isGlobalAdmin: true },
  });
}

/**
 * Rebuilds what a previous attempt committed, from the progress it recorded.
 *
 * Only the parts a resumed run needs to avoid repeating work: which group each
 * topic opened, which channels it already has, the topic each group settled on,
 * and the posts themselves so the final summary describes the whole batch rather
 * than only this attempt's share of it.
 *
 * Returns undefined when there is nothing usable to resume from, which is the
 * ordinary first-attempt case.
 */
export function toResumeState(progress: unknown): BulkResumeState | undefined {
  const parsed = parseBulkGenerationProgress(progress);
  if (!parsed) return undefined;

  const contentGroupIds: Record<number, string> = {};
  const completedChannels: Record<number, string[]> = {};
  const anchors: Record<number, TopicAnchor> = {};
  const posts: BulkGeneratedPost[] = [];

  for (const group of parsed.groups ?? []) {
    contentGroupIds[group.index] = group.contentGroupId;
    for (const p of group.posts) {
      completedChannels[group.index] ??= [];
      completedChannels[group.index].push(p.channel);
      posts.push({
        index: p.index,
        postId: p.postId,
        channel: p.channel,
        contentGroupId: p.contentGroupId,
        // Back from ISO. The value only ever feeds the summary the caller reads;
        // each post's real schedule is already committed on its own row.
        scheduledFor: new Date(p.scheduledFor),
      });
    }
  }

  // The topic that was mid-flight when the attempt stopped. Its posts are
  // committed but were never folded into a finished group, so they are picked up
  // here — otherwise a resumed run would write them a second time.
  const live = parsed.liveTopic;
  if (live) {
    contentGroupIds[live.index] ??= live.contentGroupId;
    const known = new Set(completedChannels[live.index] ?? []);
    for (const channel of live.completedChannels) {
      if (known.has(channel)) continue;
      known.add(channel);
      completedChannels[live.index] = [...known];
    }
    if (live.anchor) anchors[live.index] = live.anchor;
  }

  const nothingToResume =
    Object.keys(contentGroupIds).length === 0 && Object.keys(completedChannels).length === 0;
  if (nothingToResume) return undefined;

  return { contentGroupIds, completedChannels, anchors, posts };
}

/** Maps the validated payload onto the service's input, unchanged in meaning. */
function toServiceInput(payload: BulkGenerationPayload, jobId: string) {
  return {
    // Recorded on every post's generation trace, so a run can be tied back to
    // the job that executed it. Descriptive only.
    jobId,
    channels: payload.channels,
    numberOfPosts: payload.numberOfPosts,
    startDate: payload.startDate,
    endDate: payload.endDate,
    customDistribution: payload.distribution,
    contentLanguage: payload.contentLanguage,
    includeSourceLinkOverride: payload.includeSourceLink,
    autoGenerateImageOverride: payload.generateImage,
    llmConfigId: payload.llmConfigId,
    contentSource: parseManualContentSource(payload.contentSource),
    sourceMix: payload.sourceMix,
  };
}

export interface BulkGenerationHandlerDeps {
  /** The bulk pipeline. Injected in tests; never re-implemented. */
  generate?: typeof bulkGeneratePosts;
  /** Reads the requester's current admin rights. */
  resolveRequester?: ResolveRequester;
  /** Wall-clock budget for one attempt. */
  bulkBudgetMs?: number;
}

/**
 * Factory so tests can inject the pipeline and the requester lookup; production
 * wires the real service, which owns every generation decision itself.
 */
export function createBulkGenerationHandler(deps: BulkGenerationHandlerDeps = {}): JobHandler {
  const generate = deps.generate ?? bulkGeneratePosts;
  const resolveRequester = deps.resolveRequester ?? defaultResolveRequester;

  return async ({ job, logger, reportProgress }) => {
    const payload = bulkGenerationPayloadSchema.safeParse(job.payload);
    if (!payload.success) {
      // Terminal in practice: a malformed payload is malformed on every attempt.
      // Thrown rather than returned so the queue records it as a failure — a job
      // that never ran must not look like a batch that produced nothing.
      throw new Error(
        `Invalid bulk-generation payload: ${payload.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`
      );
    }
    const input = payload.data;

    // Authorization is re-resolved HERE, not taken from the payload: a job can
    // sit in the queue across the moment someone's admin rights are revoked, and
    // the run has to be authorized against what is true when the posts are
    // written. Company membership is checked per generation inside the service,
    // as it is for every other caller.
    const requester = await resolveRequester(input.userId);
    if (!requester) {
      throw new Error(`Bulk generation requester ${input.userId} no longer exists`);
    }

    const resume = toResumeState(job.result);
    logger.info("bulk generation starting", {
      jobId: job.id,
      attempt: job.attempts,
      slug: input.slug,
      topics: input.numberOfPosts,
      channels: input.channels.join(","),
      resumedPosts: resume?.posts.length ?? 0,
    });

    // The content-group ids come from the payload's plan, in topic order, so a
    // retry re-opens the SAME groups rather than creating a second set beside
    // the ones it already wrote into.
    let nextGroup = 0;

    const result: BulkGeneratePostsResult = await generate(
      input.slug,
      input.userId,
      requester.isGlobalAdmin,
      toServiceInput(input, job.id),
      {
        newBatchId: () => input.batchId,
        newContentGroupId: () => input.contentGroupIds[nextGroup++] ?? crypto.randomUUID(),
        resume,
        // Every topic (and every channel within it) updates the job's `result`,
        // which is both what the UI polls and what the next attempt resumes
        // from. Best-effort by contract on both sides.
        onProgress: async (summary) => {
          await reportProgress?.(summary as unknown as Record<string, unknown>);
        },
        softBudgetMs: deps.bulkBudgetMs,
      }
    );

    if (!result.success) {
      // The service refused the request, or nothing at all could be generated.
      // Either way no post exists and the reason is in the code — thrown so the
      // queue records a failure rather than an empty success.
      logger.error("bulk generation produced nothing", {
        jobId: job.id,
        slug: input.slug,
        code: result.code,
      });
      throw new Error(`Bulk generation failed (${result.code})${bulkSuffix(result.message)}`);
    }

    const summary = result.data;
    logger.info("bulk generation completed", {
      jobId: job.id,
      slug: input.slug,
      batchId: summary.batchId,
      topics: `${summary.generated}/${summary.requested}`,
      posts: `${summary.generatedPosts}/${summary.requestedPosts}`,
      stopReason: summary.stopReason,
      failures: summary.failures.length,
    });

    // Returned, not thrown, even when some topics or channels failed: those posts
    // are real and committed, and retrying the batch would write the ones that
    // succeeded all over again.
    return summary as unknown as BulkGenerationDiagnostics;
  };
}

function bulkSuffix(message: string | undefined): string {
  return message ? `: ${message}` : "";
}

/** The production handler, wired to the real bulk service. */
export function bulkGenerationHandlerFor(config: WorkerConfig): JobHandler {
  return createBulkGenerationHandler({ bulkBudgetMs: config.bulkBudgetMs });
}
