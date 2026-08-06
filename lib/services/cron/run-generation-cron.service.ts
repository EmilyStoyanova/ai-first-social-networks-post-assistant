import { performance } from "node:perf_hooks";
import { prisma } from "@/lib/db/client";
import { Prisma, type AutomationMode } from "@prisma/client";
import { generateWeeklySchedule } from "./generate-weekly-schedule.service";
import { autoApprovePosts } from "./auto-approve-posts.service";
import { publishScheduledPosts } from "./publish-scheduled-posts.service";
import { retryFailedPosts } from "./retry-failed-posts.service";
import { backfillEmbeddings } from "./backfill-embeddings.service";
import {
  createRequestDeadline,
  runInRequestDeadline,
  recordPhase,
  raceWithTimeout,
  realTimer,
  type RequestDeadlineContext,
  type Timer,
} from "@/lib/http/request-deadline";

// ─── Tunables ──────────────────────────────────────────────────────────────────

/**
 * Upper bound on companies examined per run — the deterministic batch cap. The real
 * limiter is now the soft time budget (a single company can make several LLM/image
 * calls), not this number; it only caps how many rows the selector pulls.
 */
const MAX_COMPANIES_PER_RUN = 5;
/**
 * Wall-clock deadline for a run. 240s leaves ~60s of headroom under the route's 300s cap
 * (Vercel Hobby + Fluid Compute) — the RESERVE for persisting the CronRun and returning the
 * HTTP response after work stops.
 *
 * The deadline is enforced THREE ways, because a soft (cooperative) deadline alone cannot
 * interrupt an in-flight network call:
 *   • between companies — stop claiming new companies once the budget is spent;
 *   • within a company — `shouldStop` into processCompany → generateWeeklySchedule stops
 *     between LLM/image generations;
 *   • per outbound request — every external call runs under an ambient AbortSignal derived
 *     from the time left to this deadline (see lib/http/request-deadline), so no single
 *     LLM/image/Buffer/Cloudinary/embedding call can consume the remaining headroom;
 *   • out-of-band — each company is RACED against a real timer at the deadline, so even a
 *     call that ignores its signal cannot hold the response past the reserve.
 */
export const SOFT_TIME_BUDGET_MS = 240_000;

// ─── Types ─────────────────────────────────────────────────────────────────────

/** A company picked for this run, plus lastCronProcessedAt used as the CAS version. */
export interface GenerationCronCompany {
  id: string;
  slug: string;
  automationMode: AutomationMode;
  lastCronProcessedAt: Date | null;
}

/**
 * Wall-clock time (ms) spent in each major phase — surfaced so an operator can see the
 * bottleneck directly instead of inferring it. Measured on a real clock, independent of
 * the injectable `now()` that drives the deadline, so timings stay accurate in production
 * and don't perturb deterministic budget tests. Sum of the phases ≈ totalMs.
 */
export interface GenerationTimings {
  /** selectCompanies — picking the batch. */
  companySelectionMs: number;
  /** All processCompany calls — wall clock incl. time spent waiting on external calls. */
  generationMs: number;
  /** Cron-level DB writes: createRun + the per-company CAS claims. */
  databaseWritesMs: number;
  /** Wrap-up: the remaining-backlog count. (finishRun, the record write, is excluded.) */
  cleanupMs: number;
  /** Total measured wall-clock of the run. */
  totalMs: number;
  // ── Per-phase breakdown, accumulated across companies via the ambient deadline ──
  /** generateWeeklySchedule wall clock (its LLM/image time is broken out below). */
  weeklyGenerationMs: number;
  /** LLM calls: aspect mining + generate-with-retry, across all posts this run. */
  llmMs: number;
  /** Image generation (provider + Cloudinary upload), across all posts this run. */
  imageMs: number;
  /** autoApprovePosts. */
  approvalMs: number;
  /** publishScheduledPosts (Buffer). */
  publishingMs: number;
  /** retryFailedPosts. */
  retryMs: number;
  /** backfillEmbeddings (embedding worker). */
  backfillMs: number;
}

