import { performance } from "node:perf_hooks";
import { prisma } from "@/lib/db/client";
import { Prisma } from "@prisma/client";
import {
  syncPostMetrics,
  type SyncPostMetricsSummary,
} from "@/lib/services/analytics/sync-post-metrics.service";
import { SYNCABLE_STATUSES, startOfDay } from "@/lib/services/analytics/_metrics-sync-store";

// ─── Tunables ──────────────────────────────────────────────────────────────────

/**
 * Companies examined per run. Analytics is one cheap HTTP GET per post — no LLM,
 * no images — so a run can cover far more companies than generation does, which
 * is the point: with analytics riding along in the generation cron, a sixth
 * company only saw its metrics refreshed every other day.
 */
const MAX_COMPANIES_PER_RUN = 25;

/**
 * Posts one company may read in a single run. Bounds the damage a single large
 * backlog can do to the run's time budget — the rest of that company's backlog is
 * simply picked up by the next run, stalest first.
 */
const PER_COMPANY_RUN_LIMIT = 100;

/**
 * Posts one company may read in a calendar DAY, across every run.
 *
 * Buffer allows 250 requests/day per key and publishing draws on the same
 * allowance, so this leaves ~50 for posting. It is a real ceiling, not a target:
 * a company with more than 200 eligible posts cannot have all of them refreshed
 * every day, which is why the settings card promises a rotation rather than a
 * strict daily refresh.
 */
export const DAILY_REQUEST_BUDGET = 200;

/**
 * Wall-clock deadline for a run. Matches the other crons: 240s leaves ~60s of
 * headroom under the 300s function cap for persisting the run record.
 */
export const SOFT_TIME_BUDGET_MS = 240_000;

// ─── Types ─────────────────────────────────────────────────────────────────────

/** A company with analytics configured and posts still awaiting today's read. */
export interface AnalyticsCronCompany {
  id: string;
  slug: string;
}

export interface AnalyticsCronSummary {
  runId: string;
  status: "completed" | "failed";
  kind: "analytics";
  /** Companies this run attempted. */
  examined: number;
  /** Companies whose sync completed without throwing. */
  processed: number;
  /** Companies whose sync threw (isolated — the batch continued). */
  failed: number;
  /** Companies skipped because they had already spent the day's request budget. */
  budgetExhausted: number;
  /** Posts read across every company this run. */
  postsRead: number;
  /** Posts whose figures were updated from a successful Buffer read. */
  postsUpdated: number;
  /** Eligible posts across the examined companies still awaiting today's read. */
  remaining: number;
  durationMs: number;
  companies: Array<{ slug: string; summary: SyncPostMetricsSummary }>;
  companyFailures: Array<{ slug: string; message: string }>;
  /** True when the time budget cut the run short — the rest resumes next run. */
  timedOut: boolean;
  error?: string;
}

export interface AnalyticsCronDeps {
  now?: () => Date;
  timeBudgetMs?: number;
  maxCompanies?: number;
  perCompanyLimit?: number;
  dailyBudget?: number;
  createRun?: () => Promise<{ id: string }>;
  finishRun?: (id: string, actions: Record<string, unknown>) => Promise<void>;
  failRun?: (id: string, actions: Record<string, unknown>, error: string) => Promise<void>;
  /** Companies to work on this run, stalest first. */
  selectCompanies?: (limit: number, today: Date) => Promise<AnalyticsCronCompany[]>;
  /** How many posts this company has already read today (its budget spend). */
  countReadToday?: (companyId: string, today: Date) => Promise<number>;
  sync?: typeof syncPostMetrics;
}

// ─── Production defaults (real Prisma) ─────────────────────────────────────────

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

const eligiblePost = {
  bufferUpdateId: { not: null },
  status: { in: [...SYNCABLE_STATUSES] },
} satisfies Prisma.PostWhereInput;

