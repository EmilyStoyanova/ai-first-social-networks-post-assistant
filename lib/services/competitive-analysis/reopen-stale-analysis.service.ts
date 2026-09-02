/**
 * Stale-analysis recovery sweep (2026-09-02).
 *
 * ── The gap this closes ──────────────────────────────────────────────────
 * The mixed-language fix made extraction write free-form analysis in the
 * company's own language and bumped `EXTRACTION_SEMANTIC_VERSION` to 2. Every
 * row analyzed AFTER it is correct. Every row analyzed before it still holds
 * English `topic`/`subtopic`/`summary`/`tone`, and nothing in the pipeline can
 * ever revisit them: the drain's `selectableWhere` matches pending/failed/
 * lease-expired rows only, so `completed` is terminal by construction. Without
 * this sweep the Bulgarian UI stays half-English until every one of those rows
 * is replaced by unrelated new content — which for a competitor that stops
 * publishing is never.
 *
 * ── The mechanism ────────────────────────────────────────────────────────
 * One bounded sweep at worker start, sitting beside the stale-RELEVANCE
 * recovery it is modelled on (`enqueue-stale-relevance-recovery.service.ts`)
 * and running just before it. Company by company, it recomputes each completed
 * row's extraction hash from that row's OWN stored content plus that company's
 * OWN `CompetitorResearchProfile.analysisLanguage`, and re-opens only the rows
 * whose stored `analysisHash` disagrees. The decision itself is not made here
 * — it is `analysisStaleness`, a pure function the extractor shares the input
 * derivation with, so the sweep cannot drift from the thing it is checking.
 *
 * ── 2026-09-02 ownership-boundary fix ────────────────────────────────────
 * The analysis language anchor moved from `Company.defaultLang` to
 * `CompetitorResearchProfile.analysisLanguage` — Competitive Analysis's own
 * setting, so a company can use this module without ever configuring Brand. A
 * company with completed intelligence but NO saved Research Profile (fully
 * possible: extraction never required one) has no `analysisLanguage` to read
 * at all, and gets the same safe application default (English) any other
 * unrecognized value normalizes to — never a reach into `Company.defaultLang`.
 * `reopenStaleAnalysisForCompany`, below, is also the SAME bounded per-company
 * mechanism a Research Profile Save now triggers directly (see
 * `triggerStaleAnalysisRecoveryForCompany` and `update-research-profile.
 * service.ts`) — a language change no longer has to wait for a worker
 * restart to start healing.
 *
 * Re-opening is four fields: `status → "pending"`, `attemptCount → 0`,
 * `analysisError → null`, `leaseExpiresAt → null`. Nothing else is touched —
 * not the origin references, not `companyId`/`competitorId`, and above all not
 * the competitor's original title or body, which this sweep only ever READS.
 * The existing drain then does the rest, exactly as it would for a newly
 * ingested item.
 *
 * ── Why it cannot run away ───────────────────────────────────────────────
 *   • The write is `status: "completed"` AND `analysisHash: <the exact value
 *     just read>` — optimistic concurrency. An `analyzing` row is excluded
 *     twice over (never selected, and rejected by the guard), and a row
 *     another process re-analyzed between the read and the write no-ops
 *     instead of being clobbered.
 *   • Idempotent by the hash itself: a re-analyzed row stores the CURRENT
 *     hash, so the next sweep computes the same value, finds `current`, and
 *     does nothing. Restart count does not multiply work — stale-row count
 *     does, and that number only ever shrinks.
 *   • A row that keeps failing leaves `completed` for `failed`, and this
 *     sweep only ever looks at `completed` — so a row cannot be re-opened,
 *     fail, and be re-opened again. `MAX_EXTRACTION_ATTEMPTS` bounds it
 *     independently on the drain's side.
 *   • ONE extraction job per sweep, never one per row — the drain is already
 *     a bounded, self-continuing, global sweep, and it carries the existing
 *     global dedupe key, so a restart while a drain is queued or active adds
 *     nothing at all.
 *   • Three caps bound the sweep itself: companies examined, rows inspected
 *     per company, and rows re-opened per sweep. Whatever a cap defers is
 *     picked up by the next worker start, and because re-opened rows leave
 *     `completed`, each sweep resumes where the last one stopped rather than
 *     re-treading it.
 *   • Best-effort throughout: a worker must start regardless.
 *
 * Deliberately NOT a poll and NOT part of the drain. The worker goes fully
 * dormant and stops touching the database (see `worker/src/runner.ts`); a
 * recurring staleness scan would defeat exactly that. And folding it into the
 * drain would re-scan every completed row on every self-continuation, which is
 * both wasteful and a hot-loop shape. Worker start is the one moment the
 * process is already connected, already reaping leases, and about to claim —
 * and it makes a plain restart sufficient to heal old analysis, with no RSS
 * re-ingestion, no Research Profile edit, and no manual database change.
 */

