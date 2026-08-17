import { prisma } from "@/lib/db/client";
import {
  classificationSelectableWhere,
  CLASSIFICATION_BATCH_SIZE,
  CLASSIFICATION_ITEM_TIMEOUT_MS,
  MIN_CLASSIFICATION_ITEM_BUDGET_MS,
} from "@/lib/ai/feed-item-classification";
import { resolveTopicPriorities, hasTopicPriorities } from "@/lib/ai/topic-priorities";
import type { TopicPriorities } from "@/lib/ai/topic-priorities";
import {
  classifyFeedItem,
  type ClassifiableItem,
  type ClassifyFeedItemOutcome,
} from "@/lib/services/ai/classify-feed-item.service";

/**
 * Classifies one company's queue of eligible articles.
 *
 * Runs AFTER translation and before generation. That ordering is the whole reason
 * this is a step of its own rather than part of ingestion: the topics are
 * configured in the company's own language, and for a foreign-language feed it is
 * the TRANSLATED text that has to be judged. Classifying at ingestion would
 * compare Bulgarian topics against English articles and then need re-running the
 * moment the translation landed.
 *
 * Bounded per run; the backlog drains across runs. Individual failures are
 * recorded by the classification service and never thrown, so one bad article
 * cannot stall the run.
 */

export interface ClassifyFeedItemsSummary {
  scanned: number;
  classified: number;
  failed: number;
  skipped: number;
  /** Set when the batch stopped early because no default provider is configured. */
  reason?: "no_provider";
}

export interface ClassifyFeedItemsDeps {
  findCandidates?: (companyId: string, limit: number) => Promise<ClassifiableItem[]>;
  loadPriorities?: (companyId: string) => Promise<TopicPriorities>;
  classify?: typeof classifyFeedItem;
}

const SELECT = {
  id: true,
  title: true,
  content: true,
  url: true,
  translatedTitle: true,
  translatedContent: true,
  translationStatus: true,
  classificationStatus: true,
  classificationHash: true,
  classificationAttemptCount: true,
} as const;

/**
 * Eligible = an unconsumed article from an enabled source whose classification is
 * due, and whose translation has SETTLED.
 *
 * Two filters carry weight:
 *
 *   • `usedInPost: false` — the same filter generation uses to find candidates,
 *     so "still worth classifying" and "still a candidate" are one definition
 *     rather than two that can drift. An article already written from is history;
 *     re-judging it would rewrite the record of a decision that was made under the
 *     configuration in force at the time.
 *
 *   • the translation gate — an item still `pending`/`translating` is about to
 *     change which text it reads, so classifying it now would spend a model call
 *     on text that is superseded minutes later. `null` passes because it means
 *     translation does not apply to this source at all.
 */
export function classificationEligibleWhere(now: Date): Record<string, unknown> {
  return {
    AND: [
      {
        usedInPost: false,
        source: { enabled: true, type: "rss" },
        // The translation gate as its own clause: two sibling `OR` keys cannot
        // share one filter object, so this one and the eligibility one below are
        // combined under AND rather than merged.
        OR: [
          { translationStatus: null },
          { translationStatus: { in: ["completed", "skipped", "failed"] } },
        ],
      },
      classificationSelectableWhere(now),
    ],
  };
}

async function defaultFindCandidates(
  companyId: string,
  limit: number
): Promise<ClassifiableItem[]> {
  return prisma.feedItem.findMany({
    where: { companyId, ...classificationEligibleWhere(new Date()) },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: SELECT,
  });
}

async function defaultLoadPriorities(companyId: string): Promise<TopicPriorities> {
  const brand = await prisma.brandGuidelines.findUnique({
    where: { companyId },
    select: { topPriorityTopics: true, mediumPriorityTopics: true, avoidedTopics: true },
  });
  return resolveTopicPriorities(brand);
}

export interface ClassifyFeedItemsOptions {
  companyId: string;
  limit?: number;
  shouldStop?: () => boolean;
  /**
   * Milliseconds the RUN has left. Omitted, each item keeps its full budget.
   * Supplied, an item's own timeout is squeezed to what is actually left, so an
   * item started just inside the budget cannot carry the run past the route cap —
   * the same arithmetic translation documents.
   */
  remainingMs?: () => number;
}

export async function classifyFeedItems(
  opts: ClassifyFeedItemsOptions,
  deps: ClassifyFeedItemsDeps = {}
): Promise<ClassifyFeedItemsSummary> {
  const limit = opts.limit ?? CLASSIFICATION_BATCH_SIZE;
  const findCandidates = deps.findCandidates ?? defaultFindCandidates;
  const loadPriorities = deps.loadPriorities ?? defaultLoadPriorities;
  const classify = deps.classify ?? classifyFeedItem;

  const summary: ClassifyFeedItemsSummary = { scanned: 0, classified: 0, failed: 0, skipped: 0 };

  const candidates = await findCandidates(opts.companyId, limit);
  if (candidates.length === 0) return summary;

  const priorities = await loadPriorities(opts.companyId);
  const configured = hasTopicPriorities(priorities);

  for (const item of candidates) {
    if (opts.shouldStop?.()) break;

    // An unconfigured company costs one settling write per item and no model
    // call, so the budget check is skipped for it — stopping early would leave
    // rows pending that nothing can advance until the next run.
    if (configured) {
      const remaining = opts.remainingMs?.();
      if (remaining !== undefined && remaining <= MIN_CLASSIFICATION_ITEM_BUDGET_MS) break;

      summary.scanned += 1;
      const outcome = await run(item, remaining);
      tally(outcome);
      if (summary.reason === "no_provider") break;
      continue;
    }

    summary.scanned += 1;
    tally(await classify(item, priorities));
  }

  return summary;

  function run(item: ClassifiableItem, remaining: number | undefined) {
    return classify(
      item,
      priorities,
      remaining === undefined
        ? undefined
        : { itemTimeoutMs: Math.min(CLASSIFICATION_ITEM_TIMEOUT_MS, remaining) }
    );
  }

  function tally(outcome: ClassifyFeedItemOutcome): void {
    if (outcome.status === "classified") summary.classified += 1;
    else if (outcome.status === "failed") summary.failed += 1;
    else if (outcome.status === "no_provider") {
      // Nothing in this run can succeed — stop instead of burning the batch.
      summary.reason = "no_provider";
    } else summary.skipped += 1;
  }
}
