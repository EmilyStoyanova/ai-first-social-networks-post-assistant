/**
 * Queues one multi-channel topic generation.
 *
 * Sits between the generate route and the generic `enqueueJob`, and owns the
 * three things specific to THIS job type rather than to queueing in general:
 *
 *   1. the access check — the queue has no idea who may generate for a company;
 *   2. the group id, minted here so it is stable across every attempt the worker
 *      makes (see `topic-generation-payload.ts` for why the worker cannot);
 *   3. payload validation, run while there is still an HTTP response to refuse
 *      with rather than in a worker log.
 *
 * ── Why there is no dedupe key ──────────────────────────────────────────────
 *
 * Every other enqueuer in this app carries one. A bulk run holds a company-wide
 * lock because it draws N topics from one article pool while measuring
 * uniqueness against a history it is itself writing; the cron sweeps hold global
 * ones because a second concurrent sweep would redo the same work.
 *
 * One topic is neither. It makes a single claim, and that claim is already
 * atomic — the feed-item reservation hands one article to one generation, and
 * the (article, channel) unique index refuses a second post for it. Adding a
 * lock here would buy nothing and cost something real: two colleagues at one
 * company pressing Generate at the same time would start refusing each other,
 * which the synchronous route has never done. A queue is meant to remove a
 * limit here, not introduce one.
 *
 * The consequence — no ALREADY_RUNNING answer, so this cannot return a run to
 * adopt — is why the caller writes its job id down instead. See the form.
 */

import { enqueueJob } from "./enqueue-job.service";
import { resolveJobAccessFromDb } from "./job-status";
import { TOPIC_GENERATION_JOB_TYPE, TOPIC_GENERATION_MAX_ATTEMPTS } from "@/lib/queue/job-types";
import {
  topicGenerationPayloadSchema,
  type TopicGenerationPayload,
} from "@/lib/queue/topic-generation-payload";
import type { Prisma } from "@prisma/client";

/** The request, before the group id is minted onto it. */
export type TopicGenerationRequest = Omit<
  TopicGenerationPayload,
  "slug" | "userId" | "contentGroupId"
>;

export interface EnqueuedTopicGeneration {
  jobId: string;
  /** Shared by every channel version this run writes; known from the 202. */
  contentGroupId: string;
  /** Echoed so the client has its denominator before the first poll lands. */
  channels: string[];
}

export type EnqueueTopicGenerationResult =
  | { success: true; data: EnqueuedTopicGeneration }
  | { success: false; code: "NOT_FOUND" }
  | { success: false; code: "INVALID_PAYLOAD"; message: string };

export interface EnqueueTopicGenerationDeps {
  /** Resolves the company and whether this user may generate for it. */
  resolveAccess?: typeof resolveJobAccessFromDb;
  enqueue?: typeof enqueueJob;
  newContentGroupId?: () => string;
}

export async function enqueueTopicGeneration(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean,
  request: TopicGenerationRequest,
  deps: EnqueueTopicGenerationDeps = {}
): Promise<EnqueueTopicGenerationResult> {
  const resolveAccess = deps.resolveAccess ?? resolveJobAccessFromDb;
  const enqueue = deps.enqueue ?? enqueueJob;
  const newContentGroupId = deps.newContentGroupId ?? (() => crypto.randomUUID());

  // Checked before anything is minted or written: a caller who may not generate
  // for this company must not be able to put a job in its queue.
  const access = await resolveAccess(slug, userId, isGlobalAdmin);
  if (!access) return { success: false, code: "NOT_FOUND" };

  const contentGroupId = newContentGroupId();

  // Validated on the way in as well as on the way out. The payload crosses a
  // process boundary, so the moment to find out it is malformed is now — while
  // there is still an HTTP response to say so on.
  const payload = topicGenerationPayloadSchema.safeParse({
    ...request,
    slug,
    userId,
    contentGroupId,
  });
  if (!payload.success) {
    return {
      success: false,
      code: "INVALID_PAYLOAD",
      message: payload.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }

  const result = await enqueue({
    type: TOPIC_GENERATION_JOB_TYPE,
    payload: payload.data as unknown as Prisma.InputJsonValue,
    // Above a bulk run (10) and far above the recurring sweeps: this is a few
    // minutes of work with someone watching a spinner for it, and letting it sit
    // behind a forty-generation batch would be the wrong trade every time.
    priority: 20,
    maxAttempts: TOPIC_GENERATION_MAX_ATTEMPTS,
    // Written with the row, not patched on after: this is what the status
    // endpoint scopes its read by, so a job that existed for even a moment
    // without it would be a job momentarily readable by the wrong company.
    companyId: access.companyId,
    createdBy: userId,
  });

  // No dedupe key is sent, so the queue has nothing to collide on and this is
  // unreachable in practice. Treated as a failure rather than asserted away: an
  // enqueue that returns no id has not queued anything, and answering 202 with a
  // null job id would leave the client polling for a run that does not exist.
  if (!result.enqueued || result.jobId === null) {
    return {
      success: false,
      code: "INVALID_PAYLOAD",
      message: "The generation could not be queued.",
    };
  }

  return {
    success: true,
    data: { jobId: result.jobId, contentGroupId, channels: [...payload.data.channels] },
  };
}
