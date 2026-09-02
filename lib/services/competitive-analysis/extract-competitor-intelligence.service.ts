/**
 * Per-item Competitive Intelligence extraction (Part 3B §7/§9/§13). Claims one
 * `CompetitorIntelligence` row (lease-guarded, exactly like
 * `classify-feed-item.service.ts`'s claim), calls the extraction model once
 * with one repair attempt, and persists ONLY the intrinsic fields — never
 * `relevance`/`relevanceReason`/`matchedResearchTopics`, which belong
 * exclusively to `recompute-stale-relevance.service.ts` (§8's hard separation).
 * The one narrow exception, added 2026-09-02: a successful write also resets
 * `relevanceProfileVersion` to `null` — a staleness MARKER, not a verdict; see
 * that write's own inline comment for why this belongs here rather than
 * silently rotting a re-extracted row's relevance text in the old language.
 *
 * ── Verification-pass refactor (DB injectability, §7) ───────────────────────
 * This function used to load its own row via `prisma.competitorIntelligence.
 * findUnique`. It now receives an ALREADY-LOADED item, exactly the way
 * `classifyFeedItem` receives an already-loaded `ClassifiableItem` from
 * `classify-feed-items.service.ts` — the loading query lives in the CALLER
 * (`run-competitor-intelligence-extraction.service.ts`), not here. That shift
 * shrinks this function's DB surface to just the two things it actually still
 * needs to ask the database mid-flight: writing claim/persist/fail states,
 * and a FRESH archived re-check immediately before the model call (see §5
 * below) — both narrow enough to inject with a fake for tests, matching
 * `ClassifyFeedItemDb`'s own narrow-interface convention.
 *
 * ── Archived-competitor safety, precise ordering (§5/§14) ───────────────────
 * The caller's selection query is checkpoint 1 (excludes `competitor.
 * archivedAt != null` at SELECT time). This function re-checks a SECOND time,
 * checkpoint 2, via `db.competitor.findFirst` — placed AFTER the atomic claim
 * succeeds and IMMEDIATELY BEFORE the model call, not merely once at the top
 * of the function. The gap that matters is the one right before money is
 * spent on an LLM call (up to `EXTRACTION_ATTEMPT_TIMEOUT_MS`), not the gap
 * before the (fast, synchronous) claim write.
 *
 * ── 2026-09 production livelock fix ──────────────────────────────────────
 * A real worker deployment hot-looped: every drain run reported
 * `processed: 10, extracted: 0, failed: 0, skipped: 10, remaining: 10`
 * forever, across multiple restarts. Root cause, confirmed against the actual
 * affected rows: every one had `status: "failed"`, `attemptCount: 0`,
 * `analysisError: "No readable content to analyze."` — the missing-content
 * branch used to run BEFORE the atomic claim below, writing `status:
 * "failed"` via a plain, unguarded `updateMany` that never touched
 * `attemptCount`. `selectableWhere` (see the drain) matches `status:
 * "failed"` with `attemptCount < MAX_EXTRACTION_ATTEMPTS` — since that count
 * never moved, the exact same 10 rows were reselected, "processed", and
 * "skipped" again on every single run, and `remaining` (same predicate)
 * never dropped. Fixed by moving the missing-content check to AFTER the
 * claim, so a missing-content outcome consumes attempt budget exactly like
 * any other terminal outcome and the row eventually ages out of
 * `selectableWhere` at `MAX_EXTRACTION_ATTEMPTS`. A second, related scar was
 * found and fixed in the same pass: the archived-competitor release path
 * left the claim's `attemptCount` increment in place instead of restoring it,
 * contradicting its own doc comment's promise of "no attempt-budget scar".
 * The drain (`run-competitor-intelligence-extraction.service.ts`) also gained
 * an independent, root-cause-agnostic no-progress guard so an analogous bug
 * anywhere in this pipeline can no longer hot-loop the worker.
 *
 * ── 2026-09 content-acquisition fix (follow-up) ─────────────────────────────
 * With the livelock fixed, the worker terminated correctly but reported
 * `extracted: 0` — every real row was skipped `missing_content`. Root cause
 * was NOT in this file: it was `parser.ts` silently failing to read
 * `<content:encoded>` (see that file's `extractContentEncoded` doc comment)
 * on feeds — like the real affected one, `medium.com/feed/...` — that ship
 * the full article there and nowhere else, combined with the article page
 * itself being unreadable (blocked/paywalled). Fixed upstream, in
 * `ingest-competitor-source.service.ts` and `article-extractor.ts`'s
 * `resolveArticleContent`. This file gained one related, narrower change: the
 * missing-content gate below now also treats a non-empty but below-threshold
 * RSS fallback (`MIN_ANALYZABLE_CONTENT_LENGTH`) as un-analyzable —
 * previously ANY non-empty string, however thin, was sent to the model.
 */

