/**
 * Stale-relevance recovery sweep (2026-09 relevance-recovery fix).
 *
 * ── The gap this closes ──────────────────────────────────────────────────
 * After the relevance auto-enqueue fix, exactly three code paths could ever
 * create a `competitor-relevance` job:
 *
 *   1. `update-research-profile.service.ts` — a Research Profile Save that
 *      bumps `profileVersion`.
 *   2. `run-competitor-intelligence-extraction.service.ts` — a drain run in
 *      which at least one row FRESHLY reached `status: "completed"`.
 *   3. `competitor-relevance-handler.ts`'s self-continuation — which can only
 *      run from inside a relevance job that already exists.
 *
 * None of the three fires for a row that finished extracting BEFORE (2) was
 * written. That is not a hypothetical: the 10 real rows this whole fix began
 * with are exactly that shape — `status: "completed"`, `relevance: pending`,
 * `relevanceProfileVersion: null`, against a profile saved hours earlier.
 * They match `staleWhere` perfectly, so the drain WOULD process them; nothing
 * ever asks it to. Deploying the auto-enqueue fix alone leaves them stuck
 * until a coincidental future extraction of unrelated new content happens to
 * name their company — or until the user performs a Research Profile edit
 * they have no real reason to make. Neither is "picked up automatically".
 *
 * ── The mechanism ────────────────────────────────────────────────────────
 * A single bounded sweep, run once at worker start (see `worker/src/index.ts`,
 * which calls this as a thin adapter — the worker stays orchestrator-only and
 * holds none of the logic below). It asks, for each company that has a
 * PERSISTED Research Profile, whether the relevance drain would find anything
 * to do — using `staleWhere` VERBATIM, so the recovery predicate can never
 * drift from the drain's own selection — and if so enqueues one bounded,
 * company-level relevance job under the existing
 * `competitorRelevanceDedupeKey`.
 *
 * Deliberately NOT a poll. The worker is designed to go dormant and stop
 * touching the database entirely (see `worker/src/runner.ts`); a recurring
 * stale-relevance query would defeat exactly the cost property dormancy
 * exists for. Worker start is the right moment instead: it is the one point
 * where the process is already connected, already reaping stale leases, and
 * already about to claim — a sweep here costs a handful of indexed reads once
 * per process lifetime, and it doubles as the self-healing path for a
 * relevance enqueue that was ever lost (a crashed drain between committing an
 * extraction and reaching its enqueue, a queue insert that failed and was
 * swallowed best-effort).
 *
 * ── Why it cannot run away ───────────────────────────────────────────────
 *   • One job PER COMPANY, never per article — the relevance drain is itself
 *     already a bounded, self-continuing, per-company sweep.
 *   • The dedupe key collapses this into any relevance job already queued or
 *     active for that company, so repeated restarts while one is pending add
 *     nothing.
 *   • A restart AFTER a job completed re-enqueues only if rows are still
 *     genuinely stale — and a row that keeps failing is bounded independently
 *     by `MAX_RELEVANCE_ATTEMPTS`, which settles it out of `staleWhere`
 *     entirely (see `recompute-stale-relevance.service.ts`). So restart count
 *     does not multiply work; stale-row count does, and that is finite and
 *     shrinking.
 *   • `RELEVANCE_RECOVERY_MAX_COMPANIES` caps the sweep itself, so even a
 *     pathological number of companies cannot turn worker boot into a long
 *     job-insert storm.
 *   • Best-effort throughout: this must never prevent a worker from starting.
 */

import { prisma } from "@/lib/db/client";
import { enqueueJob, type EnqueueJobResult } from "@/lib/services/queue/enqueue-job.service";
import { COMPETITOR_RELEVANCE_JOB_TYPE, competitorRelevanceDedupeKey } from "@/lib/queue/job-types";
import { staleWhere } from "./recompute-stale-relevance.service";

/**
 * Companies examined per sweep. A bound on the sweep, not on recovery: the
 * cap is far above any realistic count of companies that have configured a
 * Research Profile, and anything beyond it is picked up by the next worker
 * start or by the ordinary post-extraction enqueue.
 */
export const RELEVANCE_RECOVERY_MAX_COMPANIES = 200;

// A `type`, not `interface` — logged directly as structured worker
// diagnostics, matching the other summaries in this directory.
export type StaleRelevanceRecoverySummary = {
  /** Companies with a PERSISTED Research Profile that this sweep looked at. */
  companiesExamined: number;
  /** Of those, the ones the relevance drain would currently find work for. */
  companiesWithStaleRows: number;
  /** Relevance jobs actually inserted. */
  enqueued: number;
  /** Qualifying companies whose enqueue collapsed into an already-queued or
   *  active relevance job — the idempotent path, not a failure. */
  deduplicated: number;
  /** Enqueues that threw. Swallowed; the next worker start retries. */
  failed: number;
  /** Company ids the sweep enqueued (or deduped) for — observability and
   *  tests. Never article ids, never content. */
  companyIds: string[];
  /** True when more companies have a persisted profile than the cap allows,
   *  so this sweep did not examine all of them. */
  truncated: boolean;
  durationMs: number;
};

