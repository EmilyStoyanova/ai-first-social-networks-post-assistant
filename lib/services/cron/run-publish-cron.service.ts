import { performance } from "node:perf_hooks";
import { prisma } from "@/lib/db/client";
import { Prisma } from "@prisma/client";
import {
  publishCandidateWhere,
  publishScheduledPosts,
  type PublishScheduledSummary,
} from "./publish-scheduled-posts.service";
import { PUBLISH_SWEEP_INTERVAL_MS } from "@/lib/scheduling/publish-window";

// ─── Tunables ──────────────────────────────────────────────────────────────────

/**
 * Companies examined per sweep. Publishing is a handful of Buffer POSTs per company
 * — no LLM, no images — and `publishScheduledPosts` caps itself at 10 sends, so a
 * sweep can cover far more companies than generation does.
 *
 * It is a batch cap, not a fairness cursor: selection is driven by which company has
 * the OLDEST due post, so a run that hits the cap leaves the least urgent behind and
 * the next tick (30 minutes later, not tomorrow) starts with whoever is now oldest.
 */
const MAX_COMPANIES_PER_RUN = 25;

/**
 * Wall-clock deadline for a sweep — 240s, matching the other crons.
 *
 * It has a second job here that it does not have elsewhere: a sweep must finish
 * comfortably inside PUBLISH_SWEEP_INTERVAL_MS, or its dedupe key would still be
 * held when the next tick arrives and that tick would be dropped. 240s against a
 * 30-minute interval leaves that margin an order of magnitude wider than it needs
 * to be, which is the point — losing ticks is how a publisher silently falls behind.
 */
export const SOFT_TIME_BUDGET_MS = 240_000;

// ─── Types ─────────────────────────────────────────────────────────────────────

/** A company holding at least one post this sweep could act on. */
export interface PublishCronCompany {
  id: string;
  slug: string;
}

export interface PublishCronSummary {
  runId: string;
  status: "completed" | "failed";
  kind: "publish";
  /** Companies this sweep attempted. */
  examined: number;
  /** Companies whose publish step completed without throwing. */
  processed: number;
  /** Companies whose publish step threw (isolated — the sweep continued). */
  failed: number;
  /** Posts handed to Buffer across every company this sweep. */
  published: number;
  /** Posts Buffer refused, per-post — they go to the retry step, as before. */
  failedPosts: number;
  /** Posts not attempted because the company has no usable Buffer connection. */
  skipped: number;
  /** Manual posts parked past due — they wait for a person to pick a new time. */
  pastDue: number;
  /**
   * Companies with due work this sweep did not reach. Persistently non-zero means
   * MAX_COMPANIES_PER_RUN is undersized for the number of companies publishing —
   * the one number that says a post could be late for a reason nobody chose.
   */
  remaining: number;
  durationMs: number;
  companies: Array<{ slug: string; summary: PublishScheduledSummary }>;
  companyFailures: Array<{ slug: string; message: string }>;
  /** True when the time budget cut the sweep short — the rest resumes next tick. */
  timedOut: boolean;
  error?: string;
}

export interface PublishCronDeps {
  now?: () => Date;
  timeBudgetMs?: number;
  maxCompanies?: number;
  createRun?: () => Promise<{ id: string }>;
  finishRun?: (id: string, actions: Record<string, unknown>) => Promise<void>;
  failRun?: (id: string, actions: Record<string, unknown>, error: string) => Promise<void>;
  /** Companies with work this sweep, most overdue first. */
  selectCompanies?: (limit: number, now: Date) => Promise<PublishCronCompany[]>;
  /** How many companies have work at all — drives the `remaining` diagnostic. */
  countCompaniesWithWork?: (now: Date) => Promise<number>;
  /** The per-company publisher. Production always wires the real service. */
  publish?: (companyId: string) => Promise<PublishScheduledSummary>;
}

// ─── Production defaults (real Prisma / the real publisher) ────────────────────

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
 * Companies to sweep, most overdue first.
 *
 * Deliberately NOT round-robin on `Company.lastCronProcessedAt`: that column is the
 * generation cron's compare-and-swap cursor, and advancing it here would make the
 * publisher skip companies out of the generation rotation — automatic behaviour
 * changed by a change that has nothing to do with generation.
 *
 * Instead the work itself is the cursor. Companies are grouped by their oldest
 * publishable post, so the one whose post has been waiting longest goes first, and
 * a company with nothing to do drops out of the selection entirely rather than
 * consuming a slot. Nothing is carried between runs, so a sweep that dies halfway
 * strands no one — the next tick re-derives the same ordering from what is still due.
 *
 * The predicate is `publishCandidateWhere`, the same one the publisher reads with:
 * parked posts are excluded there, so a company holding only stranded posts is not
 * selected forever.
 */
async function defaultSelectCompanies(limit: number, now: Date): Promise<PublishCronCompany[]> {
  const groups = await prisma.post.groupBy({
    by: ["companyId"],
    where: publishCandidateWhere(now),
    _min: { scheduledFor: true },
    orderBy: { _min: { scheduledFor: "asc" } },
    take: limit,
  });
  if (groups.length === 0) return [];

  const ids = groups.map((g) => g.companyId);
  // Slugs are for the log and the run record only; the order above is what counts.
  const companies = await prisma.company.findMany({
    where: { id: { in: ids } },
    select: { id: true, slug: true },
  });
  const bySlug = new Map(companies.map((c) => [c.id, c.slug]));
  return ids.map((id) => ({ id, slug: bySlug.get(id) ?? id }));
}

