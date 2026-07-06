import { prisma } from "@/lib/db/client";
import { Prisma } from "@prisma/client";
import { ingestCompanySources } from "./ingest-company-sources.service";
import { generateWeeklySchedule } from "./generate-weekly-schedule.service";
import { autoApprovePosts } from "./auto-approve-posts.service";

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
 *   1. record start   2. fetch feeds   3. generate weekly schedule
 *   4. auto-approve   5. send to Buffer   6. retry failed   7. record completion
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

    // Step 3 — generate next week's schedule (budgeted; resumes across runs)
    actions.weeklySchedule = await generateWeeklySchedule(company.id);

    // Step 4 — auto-approve for fully automated channels
    actions.autoApprove = await autoApprovePosts(company.id, company.automationMode);

    // Steps 5–6 are appended by the next milestone:
    // send to Buffer, retry failed.

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
