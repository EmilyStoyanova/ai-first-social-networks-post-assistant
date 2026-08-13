"use client";

import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/Alert";
import { summarizeBulkJob, type BulkJobPhase, type BulkJobStatus } from "@/lib/posts/bulk-job";

interface Props {
  phase: BulkJobPhase;
  status: BulkJobStatus | null;
  /** Topics the form asked for — the denominator before any progress exists. */
  requestedTopics: number;
}

/**
 * What a queued bulk run is doing, while it does it.
 *
 * The panel exists because 202 is not "generated". Between the click and the
 * posts there is now a queue, a worker, and minutes of generation, and every one
 * of those has a state worth naming:
 *
 *   • queued              — accepted, nobody has picked it up yet.
 *   • waiting-for-worker  — still nobody, long enough that it is worth saying so.
 *     This is the state that matters most right now: a permanent production
 *     worker is a release prerequisite that has not shipped, so "queued forever"
 *     is the expected experience until it does. An unexplained spinner would
 *     read as broken generation rather than as infrastructure that is not up.
 *   • running             — a worker has it, and the counts move as it commits.
 *   • failed / cancelled  — the run itself, not a topic, went wrong.
 *
 * Completion is deliberately NOT rendered here: a finished job's result is the
 * batch summary, and `BulkResultSummary` already knows how to read one. Two
 * panels saying the same thing in different words is exactly the drift this
 * feature does not need.
 */
export function BulkJobProgress({ phase, status, requestedTopics }: Props) {
  const t = useTranslations("posts.generate.bulk");
  const counts = summarizeBulkJob(status?.progress ?? null, requestedTopics);

  if (phase === "failed" || phase === "cancelled") {
    return (
      <Alert variant="error" className="mb-4">
        <div className="space-y-1.5">
          <p className="font-medium">
            {phase === "cancelled" ? t("jobCancelled") : t("jobFailed")}
          </p>
          {/* The worker's own message. English, and shown as-is: it names the
              thing that broke, and a translated paraphrase of "connect ECONNREFUSED"
              helps nobody debug it. */}
          {status?.lastError && <p className="text-xs break-words">{status.lastError}</p>}
          {/* Posts written before the failure are real drafts and are still
              there. Saying so is the difference between "retry the batch" and
              "check what you already have". */}
          {counts.generatedPosts > 0 && (
            <p className="text-xs">
              {t("jobFailedPartial", {
                posts: counts.generatedPosts,
                topics: counts.completedTopics,
              })}
            </p>
          )}
        </div>
      </Alert>
    );
  }

  const waiting = phase === "waiting-for-worker";

  return (
    <Alert variant={waiting ? "warning" : "info"} role="status" className="mb-4">
      <div className="space-y-1.5">
        <p className="font-medium">
          {waiting
            ? t("jobWaitingForWorker")
            : phase === "queued"
              ? t("jobQueued")
              : t("jobRunning")}
        </p>

        {waiting && <p className="text-xs">{t("jobWaitingForWorkerHint")}</p>}

        {/* "3 of 5 topics · 9 posts generated" — the two numbers that actually
            answer "how far along is this", kept together so they cannot be read
            as the same count. Shown from the first render, at zero, rather than
            appearing once progress exists: a panel that grows a line mid-run
            reads as a glitch. */}
        <p className="text-xs">
          {t("jobProgress", {
            done: counts.completedTopics,
            total: counts.totalTopics,
            posts: counts.generatedPosts,
          })}
        </p>

        {/* Partial groups, while the run is still going. Not hidden until the
            end: a channel that keeps failing is something to act on now. */}
        {counts.failedChannels > 0 && (
          <p className="text-xs">{t("jobProgressFailures", { count: counts.failedChannels })}</p>
        )}

        {/* A retry in progress. The first attempt's error is still on the job,
            so without this the user would see a fresh-looking queue state with
            an error message attached and no explanation of the pairing. */}
        {status !== null && status.attempts > 1 && (
          <p className="text-xs">
            {t("jobAttempt", { attempt: status.attempts, max: status.maxAttempts })}
          </p>
        )}

        {!waiting && <p className="text-xs">{t("jobKeepWorking")}</p>}
      </div>
    </Alert>
  );
}