import { prisma } from "@/lib/db/client";
import { enqueueJob, type EnqueueJobResult } from "@/lib/services/queue/enqueue-job.service";
import {
  COMPETITOR_INTELLIGENCE_EXTRACTION_JOB_TYPE,
  COMPETITOR_INTELLIGENCE_EXTRACTION_DEDUPE_KEY,
} from "@/lib/queue/job-types";
import { resolveAnalysisLanguage, type AnalysisLanguage } from "@/lib/i18n/analysis-language";
import {
  analysisStaleness,
  isStaleAnalysis,
  type AnalysisStaleness,
  type StaleAnalysisCandidate,
} from "./analysis-staleness";

/** Companies examined per sweep — same bound, and same reasoning, as
 *  `RELEVANCE_RECOVERY_MAX_COMPANIES`. */
export const ANALYSIS_RECOVERY_MAX_COMPANIES = 200;

/** Completed rows read per query. Each one carries an article body, so this is
 *  paged rather than fetched whole — a company with thousands of analyzed
 *  items must not materialize all of them at boot. */
export const ANALYSIS_RECOVERY_PAGE_SIZE = 50;

/** Completed rows inspected per company per sweep. Inspection is cheap
 *  (a hash, no model call); this exists so one enormous company cannot make
 *  worker boot slow for everyone else. */
export const ANALYSIS_RECOVERY_MAX_INSPECTED_PER_COMPANY = 1000;

/**
 * Rows re-opened per sweep — the cap that actually bounds SPEND, since each
 * re-opened row costs exactly one extraction call (and contributes to one
 * per-company relevance run). Generous enough to heal a realistic backlog in
 * a single restart, low enough that a mistake cannot turn one boot into an
 * unbounded bill.
 */
export const ANALYSIS_RECOVERY_MAX_REOPENS_PER_SWEEP = 200;

// A `type`, not `interface` — logged directly as structured worker
// diagnostics, matching the other summaries in this directory.
export type StaleAnalysisRecoverySummary = {
  /** Companies with at least one completed intelligence row. */
  companiesExamined: number;
  /** Completed rows whose hash this sweep actually recomputed. */
  rowsInspected: number;
  /** Verdict tally across every inspected row — see `AnalysisStaleness`. Only
   *  counts, never content. */
  byStaleness: Record<AnalysisStaleness, number>;
  /** Rows genuinely flipped back to `pending` by this sweep. */
  reopened: number;
  /** Stale rows whose guarded write matched nothing — another process moved
   *  the row between the read and the write. Not a failure; not retried here. */
  raced: number;
  /** True when a cap stopped the sweep early, so more stale rows may remain
   *  for the next worker start. */
  truncated: boolean;
  /** Whether an extraction drain was requested, and whether it collapsed into
   *  one already queued or active. Never one job per row. */
  extractionEnqueued: boolean;
  extractionDeduplicated: boolean;
  /** Company ids the sweep re-opened at least one row for — observability and
   *  tests. Never article ids, never content. */
  companyIds: string[];
  durationMs: number;
};

export interface RecoverableAnalysisCompany {
  id: string;
  /** Raw `CompetitorResearchProfile.analysisLanguage` — `null` when this
   *  company has completed intelligence but has never saved a Research
   *  Profile (extraction does not require one). Normalized by this sweep,
   *  never trusted as an `AnalysisLanguage` — same treatment the extraction
   *  drain gives it, and the same safe-default outcome as an unrecognized
   *  value. */
  analysisLanguage: string | null;
}

export interface CompletedAnalysisRow extends StaleAnalysisCandidate {
  id: string;
}

export interface ReopenStaleAnalysisDeps {
  listCompanies?: (limit: number) => Promise<RecoverableAnalysisCompany[]>;
  listCompletedRows?: (
    companyId: string,
    afterId: string | null,
    take: number
  ) => Promise<CompletedAnalysisRow[]>;
  /** Guarded re-open. Returns true only if THIS call flipped the row. */
  reopenRow?: (id: string, expectedHash: string | null) => Promise<boolean>;
  enqueueExtraction?: () => Promise<EnqueueJobResult>;
}

