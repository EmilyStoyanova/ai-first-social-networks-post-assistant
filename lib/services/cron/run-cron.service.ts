import { prisma } from "@/lib/db/client";
import { Prisma } from "@prisma/client";
import { ingestCompanySources } from "./ingest-company-sources.service";
import { translateFeedItems } from "./translate-feed-items.service";
import { generateWeeklySchedule } from "./generate-weekly-schedule.service";
import { autoApprovePosts } from "./auto-approve-posts.service";
import { enqueueJob } from "@/lib/services/queue/enqueue-job.service";
import { PUBLISH_SWEEP_JOB_TYPE, PUBLISH_SWEEP_DEDUPE_KEY } from "@/lib/queue/job-types";
import { retryFailedPosts } from "./retry-failed-posts.service";
import { backfillEmbeddings } from "./backfill-embeddings.service";
import { syncPostMetrics } from "@/lib/services/analytics/sync-post-metrics.service";

export interface CronRunSummary {
  runId: string;
  status: "completed" | "failed";
  company: { id: string; slug: string } | null;
  actions: Record<string, unknown>;
  error?: string;
}

/**
 * Cron dispatcher — designed to finish within Vercel's function timeout by
 * processing exactly ONE company per run, selected round-robin by the oldest
 * lastCronProcessedAt. Every execution is recorded in cron_runs.
 *
 * Steps (per implementation plan, Phase 8):
 *   1. record start   2. fetch feeds   2b. translate feed items (v2-4)
 *   3. generate weekly schedule   4. auto-approve   5. enqueue the publishing sweep
 *   6. retry failed   7. backfill embeddings   8. sync Buffer metrics (v2-7)
 *   9. record completion
 *
 * DEPRECATED, and step 5 is the one thing about it that changed: this run no longer
 * publishes inline. Handing posts to Buffer belongs to the publishing sweep alone
 * (PUBLISH_SWEEP_JOB_TYPE → runPublishCron), so that there is exactly ONE publisher
 * and a post cannot be delivered twice by two things sweeping at once. Step 5 now
 * enqueues that sweep under its shared dedupe key. Everything else here is unchanged.
 */
export async function runCron(): Promise<CronRunSummary> {
  const run = await prisma.cronRun.create({
    data: { startedAt: new Date(), status: "running" },
    select: { id: true },
  });

  const actions: Record<string, unknown> = {};

  try {
    // Round-robin: oldest processed first; never-processed companies first of all.
    const company = await prisma.company.findFirst({
      orderBy: [{ lastCronProcessedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
      select: { id: true, slug: true, automationMode: true },
    });

    if (!company) {
      actions.message = "No companies to process.";
      await completeRun(run.id, actions);
      return { runId: run.id, status: "completed", company: null, actions };
    }

    // Claim the slot immediately so a mid-run crash cannot wedge the rotation.
    await prisma.company.update({
      where: { id: company.id },
      data: { lastCronProcessedAt: new Date() },
    });

    actions.company = company.slug;

    // Step 2 — fetch feeds
    actions.ingest = await ingestCompanySources(company.id);

    // Step 2b — translate queued RSS items before they reach generation (v2-4).
    // Bounded per run; untranslated items are not blocked — generation falls back
    // to the original article text.
    actions.translate = await translateFeedItems({ companyId: company.id });

    // Step 3 — generate next week's schedule (budgeted; resumes across runs)
    actions.weeklySchedule = await generateWeeklySchedule(company.id);

    // Step 4 — auto-approve for fully automated channels
    actions.autoApprove = await autoApprovePosts(company.id, company.automationMode);

    // Step 5 — REQUEST publishing; do not perform it. This route no longer hands any
    // post to Buffer itself. `publishScheduledPosts` has no per-post claim — it reads
    // approved posts, sends them, and only then marks them sent — so a run here and
    // the publishing sweep both reading the same due post is a double delivery. The
    // sweep (PUBLISH_SWEEP_JOB_TYPE → runPublishCron) is the single publisher, and
    // this enqueues that same job under that same dedupe key: if a sweep is already
    // queued or in flight the enqueue is absorbed, which is the correct outcome, since
    // that sweep publishes everything this run would have.
    //
    // It is enqueued rather than dropped so the step still MEANS what it meant: invoke
    // this legacy route and due posts go out. Two differences from before, both
    // deliberate: delivery is now asynchronous (it needs the worker running), and it
    // covers every company rather than only this run's one — the sweep is global.
    //
    // Isolated, because a queue failure must not fail a run whose ingest, generation
    // and approval all succeeded; the next tick re-enqueues, and the job carries no
    // state between runs.
    try {
      actions.publish = await enqueueJob({
        type: PUBLISH_SWEEP_JOB_TYPE,
        dedupeKey: PUBLISH_SWEEP_DEDUPE_KEY,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Unknown error.";
      console.error(`[cron] Publish sweep could not be enqueued for ${company.slug}: ${reason}`);
      actions.publish = { failedWith: reason };
    }

    // Step 6 — retry failed posts with remaining budget
    actions.retry = await retryFailedPosts(company.id);

    // Step 7 — backfill semantic embeddings for this company's pending posts
    // (Phase 1.2). Best-effort; skips cleanly when no embedding provider is set.
    actions.backfillEmbeddings = await backfillEmbeddings({ companyId: company.id, limit: 25 });

    // Step 8 — sync Buffer engagement metrics (v2-7). LAST on purpose: it is the
    // only step whose omission costs nothing that cannot be recovered next run,
    // so it is the right thing to lose if the 60s budget runs out. Skips itself
    // cleanly when no Personal API Key is configured, which is the default.
    // Buffer refreshes metrics once daily, so the batch is small by design —
    // re-reading sooner returns identical data and spends the shared 250/day
    // request budget that publishing also draws on.
    // Isolated: a Buffer outage must not fail an otherwise good run. The sync
    // itself preserves each post's previous figures when a read fails.
    try {
      actions.syncMetrics = await syncPostMetrics({ companyId: company.id, limit: 15 });
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Unknown error.";
      console.error(`[cron] Metrics sync failed for ${company.slug}: ${reason}`);
      actions.syncMetrics = { failedWith: reason };
    }

    await completeRun(run.id, actions);
    return {
      runId: run.id,
      status: "completed",
      company: { id: company.id, slug: company.slug },
      actions,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown cron error.";
    console.error(`[cron] Run ${run.id} failed: ${message}`);
    await prisma.cronRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: message,
        actionsTaken: actions as Prisma.InputJsonValue,
      },
    });
    return { runId: run.id, status: "failed", company: null, actions, error: message };
  }
}

async function completeRun(runId: string, actions: Record<string, unknown>): Promise<void> {
  await prisma.cronRun.update({
    where: { id: runId },
    data: {
      status: "completed",
      completedAt: new Date(),
      actionsTaken: actions as Prisma.InputJsonValue,
    },
  });
}
