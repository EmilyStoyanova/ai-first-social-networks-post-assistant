import { prisma } from "@/lib/db/client";
import {
  MAX_TRANSLATION_ATTEMPTS,
  TRANSLATION_BATCH_SIZE,
  resolveTranslationConfig,
} from "@/lib/ai/feed-item-translation";
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
}

const SELECT = {
  id: true,
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
      translationStatus: { in: ["pending", "failed"] },
      translationAttemptCount: { lt: MAX_TRANSLATION_ATTEMPTS },
      // Never before its backoff window elapses; null = never attempted.
      OR: [{ translationNextRetryAt: null }, { translationNextRetryAt: { lte: new Date() } }],
    },
    orderBy: [{ translationNextRetryAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    take: limit,
    select: SELECT,
  });
}

export async function translateFeedItems(
  opts: { companyId: string; limit?: number; shouldStop?: () => boolean },
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

  const summary: TranslateFeedItemsSummary = { scanned: 0, translated: 0, failed: 0, skipped: 0 };

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

    summary.scanned += 1;
    const outcome: TranslateFeedItemOutcome = await translate(item, cfg.targetLanguage);

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