/** Only companies that actually have analyzed competitor content. A company
 *  with none has nothing to recover and should not cost a query.
 *
 * Reads `analysisLanguage` through the company's OWN
 * `CompetitorResearchProfile` relation, not `Company.defaultLang` (2026-09-02
 * ownership-boundary fix) — a `null` relation (no saved profile) is a normal,
 * expected outcome, not an error, and is treated identically to any other
 * unrecognized value by `resolveAnalysisLanguage` at the call site. */
async function defaultListCompanies(limit: number): Promise<RecoverableAnalysisCompany[]> {
  const rows = await prisma.company.findMany({
    where: { competitorIntelligence: { some: { status: "completed" } } },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, competitorResearchProfile: { select: { analysisLanguage: true } } },
  });
  return rows.map((row) => ({
    id: row.id,
    analysisLanguage: row.competitorResearchProfile?.analysisLanguage ?? null,
  }));
}

/**
 * Cursor pagination on `id`, not `skip`/`take`. The sweep MUTATES rows out of
 * this very result set as it walks it, and an offset over a shrinking set
 * silently skips rows; a forward-only id cursor cannot, because every row it
 * has already re-opened sits behind the cursor.
 *
 * Archived competitors are excluded here, at selection — the same place the
 * extraction drain excludes them — so an archived competitor's history is
 * never re-analyzed. (The extractor's own fresh re-check remains the second
 * line of defence for a competitor archived mid-flight.)
 */
async function defaultListCompletedRows(
  companyId: string,
  afterId: string | null,
  take: number
): Promise<CompletedAnalysisRow[]> {
  return prisma.competitorIntelligence.findMany({
    where: {
      companyId,
      status: "completed",
      competitor: { archivedAt: null },
      ...(afterId ? { id: { gt: afterId } } : {}),
    },
    orderBy: { id: "asc" },
    take,
    select: {
      id: true,
      analysisHash: true,
      feedItem: { select: { title: true, content: true } },
      manualEntry: { select: { content: true } },
    },
  });
}

/**
 * The only write this sweep performs. Both `where` clauses matter: `status:
 * "completed"` means an `analyzing` row can never be stolen mid-analysis, and
 * `analysisHash` is an optimistic-concurrency check against the exact value
 * the staleness verdict was computed from — if anything re-analyzed this row
 * in between, that verdict is stale and this write correctly does nothing.
 *
 * `analysisHash` itself is deliberately left in place: it is the row's
 * provenance, the next successful extraction overwrites it anyway, and
 * clearing it would destroy the evidence of what the row was last analyzed as.
 */
async function defaultReopenRow(id: string, expectedHash: string | null): Promise<boolean> {
  const written = await prisma.competitorIntelligence.updateMany({
    where: { id, status: "completed", analysisHash: expectedHash },
    data: {
      status: "pending",
      attemptCount: 0,
      analysisError: null,
      leaseExpiresAt: null,
    },
  });
  return written.count > 0;
}

function emptyTally(): Record<AnalysisStaleness, number> {
  return { current: 0, stale_hash: 0, missing_hash: 0, unanalyzable: 0 };
}

/** Tally for ONE company's slice of the sweep — the piece
 *  `reopenStaleAnalysisForCompany` actually computes, shared by both the
 *  global boot sweep and a single-company, Save-triggered run. */
export interface CompanyStaleAnalysisRecoverySummary {
  rowsInspected: number;
  byStaleness: Record<AnalysisStaleness, number>;
  reopened: number;
  raced: number;
  /** True when EITHER this company's own inspected-rows cap, or the caller's
   *  `maxReopens` budget, stopped this call before every completed row was
   *  looked at. */
  truncated: boolean;
}

export interface ReopenStaleAnalysisForCompanyDeps {
  listCompletedRows?: (
    companyId: string,
    afterId: string | null,
    take: number
  ) => Promise<CompletedAnalysisRow[]>;
  reopenRow?: (id: string, expectedHash: string | null) => Promise<boolean>;
  /** Completed rows inspected before stopping — default
   *  `ANALYSIS_RECOVERY_MAX_INSPECTED_PER_COMPANY`, so a single very large
   *  company cannot make one call (boot-sweep slice, or an interactive Save)
   *  arbitrarily slow. */
  maxInspected?: number;
  /** Rows this call may re-open — the REMAINING global budget when called
   *  from the boot sweep (so the cap stays global across companies, not
   *  per-company), or the full `ANALYSIS_RECOVERY_MAX_REOPENS_PER_SWEEP` when
   *  called standalone for one company (`triggerStaleAnalysisRecoveryForCompany`). */
  maxReopens?: number;
}