async function defaultCountCompaniesWithWork(now: Date): Promise<number> {
  const groups = await prisma.post.groupBy({
    by: ["companyId"],
    where: publishCandidateWhere(now),
  });
  return groups.length;
}

// ─── Orchestrator ──────────────────────────────────────────────────────────────

function toActions(summary: PublishCronSummary): Record<string, unknown> {
  return {
    kind: summary.kind,
    examined: summary.examined,
    processed: summary.processed,
    failed: summary.failed,
    published: summary.published,
    failedPosts: summary.failedPosts,
    skipped: summary.skipped,
    pastDue: summary.pastDue,
    remaining: summary.remaining,
    durationMs: summary.durationMs,
    companies: summary.companies,
    companyFailures: summary.companyFailures,
    timedOut: summary.timedOut,
  };
}

/**
 * The publishing sweep — the ONE path that hands scheduled posts to Buffer.
 *
 * It exists because publishing used to be step 5 INSIDE the generation cron, which
 * runs once a day. That was survivable while every schedule was a cron estimate the
 * publisher could act on up to 48 hours early. It stopped being survivable when a
 * person could name a time: `PAST_DUE_GRACE_MS` is 90 minutes, so a daily sweep
 * would have parked nearly every manually scheduled post instead of sending it.
 *
 * So the trigger moved out and the frequency went up, while the RULE did not change
 * at all — `publishScheduledPosts` and `decidePublish` are untouched, which is what
 * keeps automatic posts behaving exactly as they always have. What changed is only
 * how often someone asks.
 *
 * Being the only publisher is load-bearing, not tidiness. `publishScheduledPosts`
 * reads approved posts, sends them, then marks them sent; two publishers running
 * concurrently can both read the same row before either marks it, and the post goes
 * out twice. There is no per-post claim to fall back on, so the guarantee has to
 * come from there being one sweep at a time:
 *
 *   • one job type with one dedupe key (PUBLISH_SWEEP_DEDUPE_KEY), so the external
 *     30-minute scheduler and the daily generation tick collapse into one run;
 *   • the worker's own lease, so one claimed job runs on one worker;
 *   • and no inline publish step anywhere else in the pipeline.
 *
 * Every company is failure-isolated: one expired Buffer token must not stop the
 * other companies' posts from going out on time.
 */
export async function runPublishCron(deps: PublishCronDeps = {}): Promise<PublishCronSummary> {
  const now = deps.now ?? (() => new Date());
  const timeBudgetMs = deps.timeBudgetMs ?? SOFT_TIME_BUDGET_MS;
  const maxCompanies = deps.maxCompanies ?? MAX_COMPANIES_PER_RUN;
  const createRun = deps.createRun ?? defaultCreateRun;
  const finishRun = deps.finishRun ?? defaultFinishRun;
  const failRun = deps.failRun ?? defaultFailRun;
  const selectCompanies = deps.selectCompanies ?? defaultSelectCompanies;
  const countCompaniesWithWork = deps.countCompaniesWithWork ?? defaultCountCompaniesWithWork;
  const publish = deps.publish ?? ((companyId: string) => publishScheduledPosts(companyId));

  const startedAt = now();
  const deadlineMs = startedAt.getTime() + timeBudgetMs;
  const overBudget = () => now().getTime() >= deadlineMs;

  const runStart = performance.now();
  const run = await createRun();
  const summary: PublishCronSummary = {
    runId: run.id,
    status: "completed",
    kind: "publish",
    examined: 0,
    processed: 0,
    failed: 0,
    published: 0,
    failedPosts: 0,
    skipped: 0,
    pastDue: 0,
    remaining: 0,
    durationMs: 0,
    companies: [],
    companyFailures: [],
    timedOut: false,
  };

  try {
    const withWork = await countCompaniesWithWork(startedAt);
    const companies = await selectCompanies(maxCompanies, startedAt);

    for (const company of companies) {
      if (overBudget()) {
        // A company we were about to publish for is abandoned → genuine interruption.
        summary.timedOut = true;
        break;
      }

      summary.examined++;

      try {
        const result = await publish(company.id);

        summary.processed++;
        summary.published += result.published;
        summary.failedPosts += result.failed;
        summary.skipped += result.skipped;
        summary.pastDue += result.pastDue;
        summary.companies.push({ slug: company.slug, summary: result });
      } catch (err) {
        // Isolated: one company's Buffer problem must not delay everyone else's posts.
        summary.failed++;
        summary.companyFailures.push({ slug: company.slug, message: message(err) });
        console.error(`[cron] Publish sweep failed for ${company.slug}: ${message(err)}`);
      }
    }

    // Companies with due work this sweep never reached — because the batch cap or the
    // time budget stopped it. Not the same as "posts left over": a company IS reached
    // and still leaves posts behind when it has more than MAX_PUBLISHES_PER_RUN due.
    summary.remaining = Math.max(0, withWork - summary.examined);

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

/** Re-exported so operators reading the sweep can see the cadence it is sized for. */
export { PUBLISH_SWEEP_INTERVAL_MS };