import { prisma } from "@/lib/db/client";
import type { ILlmProvider } from "@/lib/ai/types";
import {
  buildExtractionRepairPrompt,
  buildExtractionSystemPrompt,
  buildExtractionUserPrompt,
  computeExtractionHash,
  parseExtractionResponse,
  EXTRACTION_ATTEMPT_TIMEOUT_MS,
  EXTRACTION_JSON_SCHEMA,
  EXTRACTION_LEASE_MS,
  MAX_EXTRACTION_ATTEMPTS,
  MAX_EXTRACTION_OUTPUT_TOKENS,
  MAX_EXTRACTION_REPAIR_ATTEMPTS,
  type ExtractableContent,
  type ExtractionOutcome,
} from "@/lib/ai/competitor-intelligence-extraction";
import { resolveLlmSelection } from "@/lib/services/ai/resolve-llm-selection.service";
import {
  buildSupportedProvider,
  ProviderNotAvailableError,
} from "@/lib/ai/llm/supported-providers";
import { MIN_ANALYZABLE_CONTENT_LENGTH } from "@/lib/integrations/rss/article-extractor";
import type { AnalysisLanguage } from "@/lib/i18n/analysis-language";
import { extractableContentOf } from "./analysis-staleness";
import { analysisErrorCodeValue } from "./analysis-error";

export type ExtractCompetitorIntelligenceOutcome =
  | { status: "extracted" }
  | {
      status: "skipped";
      reason:
        | "archived"
        | "missing_origin"
        | "missing_content"
        | "content_too_short"
        | "max_attempts"
        | "claimed";
    }
  | { status: "no_provider" }
  | { status: "failed"; error: string };

/** What the caller must have already loaded — mirrors `ClassifiableItem`'s
 *  role for `classifyFeedItem`. Deliberately carries NO `archivedAt`: reading
 *  one here would invite treating a selection-time snapshot as current, which
 *  is exactly the bug this refactor closes (§5). */
export interface ExtractableIntelligenceItem {
  id: string;
  /** Not read by this function (it only ever acts on `competitorId`) —
   *  carried purely so the drain (`run-competitor-intelligence-extraction.
   *  service.ts`) can tell which company to enqueue relevance for after a
   *  successful extraction, without a second query. */
  companyId: string;
  competitorId: string;
  status: string;
  attemptCount: number;
  /** Competitive Analysis's own analysis language (2026-09-02 mixed-language
   *  fix; re-anchored 2026-09-02 ownership-boundary fix to
   *  `CompetitorResearchProfile.analysisLanguage`, never `Company.defaultLang`),
   *  already normalized by the caller. Required, not optional: the bug this
   *  closes was free-form analysis silently coming back in English, so "forgot
   *  to pass it" must be a type error rather than a quiet fallback. Read on the
   *  drain's existing candidate query via the `company.competitorResearchProfile`
   *  relation — no extra round trip per item. */
  analysisLanguage: AnalysisLanguage;
  feedItem: { title: string | null; content: string | null } | null;
  manualEntry: { content: string } | null;
}

