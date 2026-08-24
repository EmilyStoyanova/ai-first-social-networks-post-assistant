import { prisma } from "@/lib/db/client";
import {
  buildTranslationPrompts,
  estimatedTranslationBudgetMs,
  maxBatchesFittingBudget,
  MIN_TRANSLATION_ITEM_BUDGET_MS,
  TRANSLATION_BATCH_SIZE,
  TRANSLATION_ITEM_TIMEOUT_MS,
  resolveTranslationConfig,
} from "@/lib/ai/feed-item-translation";
import { segmentArticle } from "@/lib/ai/translation/madlad-segmentation";
import { resolveTranslationProviderConfig } from "@/lib/ai/translation/translation-provider-config";
import { translationSelectableWhere } from "@/lib/ai/feed-item-translation-claim";
import {
  translateFeedItem,
  type TranslateFeedItemOutcome,
  type TranslatableItem,
} from "@/lib/services/ai/translate-feed-item.service";

/**
 * Cron step 2b — translates queued RSS items into the company's target language
 * (v2-4). Runs after ingestion (2a) and before generation (3) so a post is
 * written from translated text as soon as it is available.
 *
 * Bounded to TRANSLATION_BATCH_SIZE LLM calls per run; the backlog drains across
 * runs. Individual failures are recorded by the translation service and never
 * thrown, so one bad article cannot stall the run.
 */

export interface TranslateFeedItemsSummary {
  scanned: number;
  translated: number;
  failed: number;
  skipped: number;
  /**
   * Items left for a future run because this one had too little budget for an article
   * of their size but WOULD fit in a fresh run — see the oversized-article branch below
   * for the case that never fits at all, which is claimed (not deferred) instead.
   * Counted separately from `skipped` (a source with translation turned off) and from
   * `failed`: a deferred item was never claimed, never attempted and is still fully
   * eligible — nothing about it changed.
   */
  deferred: number;
  /**
   * Oversized articles that banked real batch progress this run and were released back
   * to `pending` to resume next run — see `maxBatchesFittingBudget`. Counted separately
   * from `translated` (not yet complete) and `failed` (still retryable): a partial item
   * IS claimed and DOES cost one of its five attempts, unlike a deferred one.
   */
  partial: number;
  /** Set when the batch stopped early because no default provider is configured. */
  reason?: "no_provider";
}

interface CandidateRow extends TranslatableItem {
  source: { type: string; config: unknown };
}

export interface TranslateFeedItemsDeps {
  findCandidates?: (companyId: string, limit: number) => Promise<CandidateRow[]>;
  loadCompanyLang?: (companyId: string) => Promise<string>;
  translate?: typeof translateFeedItem;
  /** Defaults to `process.env`. Injected so the admission gate is testable. */
  env?: Record<string, string | undefined>;
}

const SELECT = {
  id: true,
  // Read only so the translation's trace run can be filed under the company it
  // belongs to; nothing in translation itself branches on it.
  companyId: true,
  title: true,
  content: true,
  url: true,
  translationStatus: true,
  translationHash: true,
  translationAttemptCount: true,
  translationProgress: true,
  source: { select: { type: true, config: true } },
} as const;

