/**
 * Relevance recompute (Part 3B §11/§12). Re-evaluates the ALREADY-EXTRACTED
 * intrinsic fields of one company's `CompetitorIntelligence` rows against its
 * CURRENT `CompetitorResearchProfile` — never re-running extraction. Triggered
 * by `update-research-profile.service.ts` on the first-ever save, or whenever
 * a later save bumps `profileVersion` (researchTopics/markets actually
 * changed); an `analysisPeriodDays`-only save never bumps the version and
 * never reaches this service (§12).
 *
 * Bounded per run (`RELEVANCE_BATCH_SIZE`) — not an unbounded synchronous loop
 * in the request handler (§12/§27). The worker handler self-continues while
 * `remaining > 0`, exactly like the classification/extraction drains.
 *
 * ── Verification-pass refactor (§2/§5/§7) ────────────────────────────────
 * Split into `recomputeRelevanceForRow` (per-row processor, injectable DB —
 * mirrors `extractCompetitorIntelligence`'s own split) and
 * `recomputeStaleRelevanceForCompany` (the drain: loads the profile + a
 * batch of stale rows, injectable via `findStaleRows`, and loops). Two real
 * bugs the split and its fixes close:
 *
 *   • §2 (drain race) — `remaining` used to be computed with the SAME
 *     `profileVersion` this invocation started with. If a second Research
 *     Profile save landed mid-run (its own enqueue deduped against this
 *     still-active run), `remaining` could read 0 against the STALE version
 *     even though rows were now stale against the NEW one — and the
 *     handler's continuation carried the dedupe key too (a second, separate
 *     bug — see `competitor-relevance-handler.ts`), so nothing would ever
 *     pick the new version up. Fixed on both ends: `remaining` here now
 *     re-reads the CURRENT profile version fresh, and the handler's
 *     continuation carries no dedupe key.
 *   • §5 (archive race) — the per-row archived check used to read a snapshot
 *     taken once, for the WHOLE batch, before the loop started. A competitor
 *     archived while an earlier row in the same batch was still being
 *     processed would not be caught for a later row. `recomputeRelevanceForRow`
 *     now re-checks fresh, per row, immediately before its model call.
 *
 * ── 2026-09 relevance-retry fix (relevance-UI follow-up) ─────────────────
 * Found while implementing automatic post-extraction enqueue (see
 * `run-competitor-intelligence-extraction.service.ts`'s module comment for
 * that half of the fix): this drain had NO bounded-retry guard and NO
 * no-progress continuation guard — `competitor-relevance-handler.ts` used to
 * self-enqueue a continuation whenever `summary.remaining > 0`, full stop,
 * with no dedupe key on the continuation (deliberately, per that file's own
 * comment). A row whose relevance call fails EVERY time (a malformed
 * research-profile input the model can never satisfy, a provider that is
 * misconfigured but still resolves) wrote nothing at all on failure, so
 * `staleWhere` reselected the exact same row every run forever — the
 * relevance-drain analogue of the extraction livelock this session already
 * fixed once, for the identical structural reason (a terminal outcome that
 * never consumes attempt budget).
 *
 * Fixed with the same shape as that earlier fix, adapted to relevance's
 * version-scoped semantics (there is no lease/claim step here — concurrency
 * is already guarded by the optimistic `relevanceProfileVersion` check on
 * every write):
 *
 *   • `relevanceAttemptCount` (new column) bounds retries. `priorAttempts`
 *     below trusts it as the CURRENT streak whenever `relevanceProfileVersion`
 *     is `null` (never evaluated — the ordinary case for a freshly extracted
 *     row failing its first calls) OR already equals `version`; it resets
 *     to 0 only when `relevanceProfileVersion` holds a REAL, different prior
 *     version — a genuine profile change earning a fresh budget instead of
 *     being blocked forever by an older version's exhausted attempts. Note
 *     the asymmetry with `null`: a failure deliberately never stamps
 *     `relevanceProfileVersion` (the row must stay retryable), so treating
 *     `null` as "different version, reset" would make failures never
 *     accumulate at all — see `priorAttempts`'s own comment below for the
 *     exact incident this caused during this fix's own verification.
 *   • On a real model failure, the row is now written (attempt count bumped,
 *     `relevanceReason` set to the error) — genuine progress, since a future
 *     run's `priorAttempts` check will see it and eventually stop retrying.
 *   • At `MAX_RELEVANCE_ATTEMPTS`, the row is settled WITHOUT a model call:
 *     `relevance` stays `pending` (truthful — it was never actually scored),
 *     but `relevanceProfileVersion` is stamped to the current version (so it
 *     leaves `staleWhere` and stops being reselected) and `relevanceReason`
 *     explains why — never "permanently pending with no explanation" (§11 of
 *     the governing instruction).
 *   • `RecomputeStaleRelevanceSummary` gained `progressed`, true only when at
 *     least one row's persistent state actually moved this run — mirroring
 *     `CompetitorIntelligenceExtractionSummary.progressed` exactly.
 *     `competitor-relevance-handler.ts`'s continuation now requires it, just
 *     like the extraction handler's continuation does.
 */

