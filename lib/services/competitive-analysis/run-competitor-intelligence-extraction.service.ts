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
 *
 * ── 2026-09 production livelock fix ──────────────────────────────────────
 * The worker hot-looped on `remaining: 10` forever — root cause was in
 * `extractCompetitorIntelligence` (see that file's module comment), but this
 * drain gained an independent, root-cause-agnostic safety net so an
 * analogous bug anywhere in the per-item processor can never reproduce the
 * same symptom again:
 *
 *   1. `remaining` is now two numbers, `remainingReady` and
 *      `remainingDeferred` — see `readyWhere`/`deferredWhere` below.
 *      `remainingReady` uses the EXACT SAME predicate as `selectableWhere`,
 *      so "ready" always means "the next run's `findCandidates` will select
 *      it", never a broader, misleading count. `remainingDeferred` is rows
 *      under an active (non-expired) lease held by another run — genuinely
 *      not processable yet, and NOT a reason to hot-loop; they surface again
 *      once that lease expires or the other run finishes.
 *   2. `progressed` is true only if at least one processed item's persistent
 *      state actually moved this run (extracted, a real model failure, or a
 *      terminal skip that consumed attempt budget) — NOT true for a
 *      contended claim, a no-provider skip, or a max-attempts skip, none of
 *      which change anything a future run could act on differently.
 *
 * The worker handler (`competitor-intelligence-extraction-handler.ts`) uses
 * both: it only self-enqueues a continuation when `remainingReady > 0 &&
 * progressed`. A batch that makes zero progress — regardless of why — stops
 * hot-looping and lets the normal cron/job-wake cadence pick the drain back
 * up instead.
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
  /** Per-item skip reason, from `ExtractCompetitorIntelligenceOutcome`'s
   *  `reason` (plus a synthetic `no_provider` bucket for that separate
   *  outcome status) — see the module comment's 2026-09 fix. Only keys that
   *  actually occurred this run are present; never logs article/entry
   *  content, only counts. */
  skippedByReason: Record<string, number>;
  /** True iff at least one processed item's persistent DB state actually
   *  moved this run (extracted, a real failure, or a terminal skip that
   *  consumed attempt budget) — see the module comment. Drives the handler's
   *  no-progress continuation guard. */
  progressed: boolean;
  /** Rows selectable RIGHT NOW by the exact predicate `findCandidates` uses —
   *  what the next run would actually pick up. See the module comment for
   *  why this replaced a single, misleading `remaining` count. */
  remainingReady: number;
  /** Rows with attempt budget left, belonging to a non-archived competitor,
   *  but currently held under another run's still-active lease — not
   *  immediately processable; not a reason to self-enqueue a continuation. */
  remainingDeferred: number;
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

/** "Ready" is exactly `selectableWhere` — an explicit alias so
 *  `remainingReady`'s intent (same predicate as the candidate selector) is
 *  visible at the call site, not just true by coincidence. */
export const readyWhere = selectableWhere;

/** Rows with attempt budget left, belonging to a non-archived competitor,
 *  under an ACTIVE (non-expired) lease held by another run. Deliberately the
 *  logical complement of the `analyzing` half of `selectableWhere`'s OR —
 *  these are exactly the rows that predicate excludes for being currently
 *  in flight elsewhere, not for any other reason. */
export function deferredWhere(now: Date = new Date()): Record<string, unknown> {
  return {
    attemptCount: { lt: MAX_EXTRACTION_ATTEMPTS },
    competitor: { archivedAt: null },
    status: "analyzing",
    leaseExpiresAt: { gte: now },
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

export interface RemainingCounts {
  ready: number;
  deferred: number;
}

export interface RunCompetitorIntelligenceExtractionDeps {
  findCandidates?: (limit: number) => Promise<ExtractableIntelligenceItem[]>;
  countRemaining?: () => Promise<RemainingCounts>;
  extract?: (
    item: ExtractableIntelligenceItem,
    deps?: ExtractCompetitorIntelligenceDeps
  ) => ReturnType<typeof extractCompetitorIntelligence>;
}

async function defaultCountRemaining(): Promise<RemainingCounts> {
  const now = new Date();
  const [ready, deferred] = await Promise.all([
    prisma.competitorIntelligence.count({ where: readyWhere(now) }),
    prisma.competitorIntelligence.count({ where: deferredWhere(now) }),
  ]);
  return { ready, deferred };
}

/** Skip reasons that represent genuine forward progress — the row's
 *  persistent state (attemptCount and/or status) actually moved this call,
 *  so a future run's outcome for it can differ. `claimed` (another run owns
 *  it right now) and `max_attempts` (nothing was written; the row shouldn't
 *  normally even reach here — defensive branch only) never move anything. */
const PROGRESS_SKIP_REASONS = new Set([
  "archived",
  "missing_origin",
  "missing_content",
  // 2026-09 content-acquisition fix — a below-threshold RSS fallback also
  // writes `status: "failed"` and consumes attempt budget via the same
  // lease-guarded path as `missing_content`, so it is just as much genuine
  // progress; see extract-competitor-intelligence.service.ts's module
  // comment.
  "content_too_short",
]);

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
  let progressed = false;
  const skippedByReason: Record<string, number> = {};

  for (const item of claimable) {
    const outcome = await extract(item);
    if (outcome.status === "extracted") {
      extracted++;
      progressed = true;
    } else if (outcome.status === "failed") {
      failed++;
      progressed = true;
    } else {
      skipped++;
      // "no_provider" carries no `reason` field of its own (it's a distinct
      // top-level `status`, not a `{status:"skipped"}` variant) — bucketed
      // here under a synthetic key so it still shows up in `skippedByReason`
      // rather than silently vanishing into the bare `skipped` total.
      const reason = outcome.status === "no_provider" ? "no_provider" : outcome.reason;
      skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1;
      if (PROGRESS_SKIP_REASONS.has(reason)) progressed = true;
    }
  }

  const remaining = await countRemaining();

  return {
    runId,
    processed: claimable.length,
    extracted,
    failed,
    skipped,
    skippedByReason,
    progressed,
    remainingReady: remaining.ready,
    remainingDeferred: remaining.deferred,
    durationMs: Date.now() - startedAt,
  };
}