export interface GenerationCronSummary {
  runId: string;
  status: "completed" | "failed";
  kind: "generation";
  /** Companies this run attempted (claim tried): examined = processed + failed + skipped. */
  examined: number;
  /** Companies claimed and processed without throwing. */
  processed: number;
  /** Companies claimed whose processing threw (isolated — the batch continued). */
  failed: number;
  /** Companies a concurrent run had already claimed (CAS lost) — the locking signal. */
  skipped: number;
  /** Companies still awaiting this cycle's processing after this run — the continuation backlog. */
  remaining: number;
  /** Wall-clock duration of the run (equals timings.totalMs). */
  durationMs: number;
  /** Per-phase wall-clock breakdown — the bottleneck at a glance. */
  timings: GenerationTimings;
  /** Per-company step diagnostics for the companies this run processed. */
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
  /** Real-timer factory for the out-of-band race; injected in tests to drive the deadline. */
  timer?: Timer;
  createRun?: () => Promise<{ id: string }>;
  finishRun?: (id: string, actions: Record<string, unknown>) => Promise<void>;
  failRun?: (id: string, actions: Record<string, unknown>, error: string) => Promise<void>;
  selectCompanies?: (limit: number) => Promise<GenerationCronCompany[]>;
  /** Atomic claim: CAS on lastCronProcessedAt. Returns true iff this run won the company. */
  claimCompany?: (id: string, previous: Date | null) => Promise<boolean>;
  /** Runs steps 3–7 for one company and returns their per-step diagnostics. */
  processCompany?: (
    company: GenerationCronCompany,
    options: { shouldStop: () => boolean }
  ) => Promise<Record<string, unknown>>;
  /** How many companies still await this cycle's processing (drives the `remaining` diagnostic). */
  countRemaining?: (processedBefore: Date) => Promise<number>;
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
  // The claim also advances the cursor, so the next run continues past this company.
  const res = await prisma.company.updateMany({
    where: { id, lastCronProcessedAt: previous },
    data: { lastCronProcessedAt: new Date() },
  });
  return res.count === 1;
}

/** Companies not yet touched this cycle (never processed, or before this run started). */
async function defaultCountRemaining(processedBefore: Date): Promise<number> {
  return prisma.company.count({
    where: {
      OR: [{ lastCronProcessedAt: null }, { lastCronProcessedAt: { lt: processedBefore } }],
    },
  });
}

/**
 * Steps 3–7: schedule → auto-approve → publish → retry → backfill embeddings. Kept as one
 * seam so the orchestrator's batching / fairness / locking can be unit-tested without a
 * real DB or LLM.
 *
 * The legacy runCron ended with a metrics sync; that step now lives in its own queue job
 * (runAnalyticsCron), enqueued by the same cron tick — see the note at the end of this
 * function.
 *
 * `shouldStop` is threaded into generateWeeklySchedule so its LLM/image loop stops between
 * posts at the deadline, and checked between the subsequent steps so a company crossing the
 * budget defers its remaining maintenance steps to the next run instead of overrunning the
 * function cap. Every step is idempotent and re-run each cycle, so deferring is safe.
 */
async function defaultProcessCompany(
  company: GenerationCronCompany,
  { shouldStop }: { shouldStop: () => boolean }
): Promise<Record<string, unknown>> {
  const actions: Record<string, unknown> = {};
  // Each step is wrapped in recordPhase so its wall-clock time lands in the ambient
  // deadline's phase map (merged into the cron's timings). generateWeeklySchedule breaks
  // its own time down further into `llm`/`image` from inside generatePostFromContext.
  actions.weeklySchedule = await recordPhase("weeklyGeneration", () =>
    generateWeeklySchedule(company.id, { shouldStop })
  );
  if (shouldStop()) return actions;
  actions.autoApprove = await recordPhase("approval", () =>
    autoApprovePosts(company.id, company.automationMode)
  );
  if (shouldStop()) return actions;
  actions.publish = await recordPhase("publishing", () => publishScheduledPosts(company.id));
  if (shouldStop()) return actions;
  actions.retry = await recordPhase("retry", () => retryFailedPosts(company.id));
  if (shouldStop()) return actions;
  actions.backfillEmbeddings = await recordPhase("backfill", () =>
    backfillEmbeddings({ companyId: company.id, limit: 25 })
  );
  // Analytics deliberately does NOT run here. It is its own queue job
  // (ANALYTICS_SYNC_JOB_TYPE → runAnalyticsCron), enqueued by the same cron tick
  // that enqueues this one. Running it inline would put a Buffer outage on
  // generation's retry policy, spend generation's time budget on metric reads, and
  // — because both jobs can run concurrently — double-read the same posts against
  // a per-company daily request budget that only the analytics cron accounts for.
  return actions;
}

