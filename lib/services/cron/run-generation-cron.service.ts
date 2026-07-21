import { prisma } from "@/lib/db/client";
import { Prisma, type AutomationMode } from "@prisma/client";
import { generateWeeklySchedule } from "./generate-weekly-schedule.service";
import { autoApprovePosts } from "./auto-approve-posts.service";
import { publishScheduledPosts } from "./publish-scheduled-posts.service";
import { retryFailedPosts } from "./retry-failed-posts.service";
import { backfillEmbeddings } from "./backfill-embeddings.service";
import { syncPostMetrics } from "@/lib/services/analytics/sync-post-metrics.service";

// ─── Tunables ──────────────────────────────────────────────────────────────────

/**
 * Companies processed per run. Small on purpose: each company can make several LLM
 * generation calls, and the whole run must finish inside Vercel's 60s cap. Throughput
 * comes from running this cron often (hourly), not from a big batch.
 */
const MAX_COMPANIES_PER_RUN = 3;
/** Stop claiming new companies past this; leaves headroom under the 60s function cap. */
const SOFT_TIME_BUDGET_MS = 50_000;

// ─── Types ─────────────────────────────────────────────────────────────────────

/** A company picked for this run, plus lastCronProcessedAt used as the CAS version. */
export interface GenerationCronCompany {
  id: string;
  slug: string;
  automationMode: AutomationMode;
  lastCronProcessedAt: Date | null;
}

export interface GenerationCronSummary {
  runId: string;
  status: "completed" | "failed";
  kind: "generation";
  companiesProcessed: number;
  /** Companies a concurrent run had already claimed (CAS lost) — the locking signal. */
  companiesClaimedElsewhere: number;
  companies: Array<{ slug: string; actions: Record<string, unknown> }>;
  companyFailures: Array<{ slug: string; message: string }>;
  /** True when the soft time budget cut the run short — the rest resumes next run. */
  timedOut: boolean;
  error?: string;
}

export interface GenerationCronDeps {
  now?: () => Date;
  timeBudgetMs?: number;
  maxCompanies?: number;
  createRun?: () => Promise<{ id: string }>;
  finishRun?: (id: string, actions: Record<string, unknown>) => Promise<void>;
  failRun?: (id: string, actions: Record<string, unknown>, error: string) => Promise<void>;
  selectCompanies?: (limit: number) => Promise<GenerationCronCompany[]>;
  /** Atomic claim: CAS on lastCronProcessedAt. Returns true iff this run won the company. */
  claimCompany?: (id: string, previous: Date | null) => Promise<boolean>;
  /** Runs steps 3–8 for one company and returns their per-step diagnostics. */
  processCompany?: (company: GenerationCronCompany) => Promise<Record<string, unknown>>;
}

// ─── Production defaults (real Prisma / real step services) ─────────────────────

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

async function defaultSelectCompanies(limit: number): Promise<GenerationCronCompany[]> {
  return prisma.company.findMany({
    orderBy: [{ lastCronProcessedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    take: limit,
    select: { id: true, slug: true, automationMode: true, lastCronProcessedAt: true },
  });
}

async function defaultClaimCompany(id: string, previous: Date | null): Promise<boolean> {
  // Compare-and-swap on lastCronProcessedAt: only the run that still sees the value it
  // read wins, so two overlapping runs can never generate for the same company at once.
  const res = await prisma.company.updateMany({
    where: { id, lastCronProcessedAt: previous },
    data: { lastCronProcessedAt: new Date() },
  });
  return res.count === 1;
}

/**
 * Steps 3–8, identical to the legacy runCron: schedule → auto-approve → publish → retry
 * → backfill embeddings → sync metrics. Kept as one seam so the orchestrator's batching /
 * fairness / locking can be unit-tested without a real DB or LLM.
 */
async function defaultProcessCompany(
  company: GenerationCronCompany
): Promise<Record<string, unknown>> {
  const actions: Record<string, unknown> = {};
  actions.weeklySchedule = await generateWeeklySchedule(company.id);
  actions.autoApprove = await autoApprovePosts(company.id, company.automationMode);
  actions.publish = await publishScheduledPosts(company.id);
  actions.retry = await retryFailedPosts(company.id);
  actions.backfillEmbeddings = await backfillEmbeddings({ companyId: company.id, limit: 25 });
  actions.syncMetrics = await syncPostMetrics({ companyId: company.id, limit: 15 });
  return actions;
}

// ─── Orchestrator ──────────────────────────────────────────────────────────────

function toActions(summary: GenerationCronSummary): Record<string, unknown> {
  return {
    kind: summary.kind,
    companiesProcessed: summary.companiesProcessed,
    companiesClaimedElsewhere: summary.companiesClaimedElsewhere,
    companies: summary.companies,
    companyFailures: summary.companyFailures,
    timedOut: summary.timedOut,
  };
}

/**
 * Post generation cron (v2-9). Generates and fills weekly schedules from already-ingested
 * content, then auto-approves, publishes, retries, backfills embeddings and syncs metrics —
 * the exact steps 3–8 of the legacy runCron, unchanged. Companies are processed oldest-first
 * in a bounded, time-budgeted batch, each failure-isolated, each claimed with a
 * compare-and-swap so concurrent runs never double-generate.
 */
export async function runGenerationCron(
  deps: GenerationCronDeps = {}
): Promise<GenerationCronSummary> {
  const now = deps.now ?? (() => new Date());
  const timeBudgetMs = deps.timeBudgetMs ?? SOFT_TIME_BUDGET_MS;
  const maxCompanies = deps.maxCompanies ?? MAX_COMPANIES_PER_RUN;
  const createRun = deps.createRun ?? defaultCreateRun;
  const finishRun = deps.finishRun ?? defaultFinishRun;
  const failRun = deps.failRun ?? defaultFailRun;
  const selectCompanies = deps.selectCompanies ?? defaultSelectCompanies;
  const claimCompany = deps.claimCompany ?? defaultClaimCompany;
  const processCompany = deps.processCompany ?? defaultProcessCompany;

  const startMs = now().getTime();
  const overBudget = () => now().getTime() - startMs >= timeBudgetMs;

  const run = await createRun();
  const summary: GenerationCronSummary = {
    runId: run.id,
    status: "completed",
    kind: "generation",
    companiesProcessed: 0,
    companiesClaimedElsewhere: 0,
    companies: [],
    companyFailures: [],
    timedOut: false,
  };

  try {
    const companies = await selectCompanies(maxCompanies);

    for (const company of companies) {
      if (overBudget()) {
        summary.timedOut = true;
        break;
      }

      // Claim BEFORE processing — and only right before — so a company skipped for the
      // time budget is left unclaimed and picked up by the next run, never stranded.
      const won = await claimCompany(company.id, company.lastCronProcessedAt);
      if (!won) {
        summary.companiesClaimedElsewhere++;
        continue;
      }

      try {
        const actions = await processCompany(company);
        summary.companiesProcessed++;
        summary.companies.push({ slug: company.slug, actions });
      } catch (err) {
        summary.companyFailures.push({ slug: company.slug, message: message(err) });
      }
    }

    await finishRun(run.id, toActions(summary));
    return summary;
  } catch (err) {
    const msg = message(err);
    summary.status = "failed";
    summary.error = msg;
    await failRun(run.id, toActions(summary), msg);
    return summary;
  }
}
