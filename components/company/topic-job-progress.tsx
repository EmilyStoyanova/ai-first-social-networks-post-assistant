"use client";

import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/Alert";
import { channelLabel } from "@/lib/posts/channel-selection";
import { summarizeTopicJob, type TopicJobPhase, type TopicJobStatus } from "@/lib/posts/topic-job";

interface Props {
  phase: TopicJobPhase;
  status: TopicJobStatus | null;
  /** Channels the form asked for — the denominator before progress exists. */
  requestedChannels: readonly string[];
}

/**
 * What a queued multi-channel generation is doing, while it does it.
 *
 * The panel exists because 202 is not "generated". Pressing Generate with two
 * channels selected used to block until the posts came back; now there is a
 * queue, a worker, and minutes of generation between the click and the cards,
 * and each of those states is worth naming:
 *
 *   • queued              — accepted, nobody has picked it up yet.
 *   • waiting-for-worker  — still nobody, long enough that it is worth saying so.
 *     Distinguished from `queued` because it usually means the worker process is
 *     not running, and an unexplained spinner would read as broken generation
 *     rather than as infrastructure that is down.
 *   • running             — a worker has it, and the count moves as channels commit.
 *   • failed / cancelled  — the JOB went wrong, as opposed to a channel.
 *
 * Completion is deliberately not rendered here. The posts themselves are the
 * result and they are already in the grid — added as each channel landed — so a
 * panel announcing success after the fact would be describing something the user
 * is looking at. Only the channels that produced NOTHING still need saying, and
 * the form reports those with the same warning the synchronous path uses.
 *
 * The sibling of `BulkJobProgress`, kept separate rather than generalised: they
 * count different things (channels of one topic vs. topics of a batch) and say
 * different things about a partial result, which is most of what a progress
 * panel is.
 */
export function TopicJobProgress({ phase, status, requestedChannels }: Props) {
  const t = useTranslations("posts.generate.topicJob");
  const counts = summarizeTopicJob(status?.progress ?? null, requestedChannels);

  if (phase === "failed" || phase === "cancelled") {
    return (
      <Alert variant="error" className="mb-4">
        <div className="space-y-1.5">
          <p className="font-medium">{phase === "cancelled" ? t("cancelled") : t("failed")}</p>
          {/* The worker's own message. English, and shown as-is: it names the
              thing that broke, and a translated paraphrase of "connect
              ECONNREFUSED" helps nobody debug it. */}
          {status?.lastError && <p className="text-xs break-words">{status.lastError}</p>}
          {/* Channels written before the failure are real drafts and are already
              in the grid. Saying so is the difference between "generate it all
              again" and "you are only missing one". */}
          {counts.written > 0 && (
            <p className="text-xs">{t("failedPartial", { written: counts.written })}</p>
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
          {waiting ? t("waitingForWorker") : phase === "queued" ? t("queued") : t("running")}
        </p>

        {waiting && <p className="text-xs">{t("waitingForWorkerHint")}</p>}

        {/* "1 of 3 channels written". Shown from the first render, at zero,
            rather than appearing once progress exists: a panel that grows a line
            mid-run reads as a glitch. */}
        <p className="text-xs">{t("progress", { done: counts.written, total: counts.total })}</p>

        {/* A channel that has already failed, while the rest are still going.
            Not held back to the end: it is something to act on now. */}
        {counts.failed > 0 && (
          <p className="text-xs">{t("progressFailures", { count: counts.failed })}</p>
        )}

        {/* A retry in progress. The first attempt's error is still on the job, so
            without this the user would see a fresh-looking queue state with an
            error attached and no explanation of the pairing. */}
        {status !== null && status.attempts > 1 && (
          <p className="text-xs">
            {t("attempt", { attempt: status.attempts, max: status.maxAttempts })}
          </p>
        )}

        {!waiting && (
          <p className="text-xs">
            {t("keepWorking", {
              channels: requestedChannels.map((c) => channelLabel(c)).join(", "),
            })}
          </p>
        )}
      </div>
    </Alert>
  );
}