/**
 * Companies to work on, stalest first — the fairness rule one level up from posts.
 *
 * Phase 1: companies holding posts that have never been read at all. They are the
 * furthest behind and the only ones showing an owner nothing.
 *
 * Phase 2: the rest, ordered by their least-recently-read post. A company whose
 * posts were all read today has no row older than midnight and drops out of the
 * selection entirely, which is what lets a later run in the same day spend its
 * whole budget on the companies that still need it.
 *
 * Both phases are grouped queries against indexed columns, and neither depends on
 * run-to-run state: the ordering re-derives itself from what is actually stale, so
 * a run that dies halfway cannot strand a company.
 */
async function defaultSelectCompanies(limit: number, today: Date): Promise<AnalyticsCronCompany[]> {
  // Analytics only exist where a Personal API Key is stored.
  const connections = await prisma.bufferConnection.findMany({
    where: { analyticsKeyEnc: { not: null } },
    select: { companyId: true },
  });
  const enabled = connections.map((c) => c.companyId);
  if (enabled.length === 0) return [];

  const picked: string[] = [];

  const never = await prisma.post.groupBy({
    by: ["companyId"],
    where: { companyId: { in: enabled }, ...eligiblePost, metrics: { is: null } },
    // Every company in this phase is equally far behind (posts nobody has ever
    // read), so the order within it only needs to be stable — Prisma requires one
    // alongside `take`. The backlog itself is what decides who returns next run.
    orderBy: { companyId: "asc" },
    take: limit,
  });
  for (const row of never) picked.push(row.companyId);

  if (picked.length < limit) {
    const stale = await prisma.postMetric.groupBy({
      by: ["companyId"],
      where: { companyId: { in: enabled }, collectedAt: { lt: today }, post: eligiblePost },
      _min: { collectedAt: true },
      orderBy: { _min: { collectedAt: "asc" } },
      take: limit,
    });
    for (const row of stale) {
      if (picked.length >= limit) break;
      if (!picked.includes(row.companyId)) picked.push(row.companyId);
    }
  }

  if (picked.length === 0) return [];

  // Slugs are for the log and the run record only; the order above is what counts.
  const companies = await prisma.company.findMany({
    where: { id: { in: picked } },
    select: { id: true, slug: true },
  });
  const bySlug = new Map(companies.map((c) => [c.id, c.slug]));
  return picked.map((id) => ({ id, slug: bySlug.get(id) ?? id }));
}

async function defaultCountReadToday(companyId: string, today: Date): Promise<number> {
  return prisma.postMetric.count({
    where: { companyId, collectedAt: { gte: today }, post: eligiblePost },
  });
}

// ─── Orchestrator ──────────────────────────────────────────────────────────────

function toActions(summary: AnalyticsCronSummary): Record<string, unknown> {
  return {
    kind: summary.kind,
    examined: summary.examined,
    processed: summary.processed,
    failed: summary.failed,
    budgetExhausted: summary.budgetExhausted,
    postsRead: summary.postsRead,
    postsUpdated: summary.postsUpdated,
    remaining: summary.remaining,
    durationMs: summary.durationMs,
    companies: summary.companies,
    companyFailures: summary.companyFailures,
    timedOut: summary.timedOut,
  };
}

/**
 * Buffer analytics cron — the daily engagement refresh, as its own queue job.
 *
 * It exists because analytics used to run INLINE as the last step of the
 * generation cron, which processes at most 5 companies per run and gave metrics
 * whatever time was left after LLM generation. Two bounds followed from that and
 * both were wrong once the manual "refresh" button was removed: a sixth company
 * was refreshed every other day at best, and each company only ever re-read its
 * 15 newest posts, so an older post could go unread forever.
 *
 * It is triggered by the generation cron tick rather than a schedule entry of its
 * own — Vercel Hobby allows very few crons — but it remains a separate job with
 * its own retry policy, CronRun record and diagnostics, so a Buffer outage is
 * never charged to generation, and generation's time budget is never spent on
 * metric reads. Running once a day is what the per-company limits are sized for:
 * PER_COMPANY_RUN_LIMIT is the practical daily ceiling, with DAILY_REQUEST_BUDGET
 * guarding the extra passes a manual trigger can add.
 *
 * The strategy here is fair batching rather than "no limits":
 *   • posts already read today are excluded, so a day's work is finite and
 *     several runs share it without duplicating a single request;
 *   • within a company, the stalest posts go first (never-read ones first of all);
 *   • across companies, the stalest company goes first, so nobody starves;
 *   • `collectedAt` IS the cursor — a run that stops early or dies leaves exactly
 *     the unread posts pending, and the next run resumes there;
 *   • a per-company daily budget keeps a large backlog inside Buffer's 250/day,
 *     which publishing shares.
 *
 * Every company is failure-isolated: one bad key or one Buffer outage must not
 * cost the other companies their refresh.
 */
