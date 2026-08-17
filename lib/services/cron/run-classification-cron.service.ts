import { performance } from "node:perf_hooks";
import { prisma } from "@/lib/db/client";
import { Prisma } from "@prisma/client";
import {
  classifyFeedItems,
  classificationEligibleWhere,
  type ClassifyFeedItemsSummary,
} from "./classify-feed-items.service";

/**
 * Classification cron — drains the article-classification queue across ALL
 * companies in a bounded, oldest-first batch by reusing `classifyFeedItems`
 * verbatim. No classification logic is duplicated here. Never ingests, never
 * translates, never generates posts.
 *
 * A deliberate copy of `run-translation-cron.service.ts` in structure, because it
 * has the same shape of problem: a per-item LLM call, a backlog that must drain
 * across runs, and a platform function cap to respect. The wall-clock deadline is
 * enforced at TWO granularities — between companies, and between items within a
 * company (via `shouldStop`/`remainingMs` into `classifyFeedItems`).
 *
 * Continuation is via item status: an item is marked classified only when it
 * actually is, so anything left pending/failed (deadline, batch cap, transient
 * failure) is simply re-selected next run with its retry budget intact. Every
 * company is failure-isolated.
 */

/** Max distinct companies whose classification queue is drained per run. */
const MAX_CLASSIFICATION_COMPANIES_PER_RUN = 10;

/**
 * Wall-clock deadline for a run. 240s leaves ~60s of headroom under the worker's
 * budget for a model call that was already running when the deadline was crossed.
 */
export const CLASSIFICATION_SOFT_TIME_BUDGET_MS = 240_000;

export interface ClassificationTimings {
  companySelectionMs: number;
  classificationMs: number;
  databaseWritesMs: number;
  cleanupMs: number;
  totalMs: number;
}

export interface ClassificationCronSummary {
  runId: string;
  status: "completed" | "failed";
  kind: "classification";
  companiesExamined: number;
  companiesProcessed: number;
  classified: number;
  failed: number;
  skipped: number;
  /** Items still awaiting classification after this run — the continuation signal. */
  remaining: number;
  durationMs: number;
  timings: ClassificationTimings;
  failures: Array<{ companyId: string; message: string }>;
  timedOut: boolean;
  error?: string;
}

export interface ClassificationCronDeps {
  now?: () => Date;
  timeBudgetMs?: number;
  maxCompanies?: number;
  createRun?: () => Promise<{ id: string }>;
  finishRun?: (id: string, actions: Record<string, unknown>) => Promise<void>;
  failRun?: (id: string, actions: Record<string, unknown>, error: string) => Promise<void>;
  selectCompanies?: (limit: number) => Promise<string[]>;
  classify?: (opts: {
    companyId: string;
    shouldStop?: () => boolean;
    remainingMs?: () => number;
  }) => Promise<ClassifyFeedItemsSummary>;
  countRemaining?: () => Promise<number>;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error.";
}

async function defaultCreateRun(): Promise<{ id: string }> {
  return prisma.cronRun.create({
    data: { startedAt: new Date(), status: "running" },
    select: { id: true },
  });
}

async function defaultFinishRun(id: string, actions: Record<string, unknown>): Promise<void> {
  await prisma.cronRun.update({
    where: { id },
    data: {
      status: "completed",
      completedAt: new Date(),
      actionsTaken: actions as Prisma.InputJsonValue,
    },
  });
}

async function defaultFailRun(
  id: string,
  actions: Record<string, unknown>,
  error: string
): Promise<void> {
  await prisma.cronRun.update({
    where: { id },
    data: {
      status: "failed",
      completedAt: new Date(),
      error,
      actionsTaken: actions as Prisma.InputJsonValue,
    },
  });
}

/**
 * The exact eligibility the per-company batch uses, unscoped — so "which
 * companies have work" and "which items are work" can never disagree and leave a
 * company selected forever with nothing to do.
 */
function pendingWhere(): Prisma.FeedItemWhereInput {
  return classificationEligibleWhere(new Date()) as Prisma.FeedItemWhereInput;
}