/**
 * The bounded, hash-driven recovery sweep for ONE company — extracted so the
 * exact same mechanism backs both the worker-boot sweep (`reopenStaleAnalysis`,
 * below, which calls this once per company with the remaining global budget)
 * AND a Research Profile Save's own immediate, single-company trigger
 * (`triggerStaleAnalysisRecoveryForCompany`) — see that function's comment and
 * `update-research-profile.service.ts`. Neither caller duplicates the paging/
 * staleness/guarded-write logic; both just supply a company id, its resolved
 * `analysisLanguage`, and a budget.
 */
export async function reopenStaleAnalysisForCompany(
  companyId: string,
  language: AnalysisLanguage,
  deps: ReopenStaleAnalysisForCompanyDeps = {}
): Promise<CompanyStaleAnalysisRecoverySummary> {
  const listCompletedRows = deps.listCompletedRows ?? defaultListCompletedRows;
  const reopenRow = deps.reopenRow ?? defaultReopenRow;
  const maxInspected = deps.maxInspected ?? ANALYSIS_RECOVERY_MAX_INSPECTED_PER_COMPANY;
  const maxReopens = deps.maxReopens ?? ANALYSIS_RECOVERY_MAX_REOPENS_PER_SWEEP;

  let rowsInspected = 0;
  let reopened = 0;
  let raced = 0;
  let truncated = false;
  const byStaleness = emptyTally();
  let cursor: string | null = null;

  outer: for (;;) {
    const remainingBudget = maxInspected - rowsInspected;
    if (remainingBudget <= 0) {
      truncated = true;
      break;
    }
    const take = Math.min(ANALYSIS_RECOVERY_PAGE_SIZE, remainingBudget);
    const page: CompletedAnalysisRow[] = await listCompletedRows(companyId, cursor, take);
    if (page.length === 0) break;

    for (const row of page) {
      rowsInspected++;
      // Cross-company isolation is structural: `language` is resolved by the
      // CALLER from THIS company's own analysisLanguage, and every row in
      // `page` was selected by this company's id — a row can never be judged
      // against another company's language.
      const staleness = analysisStaleness(row, language);
      byStaleness[staleness]++;
      if (!isStaleAnalysis(staleness)) continue;

      if (reopened >= maxReopens) {
        // Spend cap reached — stop entirely rather than skip ahead; whatever
        // is left is picked up by the next sweep (boot or a later Save).
        truncated = true;
        break outer;
      }

      if (await reopenRow(row.id, row.analysisHash)) {
        reopened++;
      } else {
        raced++;
      }
    }

    cursor = page[page.length - 1]!.id;
    if (page.length < take) break;
  }

  return { rowsInspected, byStaleness, reopened, raced, truncated };
}

/** The SAME type and dedupe key every other extraction trigger uses, so a job
 *  created by recovery is indistinguishable from one created by an ingest or a
 *  manual entry — and collides with them exactly as it should. */
async function defaultEnqueueExtraction(): Promise<EnqueueJobResult> {
  return enqueueJob({
    type: COMPETITOR_INTELLIGENCE_EXTRACTION_JOB_TYPE,
    dedupeKey: COMPETITOR_INTELLIGENCE_EXTRACTION_DEDUPE_KEY,
  });
}

