import { performance } from "node:perf_hooks";
import { prisma } from "@/lib/db/client";
import { Prisma } from "@prisma/client";
import {
  runSourceIngestion,
  type IngestableSource,
  type RunSourceIngestionOptions,
} from "@/lib/services/company/ingest-content-source.service";
import { translateFeedItems, type TranslateFeedItemsSummary } from "./translate-feed-items.service";
import { MAX_TRANSLATION_ATTEMPTS } from "@/lib/ai/feed-item-translation";

// ─── Tunables ──────────────────────────────────────────────────────────────────

/** Sources fetched within this window are fresh and skipped (matches the legacy cron). */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
/** Upper bound on sources examined per run — the deterministic batch cap. */
const MAX_SOURCES_PER_RUN = 25;
/** Max distinct companies whose translation queue is drained per run. */
const MAX_TRANSLATION_COMPANIES_PER_RUN = 10;
/**
 * Wall-clock deadline for a run. 45s leaves ~15s headroom under Vercel's 60s cap for
 * one in-flight article extraction (up to an 8s fetch + JSDOM parse) that was already
 * started when the deadline was crossed. Checked BOTH between sources and, via
 * shouldStop, between items within a source — a single large feed can no longer overrun.
 */
const SOFT_TIME_BUDGET_MS = 45_000;

// ─── Types ─────────────────────────────────────────────────────────────────────

/** A stale source picked for this run, plus the lastFetchedAt used as the CAS version. */
export interface StaleSourceRow extends IngestableSource {
  companyId: string;
  lastFetchedAt: Date | null;
}

/**
 * Wall-clock time (ms) spent in each major phase — surfaced so an operator can see the
 * bottleneck directly instead of inferring it. Measured on a real clock, independent of
 * the injectable `now()` that drives the deadline, so timings stay accurate in production
 * and don't perturb deterministic budget tests. Sum of the phases ≈ totalMs.
 */
export interface IngestionTimings {
  /** selectStaleSources — picking the batch. */
  sourceSelectionMs: number;
  /** All runSourceIngestion calls — feed fetch + article extraction + upserts. */
  sourceIngestionMs: number;
  /** selectTranslationCompanies + all translate calls. */
  translationMs: number;
  /** Cron-level DB writes: createRun + the per-source CAS claims. */
  databaseWritesMs: number;
  /** Wrap-up: the remaining-backlog count. (finishRun, the record write, is excluded.) */
  cleanupMs: number;
  /** Total measured wall-clock of the run. */
  totalMs: number;
}

export interface IngestionCronSummary {
  runId: string;
  status: "completed" | "failed";
  kind: "ingestion";
  /** Sources this run attempted (claim tried): examined = succeeded + failed + skipped. */
  examined: number;
  /** Sources claimed and ingested without throwing. */
  succeeded: number;
  /** Sources claimed whose ingestion threw (isolated — the batch continued). */
  failed: number;
  /** Sources a concurrent run had already claimed (CAS lost) — the locking signal. */
  skipped: number;
  /** Stale sources still awaiting ingestion after this run — the continuation backlog. */
  remaining: number;
  /** Wall-clock duration of the run (equals timings.totalMs). */
  durationMs: number;
  /** Per-phase wall-clock breakdown — the bottleneck at a glance. */
  timings: IngestionTimings;
  itemsCreated: number;
  itemsUpdated: number;
  sourceFailures: Array<{ sourceId: string; companyId: string; message: string }>;
  translation: { companiesProcessed: number; translated: number; failed: number; skipped: number };
  translationFailures: Array<{ companyId: string; message: string }>;
  /** True when the soft time budget cut the run short — the rest resumes next run. */
  timedOut: boolean;
  error?: string;
}

