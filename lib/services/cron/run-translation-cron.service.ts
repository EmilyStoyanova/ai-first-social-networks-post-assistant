import { performance } from "node:perf_hooks";
import { prisma } from "@/lib/db/client";
import { Prisma } from "@prisma/client";
import { translateFeedItems, type TranslateFeedItemsSummary } from "./translate-feed-items.service";
import { MAX_TRANSLATION_ATTEMPTS } from "@/lib/ai/feed-item-translation";

// ─── Tunables ──────────────────────────────────────────────────────────────────

/** Max distinct companies whose translation queue is drained per run — the batch cap. */
const MAX_TRANSLATION_COMPANIES_PER_RUN = 10;
/**
 * Wall-clock deadline for a run. 240s leaves ~60s of headroom under the route's 300s cap
 * (Vercel Hobby + Fluid Compute) for the translation LLM call that was already running when
 * the deadline was crossed. Enforced at TWO granularities: between companies, and between
 * items within a company (`shouldStop` into translateFeedItems).
 */
export const SOFT_TIME_BUDGET_MS = 240_000;

// ─── Types ─────────────────────────────────────────────────────────────────────

/**
 * Wall-clock time (ms) per major phase — measured on a real clock, independent of the
 * injectable `now()` that drives the deadline, so timings stay accurate in production and
 * never perturb deterministic budget tests. Sum of the phases ≈ totalMs.
 */
export interface TranslationTimings {
  /** selectCompanies — picking the batch of companies with pending translations. */
  companySelectionMs: number;
  /** All translateFeedItems calls — the LLM translation work. */
  translationMs: number;
  /** Cron-level DB writes: createRun. */
  databaseWritesMs: number;
  /** Wrap-up: the remaining-backlog count. (finishRun, the record write, is excluded.) */
  cleanupMs: number;
  /** Total measured wall-clock of the run. */
  totalMs: number;
}

export interface TranslationCronSummary {
  runId: string;
  status: "completed" | "failed";
  kind: "translation";
  /** Companies this run attempted to drain: examined = companiesProcessed + failed. */
  companiesExamined: number;
  /** Companies drained without throwing. */
  companiesProcessed: number;
  /** Feed items translated across all companies this run. */
  translated: number;
  /** Feed items whose translation failed (recorded, retryable) across all companies. */
  failed: number;
  /** Feed items skipped (source translation disabled) across all companies. */
  skipped: number;
  /** Feed items still awaiting translation after this run — the continuation backlog. */
  remaining: number;
  /** Wall-clock duration of the run (equals timings.totalMs). */
  durationMs: number;
  /** Per-phase wall-clock breakdown — the bottleneck at a glance. */
  timings: TranslationTimings;
  /** Per-company failures (isolated — the batch continued). */
  failures: Array<{ companyId: string; message: string }>;
  /** True when the soft time budget cut the run short — the rest resumes next run. */
  timedOut: boolean;
  error?: string;
}

export interface TranslationCronDeps {
  now?: () => Date;
  timeBudgetMs?: number;
  maxCompanies?: number;
  createRun?: () => Promise<{ id: string }>;
  finishRun?: (id: string, actions: Record<string, unknown>) => Promise<void>;
  failRun?: (id: string, actions: Record<string, unknown>, error: string) => Promise<void>;
  /** Distinct companies with retry-due pending/failed translatable items, oldest first. */
  selectCompanies?: (limit: number) => Promise<string[]>;
  translate?: (opts: {
    companyId: string;
    shouldStop?: () => boolean;
  }) => Promise<TranslateFeedItemsSummary>;
  /** How many feed items still await translation (drives the `remaining` diagnostic). */
  countRemaining?: () => Promise<number>;
}

// ─── Production defaults (real Prisma) ──────────────────────────────────────────

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

/** Only items still eligible: enabled source, pending/failed, under the attempt cap, retry-due. */
function pendingWhere(): Prisma.FeedItemWhereInput {
  return {
    source: { enabled: true },
    translationStatus: { in: ["pending", "failed"] },
    translationAttemptCount: { lt: MAX_TRANSLATION_ATTEMPTS },
    // Never before its backoff window elapses; null = never attempted.
    OR: [{ translationNextRetryAt: null }, { translationNextRetryAt: { lte: new Date() } }],
  };
}

