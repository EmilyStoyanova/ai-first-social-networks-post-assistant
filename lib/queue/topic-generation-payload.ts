/**
 * The wire contract for a queued multi-channel topic generation, and the shape
 * of what it records as it runs.
 *
 * Both ends of the queue import this module: the Next route that enqueues, and
 * the worker that executes. That is why it lives in `lib/queue/` beside
 * `bulk-generation-payload.ts` — a payload written by one process and read by
 * another, possibly across a deploy that only touched one of them, is a real
 * integration boundary and gets a real schema rather than a cast.
 *
 * ── Why the group id is part of the payload ─────────────────────────────────
 *
 * `contentGroupId` is what makes several posts ONE topic rather than three
 * unrelated drafts, and it is minted at enqueue for exactly the reason bulk
 * mints its groups there: the worker cannot mint it, because attempt 2 would
 * mint a different one and the channels it then adds would form a second group
 * beside the half-written first. It also lets the 202 name the group before a
 * worker has so much as looked at the job.
 *
 * The ANCHOR — the article and core message the topic settled on — is not here.
 * It cannot be: it does not exist until the first channel has been written. It
 * is recorded into progress instead, which is what a retry resumes from.
 *
 * ── What the payload deliberately does NOT carry ────────────────────────────
 *
 * `isGlobalAdmin`, for the same reason bulk omits it: it is a property of the
 * user AT EXECUTION TIME, and a job can sit in the queue across the moment
 * someone's admin rights are revoked. The handler re-reads it.
 */

import { z } from "zod";
import { BULK_CHANNELS } from "./bulk-generation-payload";

const channelSchema = z
  .string()
  .transform((v) => v.toLowerCase())
  .pipe(z.enum(BULK_CHANNELS));

/**
 * Everything a worker needs to write one topic, and nothing it can decide for
 * itself.
 *
 * Every option below is the SAME field the synchronous route accepts, spelled
 * the same way, so the queued path and the inline path are one request shape —
 * a channel generated through the queue is indistinguishable from one generated
 * inline apart from when it is answered for.
 *
 * `.strict()` so a payload written by a newer deploy and read by an older worker
 * fails loudly at the schema instead of running with a field silently dropped —
 * which, for a job that writes posts, is the difference between a clear error
 * and a post generated against instructions nobody gave.
 */
export const topicGenerationPayloadSchema = z
  .object({
    /** Company the posts are written for. Membership is re-checked per generation. */
    slug: z.string().min(1),
    /** Who asked. Re-resolved (not trusted) for admin rights at execution time. */
    userId: z.string().min(1),
    /**
     * The group every channel version of this topic shares. Minted at enqueue so
     * it is stable across retries — see the module docblock.
     */
    contentGroupId: z.string().min(1),
    /**
     * Every channel to write, in attempt order. At least two: one channel is
     * answered inline and never reaches the queue.
     */
    channels: z.array(channelSchema).min(2).max(BULK_CHANNELS.length),

    // ── Identical to the synchronous generate route ─────────────────────────
    contentLanguage: z.enum(["en", "bg"]).optional(),
    includeSourceLink: z.boolean().optional(),
    generateImage: z.boolean().optional(),
    llmConfigId: z.string().min(1).optional(),
    /** The raw dropdown value; `parseManualContentSource` reads it worker-side. */
    contentSource: z.string().min(1).optional(),
    /**
     * When every channel version of this topic should go out, as an ISO-8601
     * instant. Omitted = unscheduled drafts, which is what a queued topic run
     * has always produced.
     *
     * An instant rather than a wall clock, for the same reason the route takes
     * one: the zone conversion happens once, in the form, and neither the queue
     * nor the worker has to know which zone the user was reading.
     *
     * The freshness check stays at the ROUTE, deliberately. It is a question
     * about the moment the request was made — "is this time still ahead?" — and
     * a worker picking the job up later would ask it against a different clock
     * and could refuse a schedule the user was told had been accepted.
     */
    scheduledFor: z.iso.datetime({ offset: true }).optional(),
  })
  .strict()
  .refine((p) => new Set(p.channels).size === p.channels.length, {
    message: "channels must not repeat",
    path: ["channels"],
  });

