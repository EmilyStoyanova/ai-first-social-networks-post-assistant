import { prisma } from "@/lib/db/client";
import { Prisma } from "@prisma/client";
import {
  runSourceIngestion,
  type IngestableSource,
} from "@/lib/services/company/ingest-content-source.service";
import { translateFeedItems, type TranslateFeedItemsSummary } from "./translate-feed-items.service";
import { MAX_TRANSLATION_ATTEMPTS } from "@/lib/ai/feed-item-translation";

// ─── Tunables ──────────────────────────────────────────────────────────────────

/** Sources fetched within this window are fresh and skipped (matches the legacy cron). */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
/** Max sources ingested per run — bounds the batch so it stays inside the 60s budget. */
const MAX_SOURCES_PER_RUN = 25;
/** Max distinct companies whose translation queue is drained per run. */
const MAX_TRANSLATION_COMPANIES_PER_RUN = 10;
/** Stop starting new work past this; leaves headroom under Vercel's 60s function cap. */
const SOFT_TIME_BUDGET_MS = 50_000;

// ─── Types ─────────────────────────────────────────────────────────────────────

/** A stale source picked for this run, plus the lastFetchedAt used as the CAS version. */
export interface StaleSourceRow extends IngestableSource {
  companyId: string;
  lastFetchedAt: Date | null;
}

export interface IngestionCronSummary {
  runId: string;
  status: "completed" | "failed";
  kind: "ingestion";
  sourcesProcessed: number;
  /** Sources a concurrent run had already claimed (CAS lost) — the locking signal. */
  sourcesClaimedElsewhere: number;
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
    companyId: string
  ) => Promise<{ created: number; updated: number }>;
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

async function defaultSelectStaleSources(
  limit: number,
  staleBefore: Date
): Promise<StaleSourceRow[]> {
  return prisma.contentSource.findMany({
    where: {
      enabled: true,
      OR: [{ lastFetchedAt: null }, { lastFetchedAt: { lt: staleBefore } }],
    },
    orderBy: [{ lastFetchedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    take: limit,
    select: { id: true, companyId: true, type: true, name: true, config: true, lastFetchedAt: true },
  });
}

async function defaultClaimSource(id: string, previousFetchedAt: Date | null): Promise<boolean> {
  // Compare-and-swap on lastFetchedAt: only the run that still sees the value it read
  // wins the claim, so two overlapping runs can never ingest the same source at once.
  const res = await prisma.contentSource.updateMany({
    where: { id, lastFetchedAt: previousFetchedAt },
    data: { lastFetchedAt: new Date() },
  });
  return res.count === 1;
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
    sourcesProcessed: summary.sourcesProcessed,
    sourcesClaimedElsewhere: summary.sourcesClaimedElsewhere,
    itemsCreated: summary.itemsCreated,
    itemsUpdated: summary.itemsUpdated,
    sourceFailures: summary.sourceFailures,
    translation: summary.translation,
    translationFailures: summary.translationFailures,
    timedOut: summary.timedOut,
  };
}

/**
 * RSS ingestion cron (v2-9). Refreshes stale content sources across ALL companies in a
 * bounded, fairly-rotated batch, then drains the translation queue. Never generates
 * posts. Every source and every company is failure-isolated so one bad feed cannot stall
 * the run, and a per-source compare-and-swap on lastFetchedAt prevents concurrent runs
 * from double-processing.
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
  const selectTranslationCompanies =
    deps.selectTranslationCompanies ?? defaultSelectTranslationCompanies;
  const translate = deps.translate ?? translateFeedItems;

  const startMs = now().getTime();
  const overBudget = () => now().getTime() - startMs >= timeBudgetMs;

  const run = await createRun();
  const summary: IngestionCronSummary = {
    runId: run.id,
    status: "completed",
    kind: "ingestion",
    sourcesProcessed: 0,
    sourcesClaimedElsewhere: 0,
    itemsCreated: 0,
    itemsUpdated: 0,
    sourceFailures: [],
    translation: { companiesProcessed: 0, translated: 0, failed: 0, skipped: 0 },
    translationFailures: [],
    timedOut: false,
  };

  try {
    // ── Phase A — ingest stale sources ──────────────────────────────────────
    const staleBefore = new Date(startMs - staleAfterMs);
    const sources = await selectStaleSources(maxSources, staleBefore);

    for (const source of sources) {
      if (overBudget()) {
        summary.timedOut = true;
        break;
      }

      const won = await claimSource(source.id, source.lastFetchedAt);
      if (!won) {
        summary.sourcesClaimedElsewhere++;
        continue;
      }

      try {
        const { created, updated } = await ingestSource(
          { id: source.id, type: source.type, name: source.name, config: source.config },
          source.companyId
        );
        summary.sourcesProcessed++;
        summary.itemsCreated += created;
        summary.itemsUpdated += updated;
      } catch (err) {
        summary.sourceFailures.push({
          sourceId: source.id,
          companyId: source.companyId,
          message: message(err),
        });
      }
    }

    // ── Phase B — drain translation queue ───────────────────────────────────
    if (overBudget()) {
      summary.timedOut = true;
    } else {
      const companies = await selectTranslationCompanies(maxTranslationCompanies);
      for (const companyId of companies) {
        if (overBudget()) {
          summary.timedOut = true;
          break;
        }
        try {
          const t = await translate({ companyId });
          summary.translation.companiesProcessed++;
          summary.translation.translated += t.translated;
          summary.translation.failed += t.failed;
          summary.translation.skipped += t.skipped;
        } catch (err) {
          summary.translationFailures.push({ companyId, message: message(err) });
        }
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
