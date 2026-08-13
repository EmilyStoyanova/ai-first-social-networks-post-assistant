/**
 * Reads the state of one queued topic generation, for the person who asked.
 *
 * The access rules — scoped by company AND type, never returning `payload` —
 * live in `job-status.ts` and are shared with the bulk status read. Being scoped
 * by type matters here in a way it does not for a single endpoint: a bulk job id
 * handed to this route answers NOT_FOUND rather than returning a bulk summary
 * through a reader that would parse almost none of it.
 *
 * The `progress` it carries holds the WHOLE post for every channel that has
 * committed, so the form adds cards as they arrive rather than waiting for the
 * run to finish — see `topic-generation-payload.ts` for why this type records
 * posts where bulk records ids.
 */

import { readJobStatus, type JobStatusDeps, type JobStatusView } from "./job-status";
import {
  parseTopicGenerationProgress,
  type TopicGenerationProgress,
} from "@/lib/queue/topic-generation-payload";
import { TOPIC_GENERATION_JOB_TYPE } from "@/lib/queue/job-types";

export type TopicGenerationStatus = JobStatusView<TopicGenerationProgress>;

export type GetTopicGenerationStatusResult =
  { success: true; data: TopicGenerationStatus } | { success: false; code: "NOT_FOUND" };

export type GetTopicGenerationStatusDeps = JobStatusDeps;

export async function getTopicGenerationStatus(
  slug: string,
  jobId: string,
  userId: string,
  isGlobalAdmin: boolean,
  deps: GetTopicGenerationStatusDeps = {}
): Promise<GetTopicGenerationStatusResult> {
  return readJobStatus({
    slug,
    jobId,
    userId,
    isGlobalAdmin,
    type: TOPIC_GENERATION_JOB_TYPE,
    parseProgress: parseTopicGenerationProgress,
    deps,
  });
}
