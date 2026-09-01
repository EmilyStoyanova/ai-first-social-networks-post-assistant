/**
 * Competitive Intelligence extraction drain (Part 3B §13/§18). A global sweep
 * across every company's pending/failed `CompetitorIntelligence` rows —
 * mirrors `classify-feed-items.service.ts`'s shape: the drain LOADS candidates
 * (injectable, so this file's own batching/counting logic is testable without
 * a database) and hands each one, already loaded, to the per-item processor
 * (`extractCompetitorIntelligence`) — mirroring how `classifyFeedItems` hands
 * an already-loaded `ClassifiableItem` to `classifyFeedItem`.
 *
 * Archived-competitor safety (§14) is enforced at TWO points, independently:
 *   1. here, at SELECTION — `defaultFindCandidates`'s query excludes a
 *      competitor archived at the time this batch is drawn;
 *   2. inside `extractCompetitorIntelligence`, at EXECUTION — a FRESH
 *      re-check immediately before the model call, covering a competitor
 *      archived WHILE this run's batch is still being processed (the case
 *      selection alone cannot catch).
 */

import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db/client";
import {
  extractCompetitorIntelligence,
  type ExtractableIntelligenceItem,
  type ExtractCompetitorIntelligenceDeps,
} from "./extract-competitor-intelligence.service";
import {
  EXTRACTION_BATCH_SIZE,
  MAX_EXTRACTION_ATTEMPTS,
} from "@/lib/ai/competitor-intelligence-extraction";

// A `type`, not `interface` — see the identical note on
// `RecomputeStaleRelevanceSummary`; this shape is returned directly as a
// job's `result`.
export type CompetitorIntelligenceExtractionSummary = {
  runId: string;
  processed: number;
  extracted: number;
  failed: number;
  skipped: number;
  /** Rows still claimable after this run — drives the handler's continuation
   *  enqueue, exactly as `RssClassificationDiagnostics.remaining` does. */
  remaining: number;
  durationMs: number;
};

/**
 * Rows a run should select right now: pending/failed under the attempt cap,
 * OR a crashed run's `analyzing` claim whose lease has expired (recovery) —
 * belonging to a non-archived competitor. Mirrors
 * `classificationSelectableWhere` exactly, and for the same reason.
 *
 * Verification-pass fix (§7): an earlier version of this query matched only
 * `status: { in: ["pending", "failed"] }`, entirely excluding `analyzing`.
 * Its own doc comment claimed a crashed run's expired lease would be
 * "reclaimed the next time this same selection picks the row up again" — but
 * a row stuck at `analyzing` never transitions to `pending`/`failed` on its
 * own, so it could NEVER match that query again, regardless of how long its
 * lease had been expired. `extractCompetitorIntelligence`'s own claim query
 * DOES already handle the lease-reclaim case correctly — but that logic is
 * unreachable if this drain never selects the row for it in the first place.
 * The OR below is what actually closes the gap; a LIVE (non-expired) claim is
 * still excluded, so a row a concurrent run currently holds is never handed
 * out to two batches at once.
 */
export function selectableWhere(now: Date = new Date()): Record<string, unknown> {
  return {
    attemptCount: { lt: MAX_EXTRACTION_ATTEMPTS },
    competitor: { archivedAt: null },
    OR: [
      { status: { in: ["pending", "failed"] } },
      { status: "analyzing", leaseExpiresAt: { lt: now } },
    ],
  };
}

const CANDIDATE_SELECT = {
  id: true,
  competitorId: true,
  status: true,
  attemptCount: true,
  feedItem: { select: { title: true, content: true } },
  manualEntry: { select: { content: true } },
} as const;

async function defaultFindCandidates(limit: number): Promise<ExtractableIntelligenceItem[]> {
  return prisma.competitorIntelligence.findMany({
    where: selectableWhere(),
    orderBy: { createdAt: "asc" },
    take: limit,
    select: CANDIDATE_SELECT,
  });
}

export interface RunCompetitorIntelligenceExtractionDeps {
  findCandidates?: (limit: number) => Promise<ExtractableIntelligenceItem[]>;
  countRemaining?: () => Promise<number>;
  extract?: (
    item: ExtractableIntelligenceItem,
    deps?: ExtractCompetitorIntelligenceDeps
  ) => ReturnType<typeof extractCompetitorIntelligence>;
}

async function defaultCountRemaining(): Promise<number> {
  return prisma.competitorIntelligence.count({ where: selectableWhere() });
}

export async function runCompetitorIntelligenceExtraction(
  deps: RunCompetitorIntelligenceExtractionDeps = {}
): Promise<CompetitorIntelligenceExtractionSummary> {
  const findCandidates = deps.findCandidates ?? defaultFindCandidates;
  const countRemaining = deps.countRemaining ?? defaultCountRemaining;
  const extract = deps.extract ?? extractCompetitorIntelligence;

  const runId = randomUUID();
  const startedAt = Date.now();

  const claimable = await findCandidates(EXTRACTION_BATCH_SIZE);

  let extracted = 0;
  let failed = 0;
  let skipped = 0;

  for (const item of claimable) {
    const outcome = await extract(item);
    if (outcome.status === "extracted") extracted++;
    else if (outcome.status === "failed") failed++;
    else skipped++;
  }

  const remaining = await countRemaining();

  return {
    runId,
    processed: claimable.length,
    extracted,
    failed,
    skipped,
    remaining,
    durationMs: Date.now() - startedAt,
  };
}