export interface IngestionCronDeps {
  now?: () => Date;
  timeBudgetMs?: number;
  maxSources?: number;
  maxTranslationCompanies?: number;
  staleAfterMs?: number;
  createRun?: () => Promise<{ id: string }>;
  finishRun?: (id: string, actions: Record<string, unknown>) => Promise<void>;
  failRun?: (id: string, actions: Record<string, unknown>, error: string) => Promise<void>;
  selectStaleSources?: (limit: number, staleBefore: Date) => Promise<StaleSourceRow[]>;
  /** Atomic claim: CAS on lastFetchedAt. Returns true iff this run won the source. */
  claimSource?: (id: string, previousFetchedAt: Date | null) => Promise<boolean>;
  ingestSource?: (
    source: IngestableSource,
    companyId: string,
    options?: RunSourceIngestionOptions
  ) => Promise<{ created: number; updated: number }>;
  /** How many stale sources still await ingestion (drives the `remaining` diagnostic). */
  countRemainingStale?: (staleBefore: Date) => Promise<number>;
  selectTranslationCompanies?: (limit: number) => Promise<string[]>;
  translate?: (opts: { companyId: string }) => Promise<TranslateFeedItemsSummary>;
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

/** enabled + stale (null or older than the cutoff) — the deterministic round-robin cursor. */
function staleWhere(staleBefore: Date): Prisma.ContentSourceWhereInput {
  return {
    enabled: true,
    OR: [{ lastFetchedAt: null }, { lastFetchedAt: { lt: staleBefore } }],
  };
}

async function defaultSelectStaleSources(
  limit: number,
  staleBefore: Date
): Promise<StaleSourceRow[]> {
  return prisma.contentSource.findMany({
    where: staleWhere(staleBefore),
    orderBy: [{ lastFetchedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    take: limit,
    select: { id: true, companyId: true, type: true, name: true, config: true, lastFetchedAt: true },
  });
}

async function defaultClaimSource(id: string, previousFetchedAt: Date | null): Promise<boolean> {
  // Compare-and-swap on lastFetchedAt: only the run that still sees the value it read
  // wins the claim, so two overlapping runs can never ingest the same source at once.
  // The claim also advances the cursor, so the next run continues past this source.
  const res = await prisma.contentSource.updateMany({
    where: { id, lastFetchedAt: previousFetchedAt },
    data: { lastFetchedAt: new Date() },
  });
  return res.count === 1;
}

async function defaultCountRemainingStale(staleBefore: Date): Promise<number> {
  return prisma.contentSource.count({ where: staleWhere(staleBefore) });
}

async function defaultSelectTranslationCompanies(limit: number): Promise<string[]> {
  const rows = await prisma.feedItem.findMany({
    where: {
      source: { enabled: true },
      translationStatus: { in: ["pending", "failed"] },
      translationAttemptCount: { lt: MAX_TRANSLATION_ATTEMPTS },
      OR: [{ translationNextRetryAt: null }, { translationNextRetryAt: { lte: new Date() } }],
    },
    select: { companyId: true },
    distinct: ["companyId"],
    take: limit,
  });
  return rows.map((r) => r.companyId);
}

// ─── Orchestrator ──────────────────────────────────────────────────────────────

function toActions(summary: IngestionCronSummary): Record<string, unknown> {
  return {
    kind: summary.kind,
    examined: summary.examined,
    succeeded: summary.succeeded,
    failed: summary.failed,
    skipped: summary.skipped,
    remaining: summary.remaining,
    durationMs: summary.durationMs,
    timings: summary.timings,
    itemsCreated: summary.itemsCreated,
    itemsUpdated: summary.itemsUpdated,
    sourceFailures: summary.sourceFailures,
    translation: summary.translation,
    translationFailures: summary.translationFailures,
    timedOut: summary.timedOut,
  };
}

/**
 * RSS ingestion cron (v2-9, Hobby-safe). Refreshes stale content sources across ALL
 * companies in a bounded, oldest-first batch, then drains the translation queue. Never
 * generates posts.
 *
 * Hobby-safety comes from a wall-clock deadline enforced at TWO granularities:
 *   • between sources — stop claiming new sources once the budget is spent;
 *   • within a source — `shouldStop` is passed into runSourceIngestion so a single large
 *     feed stops between items instead of running all extractions to the timeout.
 *
 * Progress persists via the per-source CAS claim (which advances lastFetchedAt), so the
 * next invocation resumes with the still-stale sources. Every source is failure-isolated.
 */
export async function runIngestionCron(
  deps: IngestionCronDeps = {}
): Promise<IngestionCronSummary> {
  const now = deps.now ?? (() => new Date());
  const timeBudgetMs = deps.timeBudgetMs ?? SOFT_TIME_BUDGET_MS;
  const maxSources = deps.maxSources ?? MAX_SOURCES_PER_RUN;
  const maxTranslationCompanies = deps.maxTranslationCompanies ?? MAX_TRANSLATION_COMPANIES_PER_RUN;
  const staleAfterMs = deps.staleAfterMs ?? STALE_AFTER_MS;
  const createRun = deps.createRun ?? defaultCreateRun;
  const finishRun = deps.finishRun ?? defaultFinishRun;
  const failRun = deps.failRun ?? defaultFailRun;
  const selectStaleSources = deps.selectStaleSources ?? defaultSelectStaleSources;
  const claimSource = deps.claimSource ?? defaultClaimSource;
  const ingestSource = deps.ingestSource ?? runSourceIngestion;
  const countRemainingStale = deps.countRemainingStale ?? defaultCountRemainingStale;
  const selectTranslationCompanies =
    deps.selectTranslationCompanies ?? defaultSelectTranslationCompanies;
  const translate = deps.translate ?? translateFeedItems;

  const startMs = now().getTime();
  const deadlineMs = startMs + timeBudgetMs;
  const overBudget = () => now().getTime() >= deadlineMs;
  // Passed into each source's item loop so it, too, stops at the deadline.
  const shouldStop = () => now().getTime() >= deadlineMs;
  const staleBefore = new Date(startMs - staleAfterMs);

  // Real-clock timing, deliberately separate from the injectable `now()` used for the
  // deadline — accurate in production, and it never perturbs deterministic budget tests.
  const runStart = performance.now();
  const timings: IngestionTimings = {
    sourceSelectionMs: 0,
    sourceIngestionMs: 0,
    translationMs: 0,
    databaseWritesMs: 0,
    cleanupMs: 0,
    totalMs: 0,
  };
  async function timed<T>(bucket: keyof IngestionTimings, fn: () => Promise<T>): Promise<T> {
    const t = performance.now();
    try {
      return await fn();
    } finally {
      timings[bucket] += Math.round(performance.now() - t);
    }
  }

  const run = await timed("databaseWritesMs", () => createRun());
  const summary: IngestionCronSummary = {
    runId: run.id,
    status: "completed",
    kind: "ingestion",
    examined: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    remaining: 0,
    durationMs: 0,
    timings,
    itemsCreated: 0,
    itemsUpdated: 0,
    sourceFailures: [],
    translation: { companiesProcessed: 0, translated: 0, failed: 0, skipped: 0 },
    translationFailures: [],
    timedOut: false,
  };

  try {
    // ── Phase A — ingest stale sources ──────────────────────────────────────
    const sources = await timed("sourceSelectionMs", () =>
      selectStaleSources(maxSources, staleBefore)
    );

    for (const source of sources) {
      if (overBudget()) {
        // A source we were about to process is abandoned → genuine interruption.
        summary.timedOut = true;
        break;
      }

      summary.examined++;
      const won = await timed("databaseWritesMs", () =>
        claimSource(source.id, source.lastFetchedAt)
      );
      if (!won) {
        summary.skipped++;
        continue;
      }

      try {
        const { created, updated } = await timed("sourceIngestionMs", () =>
          ingestSource(
            { id: source.id, type: source.type, name: source.name, config: source.config },
            source.companyId,
            { shouldStop }
          )
        );
        summary.succeeded++;
        summary.itemsCreated += created;
        summary.itemsUpdated += updated;
      } catch (err) {
        summary.failed++;
        summary.sourceFailures.push({
          sourceId: source.id,
          companyId: source.companyId,
          message: message(err),
        });
      }
    }

    // ── Phase B — drain translation queue ───────────────────────────────────
    // Always ask what is pending (a cheap indexed query), THEN let the per-company
    // deadline check decide. timedOut is set only when a company with real pending work
    // is abandoned — never merely because the clock passed the deadline with nothing left
    // to do. (When already over budget, the first loop check breaks before any translate
    // call, so no translation work happens either way — behavior is unchanged.)
    const companies = await timed("translationMs", () =>
      selectTranslationCompanies(maxTranslationCompanies)
    );
    for (const companyId of companies) {
      if (overBudget()) {
        // A company with pending translations is abandoned → genuine interruption.
        summary.timedOut = true;
        break;
      }
      try {
        const t = await timed("translationMs", () => translate({ companyId }));
        summary.translation.companiesProcessed++;
        summary.translation.translated += t.translated;
        summary.translation.failed += t.failed;
        summary.translation.skipped += t.skipped;
      } catch (err) {
        summary.translationFailures.push({ companyId, message: message(err) });
      }
    }

    summary.remaining = await timed("cleanupMs", () => countRemainingStale(staleBefore));
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
