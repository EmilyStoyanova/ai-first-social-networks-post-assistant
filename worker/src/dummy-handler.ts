/**
 * Dummy job processor — exercises the queue engine end to end with NO business
 * logic. It echoes its payload back as the job result.
 *
 * A payload of `{ "fail": true }` makes it throw, so retry/backoff and the
 * terminal-failure path can be demonstrated. Real orchestration handlers
 * (delegating to existing services) are registered in Phase 3; this stays only
 * as a smoke/diagnostic type.
 */

import type { JobHandler } from "./handler-registry";

export const DUMMY_JOB_TYPE = "dummy";

export const dummyHandler: JobHandler = async ({ job, logger }) => {
  logger.info("dummy job processing", { id: job.id, attempt: job.attempts });

  if (typeof job.payload === "object" && job.payload !== null && "fail" in job.payload) {
    if ((job.payload as { fail?: unknown }).fail) {
      throw new Error("dummy forced failure");
    }
  }

  return { echoed: job.payload, processedAt: new Date().toISOString() };
};
