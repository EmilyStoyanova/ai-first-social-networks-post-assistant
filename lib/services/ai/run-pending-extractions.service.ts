/**
 * Drains the product-page extraction queue.
 *
 * The whole reason this is a queued drain rather than a call inside the ingest
 * request: one extraction is a large-context model call against whatever provider
 * the admin default names — measured in tens of seconds against a self-hosted
 * worker — and the "Extract" button is an HTTP request under a platform function
 * cap. Doing it inline would make the visible outcome of a click depend on how
 * long a model took, and a cap hit halfway through would leave the item claimed
 * with nothing written.
 *
 * So ingestion records that there is work (see extractionFieldsFor) and this
 * drains it. Bounded per run, failure-isolated per item: a page that cannot be
 * extracted must not stop the next one.
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { EXTRACTION_BATCH_SIZE, MAX_EXTRACTION_ATTEMPTS } from "@/lib/ai/product-page-extraction";
import {
  extractProductPage,
  type ExtractableItem,
  type ExtractProductPageOutcome,
} from "./extract-product-page.service";

export interface PendingExtractionsSummary {
  /** Items this run attempted. */
  examined: number;
  extracted: number;
  /** Ran successfully, and the page did not contain what was asked for. */
  notFound: number;
  failed: number;
  skipped: number;
  /** Still eligible after this run — the continuation signal. */
  remaining: number;
  durationMs: number;
}

export interface RunPendingExtractionsDeps {
  /** Selects eligible items. Injected in tests; production reads Prisma. */
  selectPending?: (limit: number) => Promise<ExtractableItem[]>;
  countPending?: () => Promise<number>;
  extract?: (item: ExtractableItem) => Promise<ExtractProductPageOutcome>;
  batchSize?: number;
  now?: () => Date;
}

/**
 * Eligible = pending, or failed with attempts left.
 *
 * `extracting` is deliberately excluded: it means a run holds the item. There is
 * no lease to expire here (unlike translation) because an extraction is claimed
 * only by a worker job, and a crashed worker's job is requeued by the queue's own
 * reaper — which re-enters this drain and finds the row still `extracting`. That
 * is a stuck item rather than a lost one, and re-ingesting the source resets it
 * to `pending`. The simpler state machine is worth that trade for a step that
 * runs once per source rather than once per article.
 */
const ELIGIBLE: Prisma.FeedItemWhereInput = {
  extractionStatus: { in: ["pending", "failed"] },
  // Load-bearing, not just an optimisation: an item whose budget is spent is
  // skipped by the extractor, so counting it as "remaining" would make every run
  // chain another continuation that changes nothing, forever. A changed page or
  // instruction resets the count and brings it back (see extractionFieldsFor).
  extractionAttemptCount: { lt: MAX_EXTRACTION_ATTEMPTS },
};

function defaultSelectPending(limit: number): Promise<ExtractableItem[]> {
  return prisma.feedItem.findMany({
    where: ELIGIBLE,
    orderBy: { createdAt: "asc" },
    take: limit,
    select: {
      id: true,
      title: true,
      content: true,
      url: true,
      extractionStatus: true,
      extractionHash: true,
      extractionAttemptCount: true,
    },
  });
}

function defaultCountPending(): Promise<number> {
  return prisma.feedItem.count({ where: ELIGIBLE });
}

export async function runPendingExtractions(
  deps: RunPendingExtractionsDeps = {}
): Promise<PendingExtractionsSummary> {
  const selectPending = deps.selectPending ?? defaultSelectPending;
  const countPending = deps.countPending ?? defaultCountPending;
  const extract = deps.extract ?? ((item: ExtractableItem) => extractProductPage(item));
  const batchSize = deps.batchSize ?? EXTRACTION_BATCH_SIZE;
  const now = deps.now ?? (() => new Date());

  const startedMs = now().getTime();
  const items = await selectPending(batchSize);

  let extracted = 0;
  let notFound = 0;
  let failed = 0;
  let skipped = 0;

  for (const item of items) {
    // Failure-isolated: extractProductPage records its own failures and does not
    // throw, but an unexpected fault (the database going away mid-write) must
    // still not abandon the items behind it.
    let outcome: ExtractProductPageOutcome;
    try {
      outcome = await extract(item);
    } catch (err) {
      console.error("[product-page-extraction] item threw — continuing with the rest", {
        feedItemId: item.id,
        error: err instanceof Error ? err.message : String(err),
      });
      failed += 1;
      continue;
    }

    switch (outcome.status) {
      case "extracted":
        extracted += 1;
        break;
      case "not_found":
        notFound += 1;
        break;
      case "failed":
        failed += 1;
        break;
      // A missing provider is an operator problem and leaves every remaining
      // item exactly as it was — there is no point asking the next one.
      case "no_provider":
        skipped += items.length - items.indexOf(item);
        return {
          examined: items.length,
          extracted,
          notFound,
          failed,
          skipped,
          remaining: await countPending(),
          durationMs: now().getTime() - startedMs,
        };
      default:
        skipped += 1;
    }
  }

  return {
    examined: items.length,
    extracted,
    notFound,
    failed,
    skipped,
    remaining: await countPending(),
    durationMs: now().getTime() - startedMs,
  };
}