// ─── Orchestrator ──────────────────────────────────────────────────────────────

/** Copies the ambient deadline's named phase totals into the typed timings shape. */
function mergePhaseTimings(timings: GenerationTimings, phases: Record<string, number>): void {
  timings.weeklyGenerationMs = phases.weeklyGeneration ?? 0;
  timings.llmMs = phases.llm ?? 0;
  timings.imageMs = phases.image ?? 0;
  timings.approvalMs = phases.approval ?? 0;
  timings.publishingMs = phases.publishing ?? 0;
  timings.retryMs = phases.retry ?? 0;
  timings.backfillMs = phases.backfill ?? 0;
}

function toActions(summary: GenerationCronSummary): Record<string, unknown> {
  return {
    kind: summary.kind,
    examined: summary.examined,
    processed: summary.processed,
    failed: summary.failed,
    skipped: summary.skipped,
    remaining: summary.remaining,
    durationMs: summary.durationMs,
    timings: summary.timings,
    companies: summary.companies,
    companyFailures: summary.companyFailures,
    timedOut: summary.timedOut,
  };
}

/**
 * Post generation cron (v2-9, Hobby-safe). Generates and fills weekly schedules from
 * already-ingested, already-translated content, then auto-approves, publishes, retries and
 * backfills embeddings. Companies are processed oldest-first in a bounded batch, each
 * failure-isolated, each claimed with a compare-and-swap so concurrent runs never
 * double-generate. The Buffer metrics refresh is a sibling job, not a step here.
 *
 * Hobby-safety comes from a wall-clock deadline enforced at FOUR granularities (a soft,
 * cooperative deadline alone cannot interrupt an in-flight network call):
 *   • between companies — stop claiming new companies once the budget is spent;
 *   • within a company — `shouldStop` is threaded into processCompany, and from there into
 *     generateWeeklySchedule, so a single company stops between LLM/image generations;
 *   • per outbound request — each company runs under an ambient request deadline, so every
 *     external call's AbortSignal is bounded by the time left (no single call eats the
 *     headroom, and a hung provider is aborted);
 *   • out-of-band — each company is RACED against a real timer at the deadline, so even a
 *     call that ignores its signal cannot hold the response past the reserve; the company is
 *     abandoned, `timedOut` is set, and the run still persists its CronRun and returns.
 *
 * Progress persists via the per-company CAS claim (which advances lastCronProcessedAt) and
 * via generateWeeklySchedule's own idempotency (the schedule stays "generating" until every
 * channel hits target), so the next invocation resumes the unfinished work.
 */
