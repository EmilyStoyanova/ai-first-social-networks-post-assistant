/**
 * Queued topic generation — a THIN ADAPTER over `generateTopicAcrossChannels`.
 *
 * The worker is an orchestrator only: nothing about generation, prompts, images,
 * anchoring, source pinning or duplicate protection lives here. This handler
 * does four things and delegates everything else:
 *
 *   1. validates the payload (the schema is shared with the enqueuing route),
 *   2. re-resolves the requester's admin rights AT EXECUTION TIME,
 *   3. rebuilds the resume state from what a previous attempt recorded,
 *   4. runs the orchestrator, reporting after every channel that commits.
 *
 * It is the same shape `bulk-generation-handler.ts` has over `bulkGeneratePosts`
 * — one layer down, because a topic is what bulk runs N of.
 *
 * ── Why the run gets its time back ──────────────────────────────────────────
 *
 * This job exists because of a measurement: against a self-hosted image worker
 * one channel costs about 158s, so two channels do not fit under a 300s function
 * cap. The synchronous route could only choose which channel to DROP, and a
 * dropped channel is not the worst of it — a channel admitted with less time
 * than it needs writes its post, then has every image call aborted at a budget
 * of zero and commits a draft with an image prompt and no image, which on an
 * `imageRequired` channel cannot be published at all.
 *
 * Here there is no function cap. The budget below is a CEILING against a wedged
 * run holding its lease forever, not a pace to keep: at the worker's default it
 * is 30 minutes for at most four channels, so the orchestrator's own gate — now
 * sized from what a channel has actually cost this run — never has to refuse
 * one. Every selected channel gets written, which is the entire point.
 *
 * ── What is and is not a retry ──────────────────────────────────────────────
 *
 * A per-channel failure is DATA, not an exception: the pool ran dry, a candidate
 * stayed a duplicate, the text was too long with its source link. None of those
 * are different a minute later and each attempt spends real money to find that
 * out again — so they are recorded and the job COMPLETES, exactly as the
 * synchronous route answered 201 with a `failures` array. Even a topic where
 * EVERY channel failed completes: the reason is in the progress, structured, and
 * a `lastError` string could not carry the code the UI translates.
 *
 * What DOES throw — and so reaches the queue's retry policy — is a job-level
 * fault: an unparseable payload, or a requester who no longer exists. Plus
 * anything genuinely exceptional (the database going away), which propagates on
 * its own and is precisely what the one retry exists for.
 */

import type { JobHandler } from "./handler-registry";
import type { WorkerConfig } from "./config";
import {
  topicGenerationPayloadSchema,
  parseTopicGenerationProgress,
  type TopicGenerationPayload,
  type TopicGenerationProgress,
} from "@/lib/queue/topic-generation-payload";
import { TOPIC_GENERATION_JOB_TYPE } from "@/lib/queue/job-types";
import {
  generateTopicAcrossChannels,
  type TopicAnchor,
  type TopicGenerationOutcome,
} from "@/lib/services/ai/generate-topic-across-channels.service";
import { parseManualContentSource } from "@/lib/ai/manual-content-source";
import { createRequestDeadline, runInRequestDeadline } from "@/lib/http/request-deadline";

export { TOPIC_GENERATION_JOB_TYPE };

/** Persisted as the job's `result` — and, because it is the same object the UI
 *  polls, the run's report of itself. A `type` so it satisfies `JobResult`. */
export type TopicGenerationDiagnostics = Record<string, unknown>;

/**
 * The default ceiling when the worker config does not name one: 15 minutes,
 * against a topic that is at most four channels of roughly 158s each.
 *
 * Generous on purpose. Its job is to stop a wedged run holding its lease
 * forever, not to decide how many channels get written — the moment a ceiling
 * starts doing the latter it is the function cap again, with the same silently
 * half-written posts.
 */
export const DEFAULT_TOPIC_BUDGET_MS = 900_000;

/** Reads the requester's CURRENT admin rights. Null when the user is gone. */
export type ResolveRequester = (userId: string) => Promise<{ isGlobalAdmin: boolean } | null>;

