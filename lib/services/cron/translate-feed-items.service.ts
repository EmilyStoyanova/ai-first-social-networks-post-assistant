import { prisma } from "@/lib/db/client";
import {
  buildTranslationPrompts,
  estimatedTranslationBudgetMs,
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
   * of their size. Counted separately from `skipped` (a source with translation turned
   * off) and from `failed`: a deferred item was never claimed, never attempted and is
   * still fully eligible — nothing about it changed.
   */
  deferred: number;
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
  source: { select: { type: true, config: true } },
} as const;

async function defaultFindCandidates(companyId: string, limit: number): Promise<CandidateRow[]> {
  return prisma.feedItem.findMany({
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
    // 33,340ms left, floor(33,340/4) = 8,335ms, aborted at 8,335ms). Deferring costs
    // nothing — the item is NOT claimed here, so it keeps its attempt count, its status
    // and its place in the queue, and the very next run picks it up with a full budget.
    // `continue`, not `break`: a shorter article later in the batch may still fit.
    if (remaining !== undefined && translationEngineIsBatched) {
      const { segments } = segmentArticle(item.title, item.content, {
        mode: buildTranslationPrompts(item.title, item.content, cfg.targetLanguage).mode,
      });
      const requiredBudgetMs = estimatedTranslationBudgetMs(segments.length, madladHttpBatchSize);
      if (remaining < requiredBudgetMs) {
        console.info("[rss-translation] translation item deferred due to insufficient run budget", {
          feedItemId: item.id,
          remainingRunBudgetMs: remaining,
          segments: segments.length,
          estimatedBatchCount: Math.max(1, Math.ceil(segments.length / madladHttpBatchSize)),
          requiredBudgetMs,
        });
        summary.deferred += 1;
        continue;
      }
    }

    summary.scanned += 1;
    const outcome: TranslateFeedItemOutcome = await translate(
      item,
      cfg.targetLanguage,
      remaining === undefined
        ? undefined
        : { itemTimeoutMs: Math.min(TRANSLATION_ITEM_TIMEOUT_MS, remaining) }
    );

    if (outcome.status === "translated") summary.translated += 1;
    else if (outcome.status === "failed") summary.failed += 1;
    else if (outcome.status === "no_provider") {
      // Nothing in this run can succeed — stop instead of burning the batch.
      summary.reason = "no_provider";
      break;
    } else summary.skipped += 1;
  }

  return summary;
}
