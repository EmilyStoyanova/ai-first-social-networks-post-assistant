/**
 * The wire contract for a queued manual bulk generation, and the shape of what
 * it records as it runs.
 *
 * Both ends of the queue import this module: the Next route that enqueues, and
 * the worker that executes. That is the whole point of it living in `lib/queue/`
 * beside `job-types.ts` — a payload written by one process and read by another,
 * possibly after a deploy that only touched one of them, is a real integration
 * boundary and gets a real schema rather than a cast.
 *
 * ── Why the plan is part of the payload ─────────────────────────────────────
 *
 * A bulk run writes posts and spends LLM credits, and it can be interrupted:
 * a lost lease, a restarted process, a retry. Resuming safely needs two ids to
 * be decided ONCE, before any work starts, and to survive every attempt:
 *
 *   • `batchId`         — the `generationBatchId` stamped on every post. Minted
 *                         at enqueue so the API can hand it back with the 202,
 *                         before a worker has so much as looked at the job.
 *   • `contentGroupIds` — one per TOPIC, in order. A retry that finishes a
 *                         half-written group must reuse that group's id, or the
 *                         channels it adds become a second group beside the
 *                         first and the topic is split in the UI forever.
 *
 * Neither can be minted by the worker: attempt 2 would mint different ones.
 *
 * ── What the payload deliberately does NOT carry ────────────────────────────
 *
 * `isGlobalAdmin`. It is a property of the user AT EXECUTION TIME, and a job can
 * sit in the queue across the moment someone's admin rights are revoked. The
 * handler re-reads it, so the run is authorized against what is true when the
 * posts are actually written — never against a snapshot of a session.
 */

import { z } from "zod";
import { MAX_BULK_POSTS } from "@/lib/scheduling/bulk-schedule";

/** The channels a bulk request may name. Mirrors the `SocialChannel` enum. */
export const BULK_CHANNELS = ["facebook", "linkedin", "instagram", "tiktok"] as const;

const channelSchema = z
  .string()
  .transform((v) => v.toLowerCase())
  .pipe(z.enum(BULK_CHANNELS));

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * The user's own schedule, exactly as the synchronous route accepted it. Shape
 * only — that the times add up, do not collide and are not in the past is the
 * service's answer, and the service stays the authority on both sides.
 */
export const bulkDistributionSchema = z.array(
  z.object({
    date: isoDateSchema,
    count: z.number().int().min(1).max(MAX_BULK_POSTS),
    times: z
      .array(z.string().regex(/^\d{2}:\d{2}$/))
      .min(1)
      .max(MAX_BULK_POSTS),
  })
);

export const bulkSourceMixSchema = z.array(
  z.object({
    sourceId: z.string().min(1).nullable(),
    posts: z.number().int().min(1).max(MAX_BULK_POSTS),
  })
);

/**
 * Everything a worker needs to run one bulk request, and nothing it can decide
 * for itself.
 *
 * `.strict()` so a payload written by a newer deploy and read by an older worker
 * fails loudly at the schema instead of running with a field silently dropped —
 * which, for a job that writes posts, is the difference between a clear error and
 * a batch generated against instructions nobody asked for.
 */
export const bulkGenerationPayloadSchema = z
  .object({
    /** Company the posts are written for. Membership is re-checked per generation. */
    slug: z.string().min(1),
    /** Who asked. Re-resolved (not trusted) for admin rights at execution time. */
    userId: z.string().min(1),

    // ── The plan, decided once at enqueue ───────────────────────────────────
    /** Stamped on every post as `generationBatchId`; stable across retries. */
    batchId: z.string().min(1),
    /**
     * One content-group id per topic, in topic order. Exactly `numberOfPosts`
     * of them — checked below, because a short list would silently make the last
     * topics un-resumable.
     */
    contentGroupIds: z.array(z.string().min(1)).min(1).max(MAX_BULK_POSTS),

    // ── The request ─────────────────────────────────────────────────────────
    /** Every channel each topic is written for. Deduped and non-empty. */
    channels: z.array(channelSchema).min(1).max(BULK_CHANNELS.length),
    /** TOPICS, not post rows: `numberOfPosts × channels.length` posts. */
    numberOfPosts: z.number().int().min(1).max(MAX_BULK_POSTS),
    startDate: isoDateSchema,
    endDate: isoDateSchema,
    distribution: bulkDistributionSchema.min(1).max(MAX_BULK_POSTS).optional(),
    sourceMix: bulkSourceMixSchema.min(1).max(MAX_BULK_POSTS).optional(),

    // ── Identical to the single-post options ────────────────────────────────
    contentLanguage: z.enum(["en", "bg"]).optional(),
    includeSourceLink: z.boolean().optional(),
    generateImage: z.boolean().optional(),
    llmConfigId: z.string().min(1).optional(),
    /** The raw dropdown value; `parseManualContentSource` reads it worker-side. */
    contentSource: z.string().min(1).optional(),
  })
  .strict()
  .refine((p) => p.contentGroupIds.length === p.numberOfPosts, {
    message: "contentGroupIds must have exactly one id per requested topic",
    path: ["contentGroupIds"],
  })
  .refine((p) => new Set(p.channels).size === p.channels.length, {
    message: "channels must not repeat",
    path: ["channels"],
  });