async function defaultSelectCompanies(limit: number): Promise<string[]> {
  const rows = await prisma.feedItem.findMany({
    where: pendingWhere(),
    orderBy: { createdAt: "asc" },
    select: { companyId: true },
    distinct: ["companyId"],
    take: limit,
  });
  return rows.map((r) => r.companyId);
}

async function defaultCountRemaining(): Promise<number> {
  return prisma.feedItem.count({ where: pendingWhere() });
}

function toActions(summary: ClassificationCronSummary): Record<string, unknown> {
  return {
    kind: summary.kind,
    companiesExamined: summary.companiesExamined,
    companiesProcessed: summary.companiesProcessed,
    classified: summary.classified,
    failed: summary.failed,
    skipped: summary.skipped,
    remaining: summary.remaining,
    durationMs: summary.durationMs,
    timings: summary.timings,
    failures: summary.failures,
    timedOut: summary.timedOut,
  };
}

export async function runClassificationCron(
  deps: ClassificationCronDeps = {}
): Promise<ClassificationCronSummary> {
  const now = deps.now ?? (() => new Date());
  const timeBudgetMs = deps.timeBudgetMs ?? CLASSIFICATION_SOFT_TIME_BUDGET_MS;
  const maxCompanies = deps.maxCompanies ?? MAX_CLASSIFICATION_COMPANIES_PER_RUN;
  const createRun = deps.createRun ?? defaultCreateRun;
  const finishRun = deps.finishRun ?? defaultFinishRun;
  const failRun = deps.failRun ?? defaultFailRun;
  const selectCompanies = deps.selectCompanies ?? defaultSelectCompanies;
  const classify = deps.classify ?? classifyFeedItems;
  const countRemaining = deps.countRemaining ?? defaultCountRemaining;

  const startMs = now().getTime();
  const deadlineMs = startMs + timeBudgetMs;
  const overBudget = () => now().getTime() >= deadlineMs;
  const shouldStop = () => now().getTime() >= deadlineMs;
  const remainingMs = () => deadlineMs - now().getTime();

  const runStart = performance.now();
  const timings: ClassificationTimings = {
    companySelectionMs: 0,
    classificationMs: 0,
    databaseWritesMs: 0,
    cleanupMs: 0,
    totalMs: 0,
  };
  async function timed<T>(bucket: keyof ClassificationTimings, fn: () => Promise<T>): Promise<T> {
    const t = performance.now();
    try {
      return await fn();
    } finally {
      timings[bucket] += Math.round(performance.now() - t);
    }
  }

  const run = await timed("databaseWritesMs", () => createRun());
  const summary: ClassificationCronSummary = {
    runId: run.id,
    status: "completed",
    kind: "classification",
    companiesExamined: 0,
    companiesProcessed: 0,
    classified: 0,
    failed: 0,
    skipped: 0,
    remaining: 0,
    durationMs: 0,
    timings,
    failures: [],
    timedOut: false,
  };

  try {
    const companies = await timed("companySelectionMs", () => selectCompanies(maxCompanies));

    for (const companyId of companies) {
      if (overBudget()) {
        summary.timedOut = true;
        break;
      }

      summary.companiesExamined++;
      try {
        const c = await timed("classificationMs", () =>
          classify({ companyId, shouldStop, remainingMs })
        );
        summary.companiesProcessed++;
        summary.classified += c.classified;
        summary.failed += c.failed;
        summary.skipped += c.skipped;
      } catch (err) {
        summary.failures.push({ companyId, message: message(err) });
      }
    }

    summary.remaining = await timed("cleanupMs", () => countRemaining());
    timings.totalMs = Math.round(performance.now() - runStart);
    summary.durationMs = timings.totalMs;
    await finishRun(run.id, toActions(summary));
    return summary;
  } catch (err) {
    const msg = message(err);
    summary.status = "failed";
    summary.error = msg;
    timings.totalMs = Math.round(performance.now() - runStart);
    summary.durationMs = timings.totalMs;
    await failRun(run.id, toActions(summary), msg);
    return summary;
  }
}