/** Only PERSISTED profiles qualify. A lazily-computed default (see
 *  `get-research-profile-or-defaults.service.ts`) has no `profileVersion` to
 *  stamp rows with, and `recomputeStaleRelevanceForCompany` refuses to run
 *  without a row — enqueueing for one would create a job guaranteed to be a
 *  no-op. */
export interface RecoverableProfile {
  companyId: string;
  profileVersion: number;
}

export interface EnqueueStaleRelevanceRecoveryDeps {
  listProfiles?: (limit: number) => Promise<RecoverableProfile[]>;
  hasStaleRows?: (companyId: string, version: number) => Promise<boolean>;
  enqueueRelevance?: (companyId: string) => Promise<EnqueueJobResult>;
}

async function defaultListProfiles(limit: number): Promise<RecoverableProfile[]> {
  return prisma.competitorResearchProfile.findMany({
    orderBy: { createdAt: "asc" },
    take: limit + 1, // one extra, purely to detect truncation
    select: { companyId: true, profileVersion: true },
  });
}

/**
 * Uses `staleWhere` verbatim — the SAME predicate
 * `recomputeStaleRelevanceForCompany` selects with, including its
 * `status: "completed"` requirement and its `competitor: { archivedAt: null }`
 * exclusion. `findFirst` rather than `count`: the sweep only needs to know
 * whether the drain would find anything, and existence stops at the first
 * matching row instead of scanning every one.
 */
async function defaultHasStaleRows(companyId: string, version: number): Promise<boolean> {
  const row = await prisma.competitorIntelligence.findFirst({
    where: staleWhere(companyId, version),
    select: { id: true },
  });
  return row !== null;
}

/** Identical shape to the post-extraction enqueue in
 *  `run-competitor-intelligence-extraction.service.ts` — same type, same
 *  payload, same dedupe key — so a job created by recovery and a job created
 *  by a fresh extraction are indistinguishable to the handler, and collide
 *  with each other exactly as they should. */
async function defaultEnqueueRelevance(companyId: string): Promise<EnqueueJobResult> {
  return enqueueJob({
    type: COMPETITOR_RELEVANCE_JOB_TYPE,
    payload: { companyId },
    dedupeKey: competitorRelevanceDedupeKey(companyId),
    companyId,
  });
}

export async function enqueueStaleRelevanceRecovery(
  deps: EnqueueStaleRelevanceRecoveryDeps = {}
): Promise<StaleRelevanceRecoverySummary> {
  const listProfiles = deps.listProfiles ?? defaultListProfiles;
  const hasStaleRows = deps.hasStaleRows ?? defaultHasStaleRows;
  const enqueueRelevance = deps.enqueueRelevance ?? defaultEnqueueRelevance;

  const startedAt = Date.now();

  const fetched = await listProfiles(RELEVANCE_RECOVERY_MAX_COMPANIES);
  const truncated = fetched.length > RELEVANCE_RECOVERY_MAX_COMPANIES;
  const profiles = truncated ? fetched.slice(0, RELEVANCE_RECOVERY_MAX_COMPANIES) : fetched;

  let companiesWithStaleRows = 0;
  let enqueued = 0;
  let deduplicated = 0;
  let failed = 0;
  const companyIds: string[] = [];

  // Sequential on purpose. This runs at boot alongside lease recovery, and a
  // parallel fan-out would hand the database a burst of concurrent queries at
  // precisely the moment the connection has just been (re)opened, for work
  // whose latency nobody is waiting on.
  for (const profile of profiles) {
    // Cross-company isolation is structural: every query below is scoped by
    // this one companyId, and the job carries only this companyId.
    if (!(await hasStaleRows(profile.companyId, profile.profileVersion))) continue;

    companiesWithStaleRows++;
    try {
      const result = await enqueueRelevance(profile.companyId);
      if (result.enqueued) enqueued++;
      if (result.deduplicated) deduplicated++;
      companyIds.push(profile.companyId);
    } catch (err) {
      // Never fatal: a worker must start even if the queue insert fails, and
      // the next start (or the ordinary post-extraction enqueue) retries.
      failed++;
      console.error(
        "[competitor-relevance-recovery] enqueue failed (ignored):",
        profile.companyId,
        err
      );
    }
  }

  return {
    companiesExamined: profiles.length,
    companiesWithStaleRows,
    enqueued,
    deduplicated,
    failed,
    companyIds,
    truncated,
    durationMs: Date.now() - startedAt,
  };
}