async function defaultFindCandidates(companyId: string, limit: number): Promise<CandidateRow[]> {
  const rows = await prisma.feedItem.findMany({
    where: {
      companyId,
      source: { enabled: true },
      // Retry-due pending/failed items, plus crashed `translating` claims past their
      // lease (recovery). A live claim is excluded, so an in-flight item is never re-picked.
      ...translationSelectableWhere(new Date()),
    },
    orderBy: [{ translationNextRetryAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    take: limit,
    select: SELECT,
  });
  // Prisma types a Json column as the broad `JsonValue` union; every write path in this
  // pipeline stores either a flat `{segmentIndex: rawText}` map or NULL (see the schema
  // comment on FeedItem.translationProgress), so narrowing here is safe.
  return rows.map((row) => ({
    ...row,
    translationProgress: row.translationProgress as Record<string, string> | null,
  }));
}

export interface TranslateFeedItemsOptions {
  companyId: string;
  limit?: number;
  shouldStop?: () => boolean;
  /**
   * Milliseconds the RUN has left. Optional — omitted, each item keeps its own full budget,
   * which is the pre-existing behaviour.
   *
   * `shouldStop` alone is not enough, and the gap is arithmetic: it is checked BEFORE an item
   * and an item may then run for TRANSLATION_ITEM_TIMEOUT_MS (210s), so an item started one
   * millisecond inside a 240s run budget can carry the run to ~450s — past the 300s route cap
   * the budget exists to respect. Squeezing each item's own budget down to what is actually
   * left closes that, and below MIN_TRANSLATION_ITEM_BUDGET_MS the loop stops rather than
   * starting an article it can only time out on. Nothing is lost either way: an unstarted
   * item stays pending and the continuation job picks it up.
   */
  remainingMs?: () => number;
}

export async function translateFeedItems(
  opts: TranslateFeedItemsOptions,
  deps: TranslateFeedItemsDeps = {}
): Promise<TranslateFeedItemsSummary> {
  const limit = opts.limit ?? TRANSLATION_BATCH_SIZE;
  const findCandidates = deps.findCandidates ?? defaultFindCandidates;
  const translate = deps.translate ?? translateFeedItem;
  const loadCompanyLang =
    deps.loadCompanyLang ??
    (async (companyId: string) => {
      const company = await prisma.company.findUnique({
        where: { id: companyId },
        select: { defaultLang: true },
      });
      return company?.defaultLang ?? "en";
    });

  const summary: TranslateFeedItemsSummary = {
    scanned: 0,
    translated: 0,
    failed: 0,
    skipped: 0,
    deferred: 0,
    partial: 0,
  };

  // The size-aware gate below only makes sense for an engine that splits an article
  // into several HTTP calls. The prompt-based engine sends ONE request per article, so
  // its cost does not scale with segment count and the flat floor already covers it —
  // reading the config here keeps this file from guessing which engine will run.
  const providerConfig = resolveTranslationProviderConfig(deps.env ?? process.env);
  const translationEngineIsBatched = providerConfig.kind === "madlad";
  const madladHttpBatchSize = providerConfig.madladHttpBatchSize;

  const candidates = await findCandidates(opts.companyId, limit);
  if (candidates.length === 0) return summary;

  const companyLang = await loadCompanyLang(opts.companyId);

  for (const item of candidates) {
    // Out of time for this run — checked before every slow translation so a large batch
    // cannot overrun the function limit. Remaining items are picked up next run (they stay
    // pending and are deduped by translation hash), so nothing is lost.
    if (opts.shouldStop?.()) break;

    const cfg = resolveTranslationConfig(item.source.type, item.source.config, companyLang);
    // The source's translation was turned off after the item was queued.
    if (!cfg.enabled) {
      summary.scanned += 1;
      summary.skipped += 1;
      continue;
    }

    // Too little of the run left to translate anything — stop rather than start an article
    // that can only time out (and burn one of its five cross-run attempts doing so).
    const remaining = opts.remainingMs?.();
    if (remaining !== undefined && remaining <= MIN_TRANSLATION_ITEM_BUDGET_MS) break;

    // And too little left for THIS article specifically. The floor above is one number
    // for every article, but MADLAD splits the item budget into a fair share per HTTP
    // batch, so a long article started on a nearly-spent run gives each batch a slice
    // too small to answer in and aborts on batch 1 (feed item 5bdc0e48: 99 segments,
    // 33,340ms left, floor(33,340/4) = 8,335ms, aborted at 8,335ms).
    //
    // Two cases, and they are handled completely differently:
    //
    //   • FITS a fresh run, just not THIS one (requiredBudgetMs <= TRANSLATION_ITEM_TIMEOUT_MS,
    //     the true ceiling any item is EVER given — see TRANSLATION_ITEM_TIMEOUT_MS's own
    //     comment: itemTimeoutMs is min(that, remaining), so remaining alone overstates what
    //     an admitted item would actually get). Deferring costs nothing — the item is NOT
    //     claimed, so it keeps its attempt count, its status and its place in the queue, and
    //     the very next run (with a full budget again) fits it normally. `continue`, not
    //     `break`: a shorter article later in the batch may still fit THIS run.
    //
    //   • NEVER fits one call, on ANY run (requiredBudgetMs > TRANSLATION_ITEM_TIMEOUT_MS —
    //     the reported bug: 289 segments, 250,000ms required vs a 210,000ms ceiling no fresh
    //     run can ever exceed). Deferring this forever is exactly the infinite loop this fix
    //     exists for: `remaining` never gets bigger than the same ceiling, so the same
    //     comparison repeats every run, the item is never claimed, its attempt count never
    //     moves, and `remaining` (the continuation trigger) never reaches zero. Instead the
    //     item IS claimed, with `maxBatchesThisCall` capping it to only as many MADLAD HTTP
    //     batches as safely fit right now — bounded, measurable forward progress every claim,
    //     persisted so the next claim resumes instead of re-translating. Claiming also means
    //     this now counts against the item's normal 5-attempt cap, so even a batch estimate
    //     that turns out to be wrong in some future edge case cannot loop unboundedly: after
    //     at most 5 claims the item is complete or explicitly failed (see
    //     translate-feed-item.service.ts's MadladPartialProgressError handling) — never
    //     deferred-without-progress again.
    let maxBatchesThisCall: number | undefined;
    if (remaining !== undefined && translationEngineIsBatched) {
      const { segments } = segmentArticle(item.title, item.content, {
        mode: buildTranslationPrompts(item.title, item.content, cfg.targetLanguage).mode,
      });
      const requiredBudgetMs = estimatedTranslationBudgetMs(segments.length, madladHttpBatchSize);
      const batchCount = Math.max(1, Math.ceil(segments.length / madladHttpBatchSize));
      const oversized = requiredBudgetMs > TRANSLATION_ITEM_TIMEOUT_MS;

      if (!oversized && remaining < requiredBudgetMs) {
        console.info("[rss-translation] translation item deferred due to insufficient run budget", {
          feedItemId: item.id,
          remainingRunBudgetMs: remaining,
          segmentCount: segments.length,
          batchCount,
          estimatedRequiredBudgetMs: requiredBudgetMs,
          progressMade: false,
          continuationReason: "run_budget_insufficient",
        });
        summary.deferred += 1;
        continue;
      }

      if (oversized) {
        maxBatchesThisCall = maxBatchesFittingBudget(
          Math.min(remaining, TRANSLATION_ITEM_TIMEOUT_MS)
        );
        console.info(
          "[rss-translation] oversized translation item — processing in bounded batches",
          {
            feedItemId: item.id,
            remainingRunBudgetMs: remaining,
            segmentCount: segments.length,
            batchCount,
            estimatedRequiredBudgetMs: requiredBudgetMs,
            batchesThisCall: maxBatchesThisCall,
            progressMade: null,
            continuationReason: "oversized_article",
          }
        );
      }
    }

    summary.scanned += 1;
    const outcome: TranslateFeedItemOutcome = await translate(item, cfg.targetLanguage, {
      ...(remaining === undefined
        ? {}
        : { itemTimeoutMs: Math.min(TRANSLATION_ITEM_TIMEOUT_MS, remaining) }),
      ...(maxBatchesThisCall === undefined ? {} : { maxBatchesThisCall }),
    });

    if (outcome.status === "translated") summary.translated += 1;
    else if (outcome.status === "partial") summary.partial += 1;
    else if (outcome.status === "failed") summary.failed += 1;
    else if (outcome.status === "no_provider") {
      // Nothing in this run can succeed — stop instead of burning the batch.
      summary.reason = "no_provider";
      break;
    } else summary.skipped += 1;
  }

  return summary;
}