async function defaultResolveRequester(userId: string): Promise<{ isGlobalAdmin: boolean } | null> {
  const { prisma } = await import("@/lib/db/client");
  return prisma.user.findUnique({
    where: { id: userId },
    select: { isGlobalAdmin: true },
  });
}

/** What a previous attempt committed, in the terms the orchestrator resumes on. */
export interface TopicResumeState {
  /** Channels already written. Skipped outright — not regenerated, not failed. */
  alreadyGenerated: string[];
  /** The topic those channels settled on, so the rest continue THAT story. */
  anchor: TopicAnchor | null;
  /** Their recorded entries, so the final report describes the whole topic. */
  posts: TopicGenerationProgress["posts"];
}

/**
 * Rebuilds what a previous attempt committed, from the progress it recorded.
 *
 * Returns null when there is nothing usable, which is the ordinary first-attempt
 * case. The anchor is the load-bearing part: without it the channels still
 * missing would each decide a topic of their own, and a retry would turn one
 * group into a set of unrelated posts sharing an id.
 */
export function toTopicResumeState(progress: unknown): TopicResumeState | null {
  const parsed = parseTopicGenerationProgress(progress);
  if (!parsed || parsed.posts.length === 0) return null;

  return {
    alreadyGenerated: parsed.posts.map((p) => p.channel),
    anchor: parsed.anchor ?? null,
    posts: parsed.posts,
  };
}

/**
 * This attempt's outcome, folded together with what earlier attempts wrote.
 *
 * The orchestrator reports only what IT has written, which is correct for it and
 * wrong for a diary that has to survive a retry: a resumed run whose progress
 * listed only its own channels would drop the ones attempt 1 committed, both
 * from the grid and from what attempt 3 could resume on.
 *
 * Earlier posts come first, so the recorded order stays the order they were
 * written in. Deduped by channel because a channel can only have one version of
 * a topic — and if the two ever disagreed, the committed one is the earlier.
 */
export function mergeTopicProgress(
  // `channels` is only read and copied, so it is taken as readonly rather than
  // as the payload's own mutable array — the narrower type would force every
  // caller to hand over something this function could mutate but never does.
  payload: Pick<TopicGenerationPayload, "contentGroupId"> & { channels: readonly string[] },
  outcome: TopicGenerationOutcome,
  resume: TopicResumeState | null
): TopicGenerationProgress {
  const earlier = resume?.posts ?? [];
  const seen = new Set(earlier.map((p) => p.channel));

  const fresh = outcome.posts
    .filter((p) => !seen.has(p.channel))
    .map((p) => ({
      channel: p.channel,
      postId: p.postId,
      scheduledFor: p.scheduledFor ? p.scheduledFor.toISOString() : null,
      post: p.post as unknown as Record<string, unknown>,
      warnings: p.warnings as unknown as Record<string, unknown>,
    }));

  return {
    contentGroupId: payload.contentGroupId,
    companyId: outcome.companyId,
    // The channels ASKED FOR, not the ones written — this is the denominator the
    // UI counts against, and it must not shrink on a resumed attempt that was
    // only handed the remainder.
    channels: [...payload.channels],
    posts: [...earlier, ...fresh],
    failures: outcome.failures.map((f) => ({
      channel: f.channel,
      code: f.code,
      message: f.message,
      reason: f.reason,
      attempts: f.attempts,
      retryAfterMs: f.retryAfterMs,
    })),
    notAttempted: [...outcome.notAttempted],
    anchor: outcome.anchor,
  };
}

export interface TopicGenerationHandlerDeps {
  /** The per-topic fan-out. Injected in tests; never re-implemented. */
  generateTopic?: typeof generateTopicAcrossChannels;
  /** Reads the requester's current admin rights. */
  resolveRequester?: ResolveRequester;
  /** Wall-clock ceiling for one attempt. See the docblock — a ceiling, not a pace. */
  budgetMs?: number;
  /** Injected so a budget test need not wait for one. */
  now?: () => number;
}