import { prisma } from "@/lib/db/client";
import type { ILlmProvider } from "@/lib/ai/types";
import {
  buildRelevanceRepairPrompt,
  buildRelevanceSystemPrompt,
  buildRelevanceUserPrompt,
  hasResearchInterests,
  parseRelevanceResponse,
  MAX_RELEVANCE_OUTPUT_TOKENS,
  MAX_RELEVANCE_REPAIR_ATTEMPTS,
  RELEVANCE_ATTEMPT_TIMEOUT_MS,
  RELEVANCE_BATCH_SIZE,
  RELEVANCE_JSON_SCHEMA,
  MAX_RELEVANCE_ATTEMPTS,
  type RelevanceOutcome,
  type RelevanceProfile,
  type RelevanceSubject,
} from "@/lib/ai/competitor-relevance";
import { resolveLlmSelection } from "@/lib/services/ai/resolve-llm-selection.service";
import {
  buildSupportedProvider,
  ProviderNotAvailableError,
} from "@/lib/ai/llm/supported-providers";
import { resolveAnalysisLanguage, type AnalysisLanguage } from "@/lib/i18n/analysis-language";
import { relevanceReasonCodeValue } from "./relevance-reason";

// A `type`, not `interface` — see the identical note on
// `CompetitorIntelligenceExtractionSummary`; this shape is returned directly
// as a job's `result`.
export type RecomputeStaleRelevanceSummary = {
  companyId: string;
  processed: number;
  updated: number;
  failed: number;
  skipped: number;
  remaining: number;
  /** True iff at least one processed row's persistent state actually moved
   *  this run (a genuine verdict written, a failed attempt recorded, or a
   *  row settled at `max_attempts`) — see the module comment's 2026-09
   *  relevance-retry fix. Drives the handler's no-progress continuation
   *  guard, mirroring `CompetitorIntelligenceExtractionSummary.progressed`. */
  progressed: boolean;
};

/** What the drain must have already loaded for one row — mirrors
 *  `ExtractableIntelligenceItem`'s role. Deliberately carries no archived
 *  flag of its own; see the module comment on §5. */
export interface RelevanceRow {
  id: string;
  competitorId: string;
  relevanceProfileVersion: number | null;
  /** Attempts accumulated so far — meaningful only when `relevanceProfileVersion`
   *  equals the version this row is now being evaluated against; see
   *  `priorAttempts` below. */
  relevanceAttemptCount: number;
  topic: string | null;
  subtopic: string | null;
  summary: string | null;
  angle: string | null;
  keyMessage: string | null;
  targetAudience: string | null;
  problemAddressed: string | null;
  productsServicesMentioned: string[];
}