export async function runAnalyticsCron(
  deps: AnalyticsCronDeps = {}
): Promise<AnalyticsCronSummary> {
  const now = deps.now ?? (() => new Date());
  const timeBudgetMs = deps.timeBudgetMs ?? SOFT_TIME_BUDGET_MS;
  const maxCompanies = deps.maxCompanies ?? MAX_COMPANIES_PER_RUN;
  const perCompanyLimit = deps.perCompanyLimit ?? PER_COMPANY_RUN_LIMIT;
  const dailyBudget = deps.dailyBudget ?? DAILY_REQUEST_BUDGET;
  const createRun = deps.createRun ?? defaultCreateRun;
  const finishRun = deps.finishRun ?? defaultFinishRun;
  const failRun = deps.failRun ?? defaultFailRun;
  const selectCompanies = deps.selectCompanies ?? defaultSelectCompanies;
  const countReadToday = deps.countReadToday ?? defaultCountReadToday;
  const sync = deps.sync ?? syncPostMetrics;

  const startedAt = now();
  const deadlineMs = startedAt.getTime() + timeBudgetMs;
  const overBudget = () => now().getTime() >= deadlineMs;
  // Threaded into the per-company sync so it stops BETWEEN posts, rather than the
  // run being cut mid-company with a whole batch's worth of work abandoned.
  const shouldStop = () => now().getTime() >= deadlineMs;
  const today = startOfDay(startedAt);

  const runStart = performance.now();
  const run = await createRun();
  const summary: AnalyticsCronSummary = {
    runId: run.id,
    status: "completed",
    kind: "analytics",
    examined: 0,
    processed: 0,
    failed: 0,
    budgetExhausted: 0,
    postsRead: 0,
    postsUpdated: 0,
    remaining: 0,
    durationMs: 0,
    companies: [],
    companyFailures: [],
    timedOut: false,
  };

  try {
    const companies = await selectCompanies(maxCompanies, today);

    for (const company of companies) {
      if (overBudget()) {
        // A company we were about to process is abandoned → genuine interruption.
        summary.timedOut = true;
        break;
      }

      summary.examined++;

      // Buffer's daily allowance is per key, so the budget is checked per company
      // and against what EVERY run today has already spent — not just this one.
      const spent = await countReadToday(company.id, today);
      const allowance = Math.min(perCompanyLimit, dailyBudget - spent);
      if (allowance <= 0) {
        summary.budgetExhausted++;
        console.warn(
          `[cron] Analytics budget spent for ${company.slug}: ${spent} reads today, backlog deferred to tomorrow.`
        );
        continue;
      }

      try {
        const result = await sync({
          companyId: company.id,
          limit: allowance,
          shouldStop,
          now: startedAt,
        });

        summary.processed++;
        summary.postsRead += result.examined;
        summary.postsUpdated += result.updated;
        summary.remaining += result.remaining;
        summary.companies.push({ slug: company.slug, summary: result });
        if (result.stoppedEarly) summary.timedOut = true;
      } catch (err) {
        // Isolated: one company's failure must not cost the others their refresh.
        summary.failed++;
        summary.companyFailures.push({ slug: company.slug, message: message(err) });
        console.error(`[cron] Analytics sync failed for ${company.slug}: ${message(err)}`);
      }
    }

    summary.durationMs = Math.round(performance.now() - runStart);
    await finishRun(run.id, toActions(summary));
    return summary;
  } catch (err) {
    const msg = message(err);
    summary.status = "failed";
    summary.error = msg;
    summary.durationMs = Math.round(performance.now() - runStart);
    await failRun(run.id, toActions(summary), msg);
    return summary;
  }
}