export async function runGenerationCron(
  deps: GenerationCronDeps = {}
): Promise<GenerationCronSummary> {
  const now = deps.now ?? (() => new Date());
  const timeBudgetMs = deps.timeBudgetMs ?? SOFT_TIME_BUDGET_MS;
  const maxCompanies = deps.maxCompanies ?? MAX_COMPANIES_PER_RUN;
  const timer = deps.timer ?? realTimer;
  const createRun = deps.createRun ?? defaultCreateRun;
  const finishRun = deps.finishRun ?? defaultFinishRun;
  const failRun = deps.failRun ?? defaultFailRun;
  const selectCompanies = deps.selectCompanies ?? defaultSelectCompanies;
  const claimCompany = deps.claimCompany ?? defaultClaimCompany;
  const processCompany = deps.processCompany ?? defaultProcessCompany;
  const countRemaining = deps.countRemaining ?? defaultCountRemaining;

  const startMs = now().getTime();
  const deadlineMs = startMs + timeBudgetMs;
  // Passed into each company's step pipeline so it, too, stops at the deadline.
  const shouldStop = () => now().getTime() >= deadlineMs;
  const processedBefore = new Date(startMs);

  // Ambient deadline for every outbound request made while processing a company: each
  // external call's AbortSignal is derived from the time left to `deadlineMs`. One ctx is
  // reused across companies so per-phase timings accumulate. Its clock is `now()`, so a test
  // that injects `now` also controls the per-request budget math.
  const deadline: RequestDeadlineContext = createRequestDeadline(deadlineMs, () => now().getTime());

  // Real-clock timing, deliberately separate from the injectable `now()` used for the
  // deadline — accurate in production, and it never perturbs deterministic budget tests.
  const runStart = performance.now();
  const timings: GenerationTimings = {
    companySelectionMs: 0,
    generationMs: 0,
    databaseWritesMs: 0,
    cleanupMs: 0,
    totalMs: 0,
    weeklyGenerationMs: 0,
    llmMs: 0,
    imageMs: 0,
    approvalMs: 0,
    publishingMs: 0,
    retryMs: 0,
    backfillMs: 0,
  };
  async function timed<T>(bucket: keyof GenerationTimings, fn: () => Promise<T>): Promise<T> {
    const t = performance.now();
    try {
      return await fn();
    } finally {
      timings[bucket] += Math.round(performance.now() - t);
    }
  }

  const run = await timed("databaseWritesMs", () => createRun());
  const summary: GenerationCronSummary = {
    runId: run.id,
    status: "completed",
    kind: "generation",
    examined: 0,
    processed: 0,
    failed: 0,
    skipped: 0,
    remaining: 0,
    durationMs: 0,
    timings,
    companies: [],
    companyFailures: [],
    timedOut: false,
  };

  try {
    const companies = await timed("companySelectionMs", () => selectCompanies(maxCompanies));

    for (const company of companies) {
      // One now() read per iteration drives BOTH the "start new work?" gate and the race
      // budget, so the injectable clock advances deterministically for tests.
      const nowMs = now().getTime();
      const raceMs = deadlineMs - nowMs;
      if (raceMs <= 0) {
        // A company we were about to process is abandoned → genuine interruption.
        summary.timedOut = true;
        break;
      }

      summary.examined++;
      // Claim BEFORE processing — and only right before — so a company skipped for the
      // time budget is left unclaimed and picked up by the next run, never stranded.
      const won = await timed("databaseWritesMs", () =>
        claimCompany(company.id, company.lastCronProcessedAt)
      );
      if (!won) {
        summary.skipped++;
        continue;
      }

      // Run the company's work under the ambient deadline (so its outbound calls are
      // budget-bounded) AND race it against a real timer at the deadline. The race is the
      // hard guarantee: even a call that ignores its AbortSignal cannot hold the response
      // past the deadline — we abandon it, leaving the ~60s reserve to persist + respond.
      const work = runInRequestDeadline(deadline, () => processCompany(company, { shouldStop }));

      let raced: { timedOut: false; value: Record<string, unknown> } | { timedOut: true };
      try {
        raced = await timed("generationMs", () => raceWithTimeout(work, raceMs, timer));
      } catch (err) {
        // A company that threw is isolated — record it and carry on with the batch.
        summary.failed++;
        summary.companyFailures.push({ slug: company.slug, message: message(err) });
        continue;
      }

      if (raced.timedOut) {
        summary.timedOut = true;
        summary.failed++;
        summary.companyFailures.push({
          slug: company.slug,
          message: `Abandoned at the soft deadline after ${raceMs}ms — in-flight work exceeded the budget.`,
        });
        break; // no budget left for further companies
      }

      summary.processed++;
      summary.companies.push({ slug: company.slug, actions: raced.value });
    }

    // Merge the per-phase timings accumulated across companies via the ambient deadline.
    mergePhaseTimings(timings, deadline.phases);
    summary.remaining = await timed("cleanupMs", () => countRemaining(processedBefore));
    timings.totalMs = Math.round(performance.now() - runStart);
    summary.durationMs = timings.totalMs;
    await finishRun(run.id, toActions(summary));
    return summary;
  } catch (err) {
    const msg = message(err);
    summary.status = "failed";
    summary.error = msg;
    mergePhaseTimings(timings, deadline.phases);
    timings.totalMs = Math.round(performance.now() - runStart);
    summary.durationMs = timings.totalMs;
    await failRun(run.id, toActions(summary), msg);
    return summary;
  }
}