export interface RecomputeRelevanceDb {
  competitorIntelligence: {
    updateMany: (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
  };
  competitor: {
    findFirst: (args: {
      where: { id: string };
      select: { archivedAt: true };
    }) => Promise<{ archivedAt: Date | null } | null>;
  };
}

export interface RecomputeRelevanceRowDeps {
  db?: RecomputeRelevanceDb;
  resolveProvider?: () => Promise<
    { ok: true; instance: ILlmProvider; provider: string; model: string } | { ok: false }
  >;
  attemptTimeoutMs?: number;
}

export type RecomputeRelevanceRowOutcome =
  | { status: "updated" }
  | { status: "skipped"; reason: "archived" | "claimed" | "invalid" | "max_attempts" }
  | { status: "no_provider" }
  | { status: "failed" };

async function defaultResolveProvider(): Promise<
  { ok: true; instance: ILlmProvider; provider: string; model: string } | { ok: false }
> {
  const selection = await resolveLlmSelection({});
  if (!selection.success) return { ok: false };
  try {
    const built = buildSupportedProvider(selection.selection.provider);
    return {
      ok: true,
      instance: built.instance,
      provider: selection.selection.providerLabel,
      model: built.model,
    };
  } catch (err) {
    if (err instanceof ProviderNotAvailableError) return { ok: false };
    throw err;
  }
}

class RelevanceTimeoutError extends Error {
  constructor(ms: number) {
    super(`Relevance call exceeded its ${ms}ms budget.`);
    this.name = "RelevanceTimeoutError";
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RelevanceTimeoutError(ms)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Recomputes relevance for ONE row against ONE profile snapshot (`profile` +
 * `version`, both already resolved by the caller — the drain reads the
 * profile once per run, not once per row: the configuration cannot change
 * mid-batch by definition, since the drain always operates against whatever
 * the row it just resolved says, and re-reading a row-varying profile would
 * be a contradiction, not a feature).
 *
 * Guarded by optimistic concurrency (`relevanceProfileVersion: row.
 * relevanceProfileVersion` in the persist `where`): a concurrent recompute
 * that already stamped this row wins instead of being clobbered by a stale
 * in-flight result — the row-level analogue of `extractCompetitorIntelligence`'s
 * lease guard (relevance has no lease column of its own; see
 * `CompetitorIntelligence`'s schema comment).
 */
export async function recomputeRelevanceForRow(
  row: RelevanceRow,
  profile: RelevanceProfile,
  version: number,
  /** The company's analysis language (2026-09-02 mixed-language fix) —
   *  positional and REQUIRED rather than an optional dep, so a future caller
   *  cannot silently fall back to English the way the original code did. */
  analysisLanguage: AnalysisLanguage,
  deps: RecomputeRelevanceRowDeps = {}
): Promise<RecomputeRelevanceRowOutcome> {
  const db = deps.db ?? prisma;
  const resolveProvider = deps.resolveProvider ?? defaultResolveProvider;
  const attemptTimeoutMs = deps.attemptTimeoutMs ?? RELEVANCE_ATTEMPT_TIMEOUT_MS;

  // §5 — a FRESH read, immediately before any model call, not a batch-start
  // snapshot shared across every row in this run.
  const competitorNow = await db.competitor.findFirst({
    where: { id: row.competitorId },
    select: { archivedAt: true },
  });
  if (!competitorNow || competitorNow.archivedAt) {
    return { status: "skipped", reason: "archived" };
  }

  // 2026-09 relevance-retry fix — `relevanceProfileVersion` only ever
  // changes on a genuine EVALUATION (success, the deterministic
  // out-of-scope path, or a max-attempts settle); a failed attempt
  // deliberately leaves it untouched so the row stays retryable. That means
  // a row that has NEVER been evaluated sits at `relevanceProfileVersion:
  // null` for its entire failing streak — comparing that to `version`
  // directly would incorrectly read as "a different version" on every
  // single call and reset `priorAttempts` to 0 forever, so accumulated
  // failures would NEVER reach `MAX_RELEVANCE_ATTEMPTS` and the row would
  // retry infinitely — reproducing the exact hot loop this fix exists to
  // close, for the single most common real case (a freshly extracted row
  // whose first-ever relevance call keeps failing). `null` is therefore
  // treated as "still the current streak," not "a different version" — only
  // a REAL prior version number that differs from `version` resets the
  // budget (a genuine profile change earning a fresh chance).
  const priorAttempts =
    row.relevanceProfileVersion === null || row.relevanceProfileVersion === version
      ? row.relevanceAttemptCount
      : 0;

  if (priorAttempts >= MAX_RELEVANCE_ATTEMPTS) {
    // Settle WITHOUT a model call: `relevance` stays whatever it already was
    // (truthful — this row was never actually scored against `version`), but
    // stamping `relevanceProfileVersion` here is what makes it leave
    // `staleWhere` and stop being reselected forever. `relevanceReason`
    // explains why, so the UI never has to show a bare, unexplained
    // "pending" for a row that in fact exhausted its retries (§11).
    const written = await db.competitorIntelligence.updateMany({
      where: { id: row.id, relevanceProfileVersion: row.relevanceProfileVersion },
      data: {
        // 2026-09-02 mixed-language fix — a canonical code, not an English
        // sentence: this reason is written by THIS function, not the model, so
        // it is a finite vocabulary the UI localizes by mapping and never by
        // an AI call. `relevance-reason.ts` still recognizes the English
        // sentence that used to be stored here, so pre-existing rows localize
        // too.
        relevanceReason: relevanceReasonCodeValue("attempts_exhausted"),
        relevanceProfileVersion: version,
        relevanceAttemptCount: 0,
      },
    });
    return written.count > 0
      ? { status: "skipped", reason: "max_attempts" }
      : { status: "skipped", reason: "claimed" };
  }

  // No research interests configured at all — settle to out_of_scope with NO
  // model call, mirroring classification's `mode === "none"` branch (§11:
  // relevance must still resolve deterministically for an empty profile, not
  // merely stay "pending" forever).
  if (!hasResearchInterests(profile)) {
    const written = await db.competitorIntelligence.updateMany({
      where: { id: row.id, relevanceProfileVersion: row.relevanceProfileVersion },
      data: {
        relevance: "out_of_scope",
        // Deterministic, so localized by mapping — see the note on the
        // exhausted-attempts write above. This one IS user-visible (the
        // `out_of_scope` detail branch renders it), which is how it leaked
        // English into the Bulgarian UI.
        relevanceReason: relevanceReasonCodeValue("no_research_interests"),
        matchedResearchTopics: [],
        relevanceProfileVersion: version,
        relevanceAttemptCount: 0,
        relevanceEvaluatedAt: new Date(),
      },
    });
    return written.count > 0 ? { status: "updated" } : { status: "skipped", reason: "claimed" };
  }

  const provider = await resolveProvider();
  if (!provider.ok) return { status: "no_provider" };

  const subject: RelevanceSubject = {
    topic: row.topic,
    subtopic: row.subtopic,
    summary: row.summary,
    angle: row.angle,
    keyMessage: row.keyMessage,
    targetAudience: row.targetAudience,
    problemAddressed: row.problemAddressed,
    productsServicesMentioned: row.productsServicesMentioned,
  };

  const systemPrompt = buildRelevanceSystemPrompt(analysisLanguage);
  let userPrompt = buildRelevanceUserPrompt(subject, profile);

  try {
    let outcome: RelevanceOutcome | null = null;
    for (let call = 1; call <= MAX_RELEVANCE_REPAIR_ATTEMPTS + 1; call++) {
      const response = await withTimeout(
        provider.instance.generate({
          systemPrompt,
          userPrompt,
          temperature: 0,
          maxTokens: MAX_RELEVANCE_OUTPUT_TOKENS,
          format: RELEVANCE_JSON_SCHEMA,
        }),
        attemptTimeoutMs
      );
      const parsed = parseRelevanceResponse(response.text, profile);
      if (parsed.status === "ok") {
        outcome = parsed;
        break;
      }
      outcome = parsed;
      if (call > MAX_RELEVANCE_REPAIR_ATTEMPTS) break;
      userPrompt = buildRelevanceRepairPrompt(userPrompt, response.text ?? "", parsed.feedback);
    }

    if (!outcome || outcome.status !== "ok") {
      throw new Error(
        outcome?.status === "invalid" ? outcome.problem : "No usable relevance reply."
      );
    }

    const written = await db.competitorIntelligence.updateMany({
      where: { id: row.id, relevanceProfileVersion: row.relevanceProfileVersion },
      data: {
        relevance: outcome.relevance,
        relevanceReason: outcome.reason,
        matchedResearchTopics: outcome.matchedResearchTopics,
        relevanceProfileVersion: version,
        relevanceAttemptCount: 0,
        relevanceEvaluatedAt: new Date(),
      },
    });
    return written.count > 0 ? { status: "updated" } : { status: "skipped", reason: "claimed" };
  } catch (err) {
    // 2026-09 relevance-retry fix — a failure used to write nothing at all,
    // which is exactly what let a permanently-failing row hot-loop the
    // drain's self-continuation (see module comment). Now it consumes
    // attempt budget via the same version-scoped `priorAttempts` counter,
    // and records the error so the row is never silently "still pending"
    // with no explanation. `relevanceProfileVersion` is deliberately left
    // UNCHANGED — a failed attempt has not actually evaluated the row
    // against `version`, so it must remain retryable (still matches
    // `staleWhere`) up to `MAX_RELEVANCE_ATTEMPTS`.
    const message = err instanceof Error ? err.message : "Relevance evaluation failed.";
    await db.competitorIntelligence.updateMany({
      where: { id: row.id, relevanceProfileVersion: row.relevanceProfileVersion },
      data: {
        relevanceReason: message,
        relevanceAttemptCount: priorAttempts + 1,
      },
    });
    return { status: "failed" };
  }
}

// ─── The drain ───────────────────────────────────────────────────────────

/** Stale rows for ONE company: extraction already completed, and the row's
 *  relevance was stamped under a DIFFERENT profile version than the current
 *  one (or has never been stamped at all). Archived competitors are excluded
 *  at selection (§14) — a second, execution-time check happens per row in
 *  `recomputeRelevanceForRow`. */
export function staleWhere(companyId: string, currentVersion: number): Record<string, unknown> {
  return {
    companyId,
    status: "completed",
    competitor: { archivedAt: null },
    OR: [{ relevanceProfileVersion: null }, { relevanceProfileVersion: { not: currentVersion } }],
  };
}

async function defaultFindStaleRows(
  companyId: string,
  version: number,
  limit: number
): Promise<RelevanceRow[]> {
  return prisma.competitorIntelligence.findMany({
    where: staleWhere(companyId, version),
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: {
      id: true,
      competitorId: true,
      relevanceProfileVersion: true,
      relevanceAttemptCount: true,
      topic: true,
      subtopic: true,
      summary: true,
      angle: true,
      keyMessage: true,
      targetAudience: true,
      problemAddressed: true,
      productsServicesMentioned: true,
    },
  });
}

async function defaultCurrentProfileVersion(companyId: string): Promise<number | null> {
  const row = await prisma.competitorResearchProfile.findUnique({
    where: { companyId },
    select: { profileVersion: true },
  });
  return row?.profileVersion ?? null;
}

async function defaultCountRemaining(companyId: string, version: number): Promise<number> {
  return prisma.competitorIntelligence.count({ where: staleWhere(companyId, version) });
}

/** What the drain needs from the persisted Research Profile. Injectable so
 *  the whole drain — including the "no profile yet" branch — is testable
 *  without a live database, matching this file's own §7 goal. */
export type RelevanceProfileRow = {
  researchTopics: string[];
  markets: string[];
  profileVersion: number;
  /** Competitive Analysis's own analysis language, raw (2026-09-02
   *  mixed-language fix; re-anchored 2026-09-02 ownership-boundary fix to
   *  `CompetitorResearchProfile.analysisLanguage` itself — no relation/join
   *  needed any more, since it now lives on this very row). Normalized by the
   *  caller through `resolveAnalysisLanguage`, never trusted as-is. */
  analysisLanguage: string;
};

async function defaultLoadProfile(companyId: string): Promise<RelevanceProfileRow | null> {
  const row = await prisma.competitorResearchProfile.findUnique({
    where: { companyId },
    select: {
      researchTopics: true,
      markets: true,
      profileVersion: true,
      analysisLanguage: true,
    },
  });
  if (!row) return null;
  return {
    researchTopics: row.researchTopics,
    markets: row.markets,
    profileVersion: row.profileVersion,
    analysisLanguage: row.analysisLanguage,
  };
}

export interface RecomputeStaleRelevanceDeps extends RecomputeRelevanceRowDeps {
  loadProfile?: (companyId: string) => Promise<RelevanceProfileRow | null>;
  findStaleRows?: (companyId: string, version: number, limit: number) => Promise<RelevanceRow[]>;
  /** Re-read at the END of the run, not reused from the start — see the
   *  module comment on §2. */
  currentProfileVersion?: (companyId: string) => Promise<number | null>;
  countRemaining?: (companyId: string, version: number) => Promise<number>;
}

export async function recomputeStaleRelevanceForCompany(
  companyId: string,
  deps: RecomputeStaleRelevanceDeps = {}
): Promise<RecomputeStaleRelevanceSummary> {
  const loadProfile = deps.loadProfile ?? defaultLoadProfile;
  const findStaleRows = deps.findStaleRows ?? defaultFindStaleRows;
  const currentProfileVersion = deps.currentProfileVersion ?? defaultCurrentProfileVersion;
  const countRemaining = deps.countRemaining ?? defaultCountRemaining;

  const profileRow = await loadProfile(companyId);
  // No persisted profile — nothing to stamp rows with. (Cannot happen in
  // practice: this is only ever enqueued right after a Save, which is the
  // profile's only writer — see update-research-profile.service.ts.)
  if (!profileRow) {
    return {
      companyId,
      processed: 0,
      updated: 0,
      failed: 0,
      skipped: 0,
      remaining: 0,
      progressed: false,
    };
  }

  const profile: RelevanceProfile = {
    researchTopics: profileRow.researchTopics,
    markets: profileRow.markets,
  };
  const version = profileRow.profileVersion;
  const analysisLanguage = resolveAnalysisLanguage(profileRow.analysisLanguage);

  const rows = await findStaleRows(companyId, version, RELEVANCE_BATCH_SIZE);

  let updated = 0;
  let failed = 0;
  let skipped = 0;
  let progressed = false;

  for (const row of rows) {
    const outcome = await recomputeRelevanceForRow(row, profile, version, analysisLanguage, {
      db: deps.db,
      resolveProvider: deps.resolveProvider,
      attemptTimeoutMs: deps.attemptTimeoutMs,
    });
    if (outcome.status === "updated") {
      updated++;
      progressed = true;
    } else if (outcome.status === "failed") {
      // 2026-09 relevance-retry fix — a failure now WRITES (attempt count +
      // reason; see `recomputeRelevanceForRow`'s catch block), so it is
      // genuine progress, exactly like extraction's equivalent branch.
      failed++;
      progressed = true;
    } else if (outcome.status === "no_provider") {
      // Nothing else in this run can succeed either — stop rather than
      // burning the rest of the batch on calls that will all report the same
      // thing. The un-attempted remainder is still counted below via a fresh
      // `remaining` read, so nothing here is lost, only deferred.
      break;
    } else {
      skipped++;
      // `max_attempts` settled the row (stamped the version, wrote a reason)
      // — real progress, the row-level analogue of extraction's
      // `PROGRESS_SKIP_REASONS`. `archived`/`claimed` never write anything
      // and must not count.
      if (outcome.reason === "max_attempts") progressed = true;
    }
  }

  // §2 fix — re-read the CURRENT profile version, not the `version` this
  // invocation started with. If a save landed mid-run, this is what lets the
  // handler's continuation (which the fix in competitor-relevance-handler.ts
  // no longer dedupes against its own parent) actually pick up the new
  // version instead of reporting a false `remaining: 0`.
  const currentVersion = (await currentProfileVersion(companyId)) ?? version;
  const remaining = await countRemaining(companyId, currentVersion);

  return { companyId, processed: rows.length, updated, failed, skipped, remaining, progressed };
}