async function defaultSelectCompanies(limit: number): Promise<string[]> {
  // Deterministic, oldest-first (by the earliest queued item) so unfinished companies are
  // revisited in round-robin and continuation is stable across runs.
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

// ─── Orchestrator ──────────────────────────────────────────────────────────────

function toActions(summary: TranslationCronSummary): Record<string, unknown> {
  return {
    kind: summary.kind,
    companiesExamined: summary.companiesExamined,
    companiesProcessed: summary.companiesProcessed,
    translated: summary.translated,
    failed: summary.failed,
    skipped: summary.skipped,
    remaining: summary.remaining,
    durationMs: summary.durationMs,
    timings: summary.timings,
    failures: summary.failures,
    timedOut: summary.timedOut,
  };
}

/**
 * Translation cron (v2-9, Hobby-safe). Drains the RSS translation queue across ALL
 * companies in a bounded, oldest-first batch by reusing `translateFeedItems` verbatim —
 * no translation logic is duplicated here. Never ingests and never generates posts.
 *
 * Hobby-safety comes from a wall-clock deadline enforced at TWO granularities:
 *   • between companies — stop draining new companies once the budget is spent;
 *   • within a company — `shouldStop` is passed into translateFeedItems so a large backlog
 *     stops between items instead of running every LLM call to the timeout.
 *
 * Continuation is via item status: an item is marked translated only when it actually is,
 * so anything left pending/failed (deadline, batch cap, or transient failure) is simply
 * re-selected on the next run — its retry/backoff and translated/original fallback are all
 * unchanged. Every company is failure-isolated.
 */
export async function runTranslationCron(
  deps: TranslationCronDeps = {}
): Promise<TranslationCronSummary> {
  const now = deps.now ?? (() => new Date());
  const timeBudgetMs = deps.timeBudgetMs ?? SOFT_TIME_BUDGET_MS;
  const maxCompanies = deps.maxCompanies ?? MAX_TRANSLATION_COMPANIES_PER_RUN;
  const createRun = deps.createRun ?? defaultCreateRun;
  const finishRun = deps.finishRun ?? defaultFinishRun;
  const failRun = deps.failRun ?? defaultFailRun;
  const selectCompanies = deps.selectCompanies ?? defaultSelectCompanies;
  const translate = deps.translate ?? translateFeedItems;
  const countRemaining = deps.countRemaining ?? defaultCountRemaining;

  const startMs = now().getTime();
  const deadlineMs = startMs + timeBudgetMs;
  const overBudget = () => now().getTime() >= deadlineMs;
  // Passed into each company's item loop so it, too, stops at the deadline.
  const shouldStop = () => now().getTime() >= deadlineMs;

  // Real-clock timing, deliberately separate from the injectable `now()` used for the
  // deadline — accurate in production, and it never perturbs deterministic budget tests.
  const runStart = performance.now();
  const timings: TranslationTimings = {
    companySelectionMs: 0,
    translationMs: 0,
    databaseWritesMs: 0,
    cleanupMs: 0,
    totalMs: 0,
  };
  async function timed<T>(bucket: keyof TranslationTimings, fn: () => Promise<T>): Promise<T> {
    const t = performance.now();
    try {
      return await fn();
    } finally {
      timings[bucket] += Math.round(performance.now() - t);
    }
  }

  const run = await timed("databaseWritesMs", () => createRun());
  const summary: TranslationCronSummary = {
    runId: run.id,
    status: "completed",
    kind: "translation",
    companiesExamined: 0,
    companiesProcessed: 0,
    translated: 0,
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
        // A company with pending translations is abandoned → genuine interruption.
        summary.timedOut = true;
        break;
      }

      summary.companiesExamined++;
      try {
        const t = await timed("translationMs", () => translate({ companyId, shouldStop }));
        summary.companiesProcessed++;
        summary.translated += t.translated;
        summary.failed += t.failed;
        summary.skipped += t.skipped;
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