/** Narrow DB surface — real Prisma satisfies it; tests inject a fake. */
export interface ExtractCompetitorIntelligenceDb {
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

export interface ExtractCompetitorIntelligenceDeps {
  db?: ExtractCompetitorIntelligenceDb;
  now?: () => Date;
  resolveProvider?: () => Promise<
    { ok: true; instance: ILlmProvider; provider: string; model: string } | { ok: false }
  >;
  attemptTimeoutMs?: number;
}

export class ExtractionTimeoutError extends Error {
  constructor(ms: number) {
    super(`Competitive Intelligence extraction call exceeded its ${ms}ms budget.`);
    this.name = "ExtractionTimeoutError";
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ExtractionTimeoutError(ms)), ms);
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

export async function extractCompetitorIntelligence(
  item: ExtractableIntelligenceItem,
  deps: ExtractCompetitorIntelligenceDeps = {}
): Promise<ExtractCompetitorIntelligenceOutcome> {
  const db = deps.db ?? prisma;
  const now = deps.now ?? (() => new Date());
  const resolveProvider = deps.resolveProvider ?? defaultResolveProvider;
  const attemptTimeoutMs = deps.attemptTimeoutMs ?? EXTRACTION_ATTEMPT_TIMEOUT_MS;

  // Shared with the stale-analysis recovery sweep, deliberately — see
  // `analysis-staleness.ts`'s module comment. If this derivation and the
  // sweep's ever diverged, every re-analyzed row would look stale again on the
  // next worker start and be re-analyzed forever.
  const content: ExtractableContent | null = extractableContentOf(item);

  if (item.attemptCount >= MAX_EXTRACTION_ATTEMPTS) {
    return { status: "skipped", reason: "max_attempts" };
  }

  const provider = await resolveProvider();
  if (!provider.ok) return { status: "no_provider" };

  const attempt = item.attemptCount + 1;
  const leaseExpiresAt = new Date(now().getTime() + EXTRACTION_LEASE_MS);

  // Checkpoint — atomic claim. Mirrors classify-feed-item.service.ts exactly:
  // only one concurrent run wins, a crashed run's expired lease is
  // reclaimable. Deliberately unconditional on `content` being usable — the
  // missing-content check now runs AFTER this claim (see the module comment's
  // "2026-09 production livelock fix") specifically so a missing-content
  // outcome still consumes attempt budget, exactly like every other terminal
  // outcome.
  const claim = await db.competitorIntelligence.updateMany({
    where: {
      id: item.id,
      OR: [
        { status: { in: ["pending", "failed"] } },
        { status: "analyzing", leaseExpiresAt: { lt: now() } },
      ],
    },
    data: { status: "analyzing", attemptCount: attempt, analysisError: null, leaseExpiresAt },
  });
  if (claim.count === 0) return { status: "skipped", reason: "claimed" };

  // Checkpoint 2 (§5/§14) — a FRESH read, not the caller's selection-time
  // snapshot, immediately before the model call.
  const competitorNow = await db.competitor.findFirst({
    where: { id: item.competitorId },
    select: { archivedAt: true },
  });
  if (!competitorNow || competitorNow.archivedAt) {
    // Release the claim rather than failing it — this was never the item's
    // fault, and a restored competitor should find it exactly as claimable as
    // before, with no attempt-budget scar from an archive that happened to
    // land in this narrow window. Restoring `attemptCount` to its PRE-claim
    // value (`item.attemptCount`) is what actually makes that true — the
    // claim above already incremented it, and leaving that increment in
    // place here was a real scar this release was supposed to prevent (found
    // investigating the 2026-09 livelock — see module comment).
    await db.competitorIntelligence.updateMany({
      where: { id: item.id, status: "analyzing", leaseExpiresAt },
      data: { status: "pending", leaseExpiresAt: null, attemptCount: item.attemptCount },
    });
    return { status: "skipped", reason: "archived" };
  }

  // Missing/empty/too-thin content — checked AFTER the claim (2026-09
  // livelock fix, see module comment). This is a genuine terminal outcome for
  // THIS attempt and must consume attempt budget exactly like a thrown model
  // error does, via the same lease-guarded write — otherwise the row stays
  // permanently selectable (`status: "failed"`, `attemptCount` never
  // advancing) and hot-loops the drain forever. `missing_origin` (should be
  // unreachable given the DB's XOR CHECK constraint and the cascade deletes
  // on `feedItemId`/`manualEntryId` — defended anyway) is distinguished from
  // `missing_content` (empty body) and `content_too_short` (2026-09
  // content-acquisition fix — see `ingest-competitor-source.service.ts`'s
  // module comment: a non-empty but below-threshold RSS fallback, e.g. a
  // one-line "Read more..." blurb, is real text but not worth an AI call).
  // The threshold applies only to `feedItem` origin — a manual entry is
  // owner-typed, deliberate content (a short ad headline is genuine signal,
  // not feed noise) and is never held to the same bar.
  const trimmedBody = content?.body.trim() ?? "";
  const isTooThin =
    !!item.feedItem && trimmedBody.length > 0 && trimmedBody.length < MIN_ANALYZABLE_CONTENT_LENGTH;
  if (!content || trimmedBody === "" || isTooThin) {
    const reason =
      !item.feedItem && !item.manualEntry
        ? "missing_origin"
        : isTooThin
          ? "content_too_short"
          : "missing_content";
    // Canonical codes, not English prose (2026-09-02 analysis-error UX
    // cleanup). These two conditions are decided deterministically HERE, so
    // they are the only `analysisError` values with a finite vocabulary and
    // the only ones that can be localized without a model call. Everything in
    // the catch below stays raw provider text, which `resolveAnalysisError`
    // classifies as `unknown` and the UI never renders. See
    // `analysis-error.ts`.
    const analysisError = isTooThin
      ? analysisErrorCodeValue("content_too_short", {
          chars: trimmedBody.length,
          minimum: MIN_ANALYZABLE_CONTENT_LENGTH,
        })
      : analysisErrorCodeValue("no_readable_content");
    const written = await db.competitorIntelligence.updateMany({
      where: { id: item.id, status: "analyzing", leaseExpiresAt },
      data: {
        status: "failed",
        analysisError,
        analyzedAt: now(),
        leaseExpiresAt: null,
      },
    });
    if (written.count === 0) return { status: "skipped", reason: "claimed" };
    return { status: "skipped", reason };
  }

  const hash = computeExtractionHash(content, item.analysisLanguage);
  const systemPrompt = buildExtractionSystemPrompt(item.analysisLanguage);
  let userPrompt = buildExtractionUserPrompt(content);

  try {
    let outcome: ExtractionOutcome | null = null;
    for (let call = 1; call <= MAX_EXTRACTION_REPAIR_ATTEMPTS + 1; call++) {
      const response = await withTimeout(
        provider.instance.generate({
          systemPrompt,
          userPrompt,
          temperature: 0,
          maxTokens: MAX_EXTRACTION_OUTPUT_TOKENS,
          format: EXTRACTION_JSON_SCHEMA,
        }),
        attemptTimeoutMs
      );
      const parsed = parseExtractionResponse(response.text);
      if (parsed.status === "ok") {
        outcome = parsed;
        break;
      }
      outcome = parsed;
      if (call > MAX_EXTRACTION_REPAIR_ATTEMPTS) break;
      userPrompt = buildExtractionRepairPrompt(userPrompt, response.text ?? "", parsed.feedback);
    }

    if (!outcome || outcome.status !== "ok") {
      throw new Error(
        outcome?.status === "invalid" ? outcome.problem : "No usable extraction reply."
      );
    }

    // Guarded by this run's lease — a concurrent run that reclaimed an
    // expired claim owns the row now, and a late result must not overwrite it.
    const written = await db.competitorIntelligence.updateMany({
      where: { id: item.id, status: "analyzing", leaseExpiresAt },
      data: {
        topic: outcome.topic,
        subtopic: outcome.subtopic,
        summary: outcome.summary,
        angle: outcome.angle,
        hookType: outcome.hookType,
        structurePattern: outcome.structurePattern,
        targetAudience: outcome.targetAudience,
        problemAddressed: outcome.problemAddressed,
        keyMessage: outcome.keyMessage,
        tone: outcome.tone,
        ctaText: outcome.ctaText,
        contentType: outcome.contentType,
        commercialIntent: outcome.commercialIntent,
        ctaType: outcome.ctaType,
        angleCategory: outcome.angleCategory,
        productsServicesMentioned: outcome.productsServicesMentioned,
        originalLanguage: outcome.originalLanguage,
        status: "completed",
        analysisHash: hash,
        analysisError: null,
        analyzedAt: now(),
        leaseExpiresAt: null,
        // 2026-09-02 ownership-boundary fix — every successful extraction
        // invalidates whatever relevance verdict this row previously carried,
        // WITHOUT touching `relevance`/`relevanceReason`/`matchedResearchTopics`
        // themselves (still exclusively `competitor-relevance.ts`'s to write —
        // §8's hard separation is unbroken: this is a staleness marker, not a
        // verdict). A no-op on a first-time extraction (already null). On a
        // RE-extraction — caused by a Research Profile analysisLanguage change,
        // a changed EXTRACTION_SEMANTIC_VERSION, or the source content itself
        // changing — this is what makes the row reachable again by
        // `recompute-stale-relevance.service.ts`'s `staleWhere`, which only
        // matches `relevanceProfileVersion !== <current profileVersion>` (or
        // null). Without this, a row already evaluated once would keep its OLD
        // `relevanceReason` text forever: `profileVersion` itself never moves
        // for a language-only change (see `CompetitorResearchProfile.
        // analysisLanguage`'s schema comment), so nothing else would ever mark
        // it stale again after re-extraction finishes.
        relevanceProfileVersion: null,
      },
    });
    if (written.count === 0) return { status: "skipped", reason: "claimed" };
    return { status: "extracted" };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown extraction error.";
    const failWrite = await db.competitorIntelligence.updateMany({
      where: { id: item.id, status: "analyzing", leaseExpiresAt },
      data: { status: "failed", analysisError: error, leaseExpiresAt: null },
    });
    if (failWrite.count === 0) return { status: "skipped", reason: "claimed" };
    return { status: "failed", error };
  }
}