export function createTopicGenerationHandler(deps: TopicGenerationHandlerDeps = {}): JobHandler {
  const generateTopic = deps.generateTopic ?? generateTopicAcrossChannels;
  const resolveRequester = deps.resolveRequester ?? defaultResolveRequester;
  const now = deps.now ?? Date.now;

  return async ({ job, logger, reportProgress }) => {
    const payload = topicGenerationPayloadSchema.safeParse(job.payload);
    if (!payload.success) {
      // Terminal in practice: a malformed payload is malformed on every attempt.
      // Thrown rather than returned so the queue records it as a failure — a job
      // that never ran must not look like a topic that produced nothing.
      throw new Error(
        `Invalid topic-generation payload: ${payload.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`
      );
    }
    const input = payload.data;

    // Authorization is re-resolved HERE, not taken from the payload: a job can
    // sit in the queue across the moment someone's admin rights are revoked, and
    // the run has to be authorized against what is true when the posts are
    // written. Company membership is checked per generation inside the service.
    const requester = await resolveRequester(input.userId);
    if (!requester) {
      throw new Error(`Topic generation requester ${input.userId} no longer exists`);
    }

    const resume = toTopicResumeState(job.result);
    const remaining = input.channels.filter((c) => !(resume?.alreadyGenerated ?? []).includes(c));

    logger.info("topic generation starting", {
      jobId: job.id,
      attempt: job.attempts,
      slug: input.slug,
      channels: input.channels.join(","),
      remaining: remaining.join(","),
      resumedPosts: resume?.posts.length ?? 0,
    });

    // Every channel was committed by an earlier attempt — the job was retried
    // after its progress write but before the queue recorded completion. There
    // is nothing left to generate, and regenerating would write a second post
    // for a channel that has one.
    if (remaining.length === 0 && resume) {
      logger.info("topic generation already complete", { jobId: job.id, slug: input.slug });
      return mergeTopicProgress(
        input,
        {
          contentGroupId: input.contentGroupId,
          companyId: null,
          posts: [],
          failures: [],
          notAttempted: [],
          anchor: resume.anchor,
        },
        resume
      ) as unknown as TopicGenerationDiagnostics;
    }

    const budgetMs = deps.budgetMs ?? DEFAULT_TOPIC_BUDGET_MS;

    const outcome = await runInRequestDeadline(
      createRequestDeadline(now() + budgetMs, now),
      async () =>
        generateTopic(
          {
            slug: input.slug,
            userId: input.userId,
            isGlobalAdmin: requester.isGlobalAdmin,
            // From the payload's plan, so a retry continues the SAME group
            // rather than opening a second one beside the posts it already has.
            contentGroupId: input.contentGroupId,
            channels: remaining,
            contentLanguage: input.contentLanguage,
            includeSourceLinkOverride: input.includeSourceLink,
            autoGenerateImageOverride: input.generateImage,
            llmConfigId: input.llmConfigId,
            contentSource: parseManualContentSource(input.contentSource),
            // The topic an earlier attempt settled on. Null on a first attempt,
            // where the first channel to succeed settles it.
            anchor: resume?.anchor ?? null,
            alreadyGenerated: resume?.alreadyGenerated,
          },
          {
            // Every committed channel updates the job's `result`, which is both
            // what the UI polls and what the next attempt resumes from. This is
            // what makes cards appear one at a time instead of all at the end.
            onChannelComplete: async (partial) => {
              await reportProgress?.(
                mergeTopicProgress(input, partial, resume) as unknown as Record<string, unknown>
              );
            },
          }
        )
    );

    const progress = mergeTopicProgress(input, outcome, resume);

    logger.info("topic generation completed", {
      jobId: job.id,
      slug: input.slug,
      contentGroupId: input.contentGroupId,
      posts: `${progress.posts.length}/${input.channels.length}`,
      failures: progress.failures.length,
    });

    // Returned, not thrown, even when every channel failed. The failures are
    // structured in the result and the UI reads them from there; a thrown error
    // would replace them with one English string AND buy a retry of generations
    // that already know they cannot succeed.
    return progress as unknown as TopicGenerationDiagnostics;
  };
}

/** The production handler, wired to the real orchestrator. */
export function topicGenerationHandlerFor(config: WorkerConfig): JobHandler {
  // The worker's generation ceiling, shared with bulk: both bound one attempt of
  // an LLM-and-image run, and a second env var to keep in step would be two
  // names for one operational decision.
  return createTopicGenerationHandler({ budgetMs: config.bulkBudgetMs });
}
