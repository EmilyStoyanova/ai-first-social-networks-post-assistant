/**
 * Per-item Competitive Intelligence extraction (Part 3B §7/§9/§13). Claims one
 * `CompetitorIntelligence` row (lease-guarded, exactly like
 * `classify-feed-item.service.ts`'s claim), calls the extraction model once
 * with one repair attempt, and persists ONLY the intrinsic fields — never
 * `relevance`/`relevanceReason`/`matchedResearchTopics`/`relevanceProfileVersion`,
 * which belong exclusively to `recompute-stale-relevance.service.ts` (§8's hard
 * separation).
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

export type ExtractCompetitorIntelligenceOutcome =
  | { status: "extracted" }
  | { status: "skipped"; reason: "archived" | "no_content" | "max_attempts" | "claimed" }
  | { status: "no_provider" }
  | { status: "failed"; error: string };

/** What the caller must have already loaded — mirrors `ClassifiableItem`'s
 *  role for `classifyFeedItem`. Deliberately carries NO `archivedAt`: reading
 *  one here would invite treating a selection-time snapshot as current, which
 *  is exactly the bug this refactor closes (§5). */
export interface ExtractableIntelligenceItem {
  id: string;
  competitorId: string;
  status: string;
  attemptCount: number;
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

  const content: ExtractableContent | null = item.feedItem
    ? { title: item.feedItem.title, body: item.feedItem.content ?? "" }
    : item.manualEntry
      ? { title: null, body: item.manualEntry.content }
      : null;

  if (!content || content.body.trim() === "") {
    await db.competitorIntelligence.updateMany({
      where: { id: item.id },
      data: {
        status: "failed",
        analysisError: "No readable content to analyze.",
        analyzedAt: now(),
      },
    });
    return { status: "skipped", reason: "no_content" };
  }

  if (item.attemptCount >= MAX_EXTRACTION_ATTEMPTS) {
    return { status: "skipped", reason: "max_attempts" };
  }

  const provider = await resolveProvider();
  if (!provider.ok) return { status: "no_provider" };

  const hash = computeExtractionHash(content);
  const attempt = item.attemptCount + 1;
  const leaseExpiresAt = new Date(now().getTime() + EXTRACTION_LEASE_MS);

  // Checkpoint — atomic claim. Mirrors classify-feed-item.service.ts exactly:
  // only one concurrent run wins, a crashed run's expired lease is
  // reclaimable.
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
    // land in this narrow window.
    await db.competitorIntelligence.updateMany({
      where: { id: item.id, status: "analyzing", leaseExpiresAt },
      data: { status: "pending", leaseExpiresAt: null },
    });
    return { status: "skipped", reason: "archived" };
  }

  const systemPrompt = buildExtractionSystemPrompt();
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