export type TopicGenerationPayload = z.infer<typeof topicGenerationPayloadSchema>;

// ─── Progress ─────────────────────────────────────────────────────────────────

/**
 * Deliberately LENIENT where the payload is strict, and for the opposite reason.
 * A payload is an instruction and must be exactly understood; progress is a
 * report, and a worker that recorded a field this reader does not know about has
 * still told it everything it needs. `.passthrough()` means an older reader
 * degrades to less detail rather than to a crash that would strand real posts.
 */
const looseRecord = z.object({}).passthrough();

/**
 * One channel that produced nothing, with the generator's own diagnostics.
 *
 * `code` is what the UI translates; `reason` and `attempts` are what a
 * uniqueness abort explains itself with. Carried verbatim so a channel that
 * failed inside a queued group explains itself exactly as fully as one that
 * failed inline.
 */
const topicFailureSchema = z
  .object({
    channel: z.string(),
    code: z.string(),
    message: z.string().optional(),
    reason: z.string().optional(),
    attempts: z.number().optional(),
    retryAfterMs: z.number().optional(),
  })
  .passthrough();

/**
 * What a running (or finished) topic job has recorded, as stored in `jobs.result`.
 *
 * This is `TopicGenerationOutcome` after a JSON round trip. One shape for
 * "running" and "finished" — the UI polling mid-flight and the UI reading a
 * completed job parse the same object, so there is no second progress format to
 * keep in step.
 *
 * It carries the WHOLE post, not just its id, and that is the point: the
 * synchronous route answers with finished post objects, and the form renders
 * cards from them. Carrying the same objects through the queue means a channel
 * appears in the grid the moment it commits, with no follow-up fetch and no
 * second rendering path. (Bulk deliberately does the opposite — it records ids,
 * because forty whole posts in a progress row would bloat every write for a
 * reader that only ever wanted a count.)
 */
export const topicGenerationProgressSchema = z
  .object({
    contentGroupId: z.string(),
    companyId: z.string().nullable().optional(),
    /**
     * Channels asked for, echoed so the UI has its denominator from the first
     * poll — before any channel has committed and before `posts` says anything.
     */
    channels: z.array(z.string()).optional(),
    posts: z
      .array(
        z
          .object({
            channel: z.string(),
            postId: z.string(),
            scheduledFor: z.string().nullable().optional(),
            /** The generated post itself — what the grid renders. */
            post: looseRecord.optional(),
            warnings: looseRecord.optional(),
          })
          .passthrough()
      )
      .default([]),
    failures: z.array(topicFailureSchema).default([]),
    /**
     * Channels never attempted. Always empty on a job that ran to completion —
     * a worker has no function cap to run out of, which is the whole reason this
     * work moved here — but kept in the shape because the orchestrator can still
     * report it under a worker-side ceiling.
     */
    notAttempted: z.array(z.string()).default([]),
    /**
     * The topic this group settled on. The load-bearing field for a retry:
     * without it the channels still missing would each decide a topic of their
     * own and the group would fragment into unrelated posts.
     */
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
  .passthrough();

export type TopicGenerationProgress = z.infer<typeof topicGenerationProgressSchema>;

/**
 * Reads whatever a previous attempt left in `jobs.result`, or null.
 *
 * Never throws. Progress that cannot be parsed is treated as "no progress",
 * which costs the topic a regeneration but cannot wedge the job — and a job that
 * refuses to start because it cannot read its own diary is strictly worse than
 * one that starts over.
 */
export function parseTopicGenerationProgress(value: unknown): TopicGenerationProgress | null {
  if (value == null) return null;
  const parsed = topicGenerationProgressSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
