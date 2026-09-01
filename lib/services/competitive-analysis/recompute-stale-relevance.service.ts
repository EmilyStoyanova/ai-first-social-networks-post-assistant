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
  type RelevanceOutcome,
  type RelevanceProfile,
  type RelevanceSubject,
} from "@/lib/ai/competitor-relevance";
import { resolveLlmSelection } from "@/lib/services/ai/resolve-llm-selection.service";
import {
  buildSupportedProvider,
  ProviderNotAvailableError,
} from "@/lib/ai/llm/supported-providers";

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
};

/** What the drain must have already loaded for one row — mirrors
 *  `ExtractableIntelligenceItem`'s role. Deliberately carries no archived
 *  flag of its own; see the module comment on §5. */
export interface RelevanceRow {
  id: string;
  competitorId: string;
  relevanceProfileVersion: number | null;
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
  | { status: "skipped"; reason: "archived" | "claimed" | "invalid" }
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

  // No research interests configured at all — settle to out_of_scope with NO
  // model call, mirroring classification's `mode === "none"` branch (§11:
  // relevance must still resolve deterministically for an empty profile, not
  // merely stay "pending" forever).
  if (!hasResearchInterests(profile)) {
    const written = await db.competitorIntelligence.updateMany({
      where: { id: row.id, relevanceProfileVersion: row.relevanceProfileVersion },
      data: {
        relevance: "out_of_scope",
        relevanceReason: "No research topics or markets are configured.",
        matchedResearchTopics: [],
        relevanceProfileVersion: version,
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

  const systemPrompt = buildRelevanceSystemPrompt();
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
      },
    });
    return written.count > 0 ? { status: "updated" } : { status: "skipped", reason: "claimed" };
  } catch {
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
};

async function defaultLoadProfile(companyId: string): Promise<RelevanceProfileRow | null> {
  return prisma.competitorResearchProfile.findUnique({
    where: { companyId },
    select: { researchTopics: true, markets: true, profileVersion: true },
  });
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
    return { companyId, processed: 0, updated: 0, failed: 0, skipped: 0, remaining: 0 };
  }

  const profile: RelevanceProfile = {
    researchTopics: profileRow.researchTopics,
    markets: profileRow.markets,
  };
  const version = profileRow.profileVersion;

  const rows = await findStaleRows(companyId, version, RELEVANCE_BATCH_SIZE);

  let updated = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of rows) {
    const outcome = await recomputeRelevanceForRow(row, profile, version, {
      db: deps.db,
      resolveProvider: deps.resolveProvider,
      attemptTimeoutMs: deps.attemptTimeoutMs,
    });
    if (outcome.status === "updated") updated++;
    else if (outcome.status === "failed") failed++;
    else if (outcome.status === "no_provider") {
      // Nothing else in this run can succeed either — stop rather than
      // burning the rest of the batch on calls that will all report the same
      // thing. The un-attempted remainder is still counted below via a fresh
      // `remaining` read, so nothing here is lost, only deferred.
      break;
    } else skipped++;
  }

  // §2 fix — re-read the CURRENT profile version, not the `version` this
  // invocation started with. If a save landed mid-run, this is what lets the
  // handler's continuation (which the fix in competitor-relevance-handler.ts
  // no longer dedupes against its own parent) actually pick up the new
  // version instead of reporting a false `remaining: 0`.
  const currentVersion = (await currentProfileVersion(companyId)) ?? version;
  const remaining = await countRemaining(companyId, currentVersion);

  return { companyId, processed: rows.length, updated, failed, skipped, remaining };
}