export async function reopenStaleAnalysis(
  deps: ReopenStaleAnalysisDeps = {}
): Promise<StaleAnalysisRecoverySummary> {
  const listCompanies = deps.listCompanies ?? defaultListCompanies;
  const listCompletedRows = deps.listCompletedRows ?? defaultListCompletedRows;
  const reopenRow = deps.reopenRow ?? defaultReopenRow;
  const enqueueExtraction = deps.enqueueExtraction ?? defaultEnqueueExtraction;

  const startedAt = Date.now();

  const companies = await listCompanies(ANALYSIS_RECOVERY_MAX_COMPANIES);

  let rowsInspected = 0;
  let reopened = 0;
  let raced = 0;
  let truncated = companies.length >= ANALYSIS_RECOVERY_MAX_COMPANIES;
  const byStaleness = emptyTally();
  const companyIds: string[] = [];

  // Sequential on purpose, exactly like the relevance recovery: this runs at
  // boot alongside lease recovery, and a parallel fan-out would hand the
  // database a burst of concurrent queries at the moment the connection has
  // just been opened, for work nobody is waiting on.
  for (const company of companies) {
    // The cap is GLOBAL, not per-company — each call gets only what's left of
    // it, and stops the loop entirely once it hits zero (mirrors the old
    // inlined `break outer`, now expressed as "nothing left to hand out").
    const remainingReopenBudget = ANALYSIS_RECOVERY_MAX_REOPENS_PER_SWEEP - reopened;
    if (remainingReopenBudget <= 0) {
      truncated = true;
      break;
    }

    const language = resolveAnalysisLanguage(company.analysisLanguage);
    const result = await reopenStaleAnalysisForCompany(company.id, language, {
      listCompletedRows,
      reopenRow,
      maxReopens: remainingReopenBudget,
    });

    rowsInspected += result.rowsInspected;
    reopened += result.reopened;
    raced += result.raced;
    if (result.truncated) truncated = true;
    for (const key of Object.keys(byStaleness) as AnalysisStaleness[]) {
      byStaleness[key] += result.byStaleness[key];
    }
    if (result.reopened > 0) companyIds.push(company.id);
  }

  // ONE job for the whole sweep — never one per row. The drain is global and
  // self-continuing, so a single trigger drains every company's re-opened
  // rows; enqueueing per row (or even per company) would only produce dedupe
  // collisions, never throughput. Skipped entirely when nothing was re-opened,
  // so a healthy restart enqueues nothing at all.
  let extractionEnqueued = false;
  let extractionDeduplicated = false;
  if (reopened > 0) {
    try {
      const result = await enqueueExtraction();
      extractionEnqueued = result.enqueued;
      extractionDeduplicated = result.deduplicated;
    } catch (err) {
      // Never fatal. The rows are already `pending`, so the ordinary
      // cron/ingest cadence — or the next worker start — picks them up.
      console.error("[stale-analysis-recovery] extraction enqueue failed (ignored):", err);
    }
  }

  return {
    companiesExamined: companies.length,
    rowsInspected,
    byStaleness,
    reopened,
    raced,
    truncated,
    extractionEnqueued,
    extractionDeduplicated,
    companyIds,
    durationMs: Date.now() - startedAt,
  };
}

export interface CompanyStaleAnalysisRecoveryResult extends CompanyStaleAnalysisRecoverySummary {
  extractionEnqueued: boolean;
  extractionDeduplicated: boolean;
}

/**
 * Public, single-company entry point — what a Research Profile Save calls
 * directly (2026-09-02 ownership-boundary fix; see `update-research-profile.
 * service.ts` and `shouldReopenStaleAnalysisOnSave`) instead of waiting for
 * the next worker restart. Runs the identical bounded sweep
 * (`reopenStaleAnalysisForCompany`) scoped to just this company, with the
 * FULL per-sweep budget (there is no other company competing for it in this
 * call), then — exactly like the boot sweep — best-effort enqueues ONE
 * extraction job, using the SAME dedupe key, only if it actually re-opened
 * anything.
 */
export async function triggerStaleAnalysisRecoveryForCompany(
  companyId: string,
  language: AnalysisLanguage,
  deps: ReopenStaleAnalysisForCompanyDeps & {
    enqueueExtraction?: () => Promise<EnqueueJobResult>;
  } = {}
): Promise<CompanyStaleAnalysisRecoveryResult> {
  const enqueueExtraction = deps.enqueueExtraction ?? defaultEnqueueExtraction;

  const result = await reopenStaleAnalysisForCompany(companyId, language, deps);

  let extractionEnqueued = false;
  let extractionDeduplicated = false;
  if (result.reopened > 0) {
    try {
      const enqueueResult = await enqueueExtraction();
      extractionEnqueued = enqueueResult.enqueued;
      extractionDeduplicated = enqueueResult.deduplicated;
    } catch (err) {
      // Never fatal — see `update-research-profile.service.ts`'s own
      // try/catch around this call for the identical reasoning.
      console.error("[stale-analysis-recovery] extraction enqueue failed (ignored):", err);
    }
  }

  return { ...result, extractionEnqueued, extractionDeduplicated };
}