export type BulkGenerationPayload = z.infer<typeof bulkGenerationPayloadSchema>;

// ─── Progress ─────────────────────────────────────────────────────────────────

/**
 * What a running (or finished) bulk job has recorded, as stored in `jobs.result`.
 *
 * This is `BulkGenerationSummary` after a JSON round trip — the same object the
 * service builds, with `Date` become ISO string. One shape for "running" and
 * "finished" is deliberate on the service side, and it stays one shape here: the
 * UI polling mid-flight and the UI reading a completed job parse the same thing.
 *
 * Deliberately LENIENT where the payload is strict, and for the opposite reason.
 * A payload is an instruction and must be exactly understood; progress is a
 * report, and a worker that recorded a field this reader does not know about has
 * still told it everything it needs to resume. `.passthrough()` and the optional
 * tails mean an older reader degrades to less detail rather than to a crash that
 * would strand a batch of real posts.
 */
/**
 * One channel that produced nothing.
 *
 * Read by the UI to say WHICH channel of a topic is missing and why, so a
 * partial group reads as "Instagram could not be written, because …" rather
 * than as a group that quietly has two versions instead of three. `index` and
 * `scheduledFor` come along because the same shape appears at the top level,
 * where a failure belongs to a slot rather than to a group.
 */
const bulkFailureSchema = z
  .object({
    index: z.number().int().positive().optional(),
    scheduledFor: z.string().optional(),
    channel: z.string().optional(),
    code: z.string(),
    reason: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

export const bulkGenerationProgressSchema = z
  .object({
    batchId: z.string(),
    requested: z.number(),
    generated: z.number(),
    channels: z.array(z.string()).optional(),
    requestedPosts: z.number().optional(),
    generatedPosts: z.number().optional(),
    groups: z
      .array(
        z
          .object({
            index: z.number().int().positive(),
            contentGroupId: z.string(),
            posts: z
              .array(
                z
                  .object({
                    index: z.number().int().positive(),
                    postId: z.string(),
                    channel: z.string(),
                    contentGroupId: z.string(),
                    scheduledFor: z.string(),
                  })
                  .passthrough()
              )
              .default([]),
            failures: z.array(bulkFailureSchema).default([]),
          })
          .passthrough()
      )
      .optional(),

    // ── The tail of a FINISHED summary ──────────────────────────────────────
    // A completed job's `result` is the whole `BulkGenerationSummary`, and this
    // is the only place it is read back. Declaring these means the UI renders a
    // finished run from the same typed object it polls with, rather than from a
    // second parse or a cast. All optional, so a mid-flight snapshot — which has
    // none of them yet — still parses.
    failed: z.number().optional(),
    postIds: z.array(z.string()).optional(),
    posts: z
      .array(
        z
          .object({
            index: z.number().int().positive(),
            postId: z.string(),
            channel: z.string().optional(),
            contentGroupId: z.string().optional(),
            scheduledFor: z.string(),
          })
          .passthrough()
      )
      .optional(),
    failures: z.array(bulkFailureSchema).optional(),
    notAttempted: z.number().optional(),
    stoppedEarly: z.boolean().optional(),
    stopReason: z.string().nullable().optional(),
    exhaustedSources: z.array(z.string().nullable()).optional(),
    /** The topic that was mid-flight when this snapshot was written. */
    liveTopic: z
      .object({
        index: z.number().int().positive(),
        contentGroupId: z.string(),
        completedChannels: z.array(z.string()).default([]),
        anchor: z
          .object({
            primaryFeedItemId: z.string().nullable(),
            coreMessage: z.string(),
            topic: z.string().nullable(),
            establishedBy: z.string(),
          })
          .nullable()
          .optional(),
      })
      .optional(),
  })
  .passthrough();

export type BulkGenerationProgress = z.infer<typeof bulkGenerationProgressSchema>;

/**
 * Reads whatever a previous attempt left in `jobs.result`, or null.
 *
 * Never throws. A progress record that cannot be parsed is treated as "no
 * progress", which costs the batch a regeneration but cannot wedge the job — and
 * a job that refuses to start because it cannot read its own diary is strictly
 * worse than one that starts over.
 */
export function parseBulkGenerationProgress(value: unknown): BulkGenerationProgress | null {
  if (value == null) return null;
  const parsed = bulkGenerationProgressSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
