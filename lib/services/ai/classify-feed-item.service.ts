import { prisma } from "@/lib/db/client";
import { Prisma } from "@prisma/client";
import type { ILlmProvider } from "@/lib/ai/types";
import { resolveFeedItemContent } from "@/lib/ai/feed-item-translation";
import {
  buildClassificationRepairPrompt,
  buildClassificationSystemPrompt,
  buildClassificationUserPrompt,
  classificationMode,
  classifyInput,
  fitsSingleClassificationCall,
  ClassificationParseError,
  computeClassificationHash,
  hasCompanyContext,
  parseClassificationResponse,
  CLASSIFICATION_ATTEMPT_TIMEOUT_MS,
  CLASSIFICATION_ITEM_TIMEOUT_MS,
  CLASSIFICATION_JSON_SCHEMA,
  CLASSIFICATION_LEASE_MS,
  MAX_CLASSIFICATION_ATTEMPTS,
  MAX_CLASSIFICATION_OUTPUT_TOKENS,
  MAX_CLASSIFICATION_REPAIR_ATTEMPTS,
  type ClassifiableText,
  type ClassificationArticleInput,
  type ClassificationContext,
  type ClassificationOutcome,
} from "@/lib/ai/feed-item-classification";
import {
  aggregateChunkAnalyses,
  buildChunkAnalysisRepairPrompt,
  buildChunkAnalysisSystemPrompt,
  buildChunkAnalysisUserPrompt,
  planClassificationChunks,
  parseChunkAnalysisResponse,
  ChunkAnalysisParseError,
  ClassificationChunkPartialProgressError,
  CHUNK_ANALYSIS_ATTEMPT_TIMEOUT_MS,
  CHUNK_ANALYSIS_JSON_SCHEMA,
  MAX_CHUNK_ANALYSIS_OUTPUT_TOKENS,
  type AggregatedArticleContext,
  type ChunkAnalysis,
  type ClassificationChunkProgress,
} from "@/lib/ai/classification-chunk-analysis";
import { resolveLlmSelection } from "./resolve-llm-selection.service";
import {
  buildSupportedProvider,
  ProviderNotAvailableError,
} from "@/lib/ai/llm/supported-providers";
import { GenerationTracer } from "@/lib/generation-trace/tracer";

/**
 * Classifies ONE feed item against its company's topic priorities.
 *
 * Invariants, all mirroring translation and extraction for the same reasons:
 *   • `title`/`content` are never written here. The verdict is derived from them
 *     and stored beside them, so the input a verdict was made from stays
 *     auditable and a re-run always starts from the article rather than from its
 *     own last answer.
 *   • The provider is the admin default. Classification is system work and never
 *     passes a per-generation llmConfigId; an unavailable provider is reported,
 *     never silently swapped.
 *   • Failures are recorded, not thrown, so one bad article cannot stall a drain.
 *
 * The one rule that is specific to this step, and the most important line in the
 * file: **a failure is never a rejection**. `no_provider`, a timeout, a dead
 * transport, and a reply that could not be trusted all leave `classification`
 * NULL. Writing REJECTED for any of them would quietly discard an article the
 * company asked for because a model was briefly unavailable — and, unlike a
 * translation failure, nothing downstream would ever look at it again.
 *
 * ── Short articles vs. whole-article classification ─────────────────────────
 *
 * An article whose (translated, if applicable) body fits one classification
 * call is judged from that text directly — unchanged from before the chunk-
 * analysis pipeline existed, and still the common case: most RSS articles are
 * well under the single-call cap.
 *
 * An article OVER that cap is never truncated or sampled. It is split into
 * natural-boundary chunks (`planClassificationChunks`, reusing translation's
 * own splitter), every chunk is analyzed by the same local model into a small
 * structured record (`classification-chunk-analysis.ts`), and the FINAL
 * verdict is asked from the synthesis of every one of them
 * (`aggregateChunkAnalyses`) — never from a subset of the raw text. Both paths
 * converge on the exact same verdict prompt, parser, repair loop, and
 * persistence write (see `persistVerdict` below); only what "## The article"
 * is built from differs.
 */

export type ClassifyFeedItemOutcome =
  | {
      status: "classified";
      classification: "HIGH" | "MEDIUM" | "REJECTED";
      rejectionReason: "BLACKLIST" | "OUT_OF_SCOPE" | null;
      matchedTopics: string[];
      provider: string;
      model: string;
    }
  /**
   * Settled with no model call:
   *   • "unchanged"      — the stored verdict already matches this text + config;
   *   • "not_configured" — the company has configured no topics at all;
   *   • "no_content"     — the item has neither a title nor a body to judge;
   *   • "max_attempts"   — the retry budget is spent;
   *   • "claimed"        — a concurrent run holds the item.
   */
  | {
      status: "skipped";
      reason: "unchanged" | "not_configured" | "no_content" | "max_attempts" | "claimed";
    }
  /** No admin default provider configured; deliberately does NOT count an attempt. */
  | { status: "no_provider" }
  /**
   * The whole-article chunk-analysis pipeline ran out of item budget (or one
   * chunk could not be reliably analyzed) before every chunk was done. NOT a
   * failure — mirrors translation's own "partial" outcome exactly: real
   * progress was banked to `classificationChunkProgress` and the claim was
   * released back to `pending` (no backoff) so the very next selection
   * resumes right where this call stopped, without re-analyzing a chunk that
   * already succeeded.
   */
  | { status: "partial"; processedChunkCount: number; totalChunkCount: number }
  /** The model or the transport broke, or its reply could not be trusted. */
  | { status: "failed"; error: string };

/** The FeedItem fields classification reads. */
export interface ClassifiableItem {
  id: string;
  /**
   * Which company this article belongs to. Read only so the trace run can be
   * filed under it — nothing in classification branches on it, and it is
   * optional so a caller assembled before tracing existed stays valid.
   */
  companyId?: string;
  title: string | null;
  content: string | null;
  url: string;
  translatedTitle?: string | null;
  translatedContent?: string | null;
  translationStatus?: string | null;
  classificationStatus: string | null;
  classificationHash: string | null;
  classificationAttemptCount: number;
  /**
   * Chunk analyses banked by an earlier, interrupted attempt at THIS item's
   * whole-article pipeline — `{ hash, chunks: {chunkIndex: ChunkAnalysis} }`.
   * `null`/absent for every item that has never been routed through the
   * chunked path (i.e. almost all of them), in which case classification
   * proceeds exactly as it always has. See `StoredChunkProgress` below.
   */
  classificationChunkProgress?: unknown;
}

/** Narrow DB surface — real Prisma satisfies it; tests inject a fake. */
export interface ClassifyFeedItemDb {
  feedItem: {
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
    updateMany: (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
  };
}

export interface ClassifyFeedItemDeps {
  db?: ClassifyFeedItemDb;
  resolveProvider?: () => Promise<
    { ok: true; instance: ILlmProvider; provider: string; model: string } | { ok: false }
  >;
  now?: () => Date;
  /** Wall-clock cap for ONE model call (verdict or chunk analysis). Overridable so tests need not wait. */
  attemptTimeoutMs?: number;
  /**
   * ABSOLUTE wall-clock cap for the whole item, overriding whichever
   * path-appropriate default would otherwise apply. For tests — production
   * never sets this; it lets `remainingRunBudgetMs` decide instead. Set,
   * this wins outright (it is not additionally capped by the path default).
   */
  itemTimeoutMs?: number;
  /**
   * How much of the RUN's own budget is left, per `classify-feed-items.service.ts`'s
   * `remainingMs`. The item's actual budget becomes
   * `min(pathDefault, remainingRunBudgetMs)` — the path default being
   * {@link CLASSIFICATION_ITEM_TIMEOUT_MS} or the larger
   * {@link CLASSIFICATION_CHUNKED_ITEM_TIMEOUT_MS}, decided only once this
   * function has resolved the text and knows whether the article needs
   * chunking. Kept separate from `itemTimeoutMs` because the caller cannot
   * know which default applies without duplicating that decision itself.
   */
  remainingRunBudgetMs?: number;
  maxRepairAttempts?: number;
  /**
   * The trace recorder for this classification. Injected in tests; production
   * starts its own run. Observation only — nothing here branches on it.
   */
  tracer?: GenerationTracer;
}

/**
 * A reply that arrived, parsed, and still could not be trusted — after its repair
 * call. An Error so it joins the existing failure path (claim-guarded write,
 * attempt counter, retry on the next drain), which is exactly what an untrustworthy
 * verdict needs.
 */
export class UntrustworthyClassificationError extends Error {
  readonly code = "UNTRUSTWORTHY_CLASSIFICATION" as const;
  constructor(problem: string) {
    super(`The classification could not be trusted and was not stored. ${problem}`);
    this.name = "UntrustworthyClassificationError";
  }
}

export class ClassificationTimeoutError extends Error {
  readonly code = "CLASSIFICATION_TIMEOUT" as const;
  constructor(ms: number, scope: "attempt" | "item") {
    super(`Article classification ${scope} exceeded its ${ms}ms budget.`);
    this.name = "ClassificationTimeoutError";
  }
}

/**
 * Wall-clock cap for the whole item on the CHUNKED path — larger than the
 * short path's {@link CLASSIFICATION_ITEM_TIMEOUT_MS} because it may cost
 * several chunk-analysis calls plus the final verdict call, serially, rather
 * than one. Sized like translation's own item budget (`TRANSLATION_ITEM_TIMEOUT_MS`),
 * which pays for the same kind of multi-call article processing on the same
 * worker.
 */
export const CLASSIFICATION_CHUNKED_ITEM_TIMEOUT_MS = 210_000;

/**
 * Rejects with {@link ClassificationTimeoutError} if `work` has not settled in
 * `ms`. The underlying request is NOT cancelled — the provider owns its own much
 * longer transport cap. This bound exists so a hung article stops occupying the
 * drain, not to manage the socket.
 */
function withTimeout<T>(work: Promise<T>, ms: number, scope: "attempt" | "item"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ClassificationTimeoutError(ms, scope)), ms);
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

/**
 * The persisted shape of `FeedItem.classificationChunkProgress`.
 *
 * `hash` is the classification hash the banked chunks were analyzed FOR —
 * checked against the current run's own hash before any of `chunks` is
 * trusted. Without this fencing, an article edited (or re-translated) between
 * two attempts would silently resume analysis for text that no longer
 * exists: the chunk boundaries themselves can shift, so "chunk 3" from a stale
 * run is not even the same passage as "chunk 3" now. A mismatch is treated
 * exactly like no banked progress at all — safe, if occasionally wasteful of
 * whatever partial work existed under the old hash.
 */
interface StoredChunkProgress {
  hash: string;
  chunks: ClassificationChunkProgress;
}

function readStoredChunkProgress(raw: unknown, currentHash: string): ClassificationChunkProgress {
  if (raw === null || typeof raw !== "object") return {};
  const candidate = raw as Partial<StoredChunkProgress>;
  if (candidate.hash !== currentHash) return {};
  if (candidate.chunks === null || typeof candidate.chunks !== "object") return {};
  return candidate.chunks as ClassificationChunkProgress;
}

export async function classifyFeedItem(
  item: ClassifiableItem,
  context: ClassificationContext,
  deps: ClassifyFeedItemDeps = {}
): Promise<ClassifyFeedItemOutcome> {
  const db = deps.db ?? prisma;
  const now = deps.now ?? (() => new Date());
  const resolveProvider = deps.resolveProvider ?? defaultResolveProvider;
  const { priorities } = context;

  // The single resolver every other step reads through: a completed translation
  // is what gets judged, so a Bulgarian topic list is compared against Bulgarian
  // text rather than against the original English.
  const resolved = resolveFeedItemContent(item);
  const text: ClassifiableText = { title: resolved.title, body: resolved.content };
  const mode = classificationMode(priorities);
  const inputKind = classifyInput(text);

  // ── Settled without a model ────────────────────────────────────────────────

  // No configuration at all. The backwards-compatibility contract: nothing is
  // rejected, and `classification` stays null so candidate selection sees an
  // article with no signal rather than a discarded one.
  if (mode === "none") {
    await db.feedItem.update({
      where: { id: item.id },
      data: {
        classificationStatus: "skipped",
        classification: null,
        classificationRejectionReason: null,
        classificationMatchedTopics: [],
        classificationReason: null,
        // Cleared with the rest of the verdict: a settled non-answer has no
        // subject and no deciding topic, and a stale one read as if it did.
        classificationMainSubject: null,
        classificationPrimaryTopic: null,
        classificationHash: computeClassificationHash(text, context),
        classificationError: null,
        classifiedAt: now(),
        classificationLeaseExpiresAt: null,
        classificationChunkProgress: Prisma.JsonNull,
      },
    });
    return { status: "skipped", reason: "not_configured" };
  }

  // Nothing to read. Settled rather than failed: retrying re-asks a question only
  // a re-ingest can change, and a re-ingest changes the hash and reopens it.
  if (inputKind === "empty") {
    await db.feedItem.update({
      where: { id: item.id },
      data: {
        classificationStatus: "skipped",
        classification: null,
        classificationRejectionReason: null,
        classificationMatchedTopics: [],
        classificationReason: null,
        // Cleared with the rest of the verdict: a settled non-answer has no
        // subject and no deciding topic, and a stale one read as if it did.
        classificationMainSubject: null,
        classificationPrimaryTopic: null,
        classificationHash: computeClassificationHash(text, context),
        classificationError: "The article has no readable title or body to classify.",
        classifiedAt: now(),
        classificationLeaseExpiresAt: null,
        classificationChunkProgress: Prisma.JsonNull,
      },
    });
    return { status: "skipped", reason: "no_content" };
  }

  const hash = computeClassificationHash(text, context);

  // Neither the article nor the configuration has changed since the stored
  // verdict. Settle the row back to `completed` WITHOUT a model call — this is
  // what makes reclassification idempotent and lets a settings save reopen items
  // bluntly: anything whose inputs did not really change costs one write.
  if (item.classificationHash === hash) {
    if (item.classificationStatus !== "completed" && item.classificationStatus !== "skipped") {
      await db.feedItem.updateMany({
        where: { id: item.id, classificationHash: hash },
        data: {
          classificationStatus: "completed",
          classificationError: null,
          classificationLeaseExpiresAt: null,
        },
      });
    }
    return { status: "skipped", reason: "unchanged" };
  }

  if (item.classificationAttemptCount >= MAX_CLASSIFICATION_ATTEMPTS) {
    return { status: "skipped", reason: "max_attempts" };
  }

  const provider = await resolveProvider();
  if (!provider.ok) {
    // An operator problem, not an article problem: leave the item pending at its
    // current attempt count so it classifies once a provider is configured.
    return { status: "no_provider" };
  }

  // Decided BEFORE the claim, purely from the text — never truncated, never
  // sampled. A body over the single-call cap is routed through the
  // whole-article chunk-analysis pipeline instead of this function ever
  // building a prompt from raw text for it.
  const needsChunking = inputKind === "full" && !fitsSingleClassificationCall(text.body);

  const attempt = item.classificationAttemptCount + 1;
  const leaseExpiresAt = new Date(now().getTime() + CLASSIFICATION_LEASE_MS);

  // Atomic claim. Candidates are selected without locking, so the scheduled drain
  // and a continuation can both hold this item — only one wins this conditional
  // write, and the loser skips WITHOUT calling the model. A crashed run leaves the
  // row `classifying` with a lease in the past, which the selector reclaims.
  const claim = await db.feedItem.updateMany({
    where: {
      id: item.id,
      OR: [
        { classificationStatus: { in: ["pending", "failed"] } },
        { classificationStatus: "classifying", classificationLeaseExpiresAt: { lt: now() } },
      ],
    },
    data: {
      classificationStatus: "classifying",
      classificationAttemptCount: attempt,
      classificationError: null,
      classificationLeaseExpiresAt: leaseExpiresAt,
    },
  });
  if (claim.count === 0) return { status: "skipped", reason: "claimed" };

  // ── Trace ─────────────────────────────────────────────────────────────────
  // Started after the claim, for the reason translation's is: everything above
  // settles without a model call, and a run for "nothing to do" would stand in
  // front of the real verdict as the most recent one.
  const tracer =
    deps.tracer ??
    GenerationTracer.start({
      kind: "classification",
      trigger: "system",
      companyId: item.companyId ?? null,
      feedItemId: item.id,
      options: {
        mode,
        inputKind,
        attempt,
        maxAttempts: MAX_CLASSIFICATION_ATTEMPTS,
        needsChunking,
      },
    });
  // Set explicitly rather than only through the init above, so an injected
  // tracer is filed under the same company and model as one started here.
  tracer.setCompany(item.companyId);
  tracer.setLlm(provider.provider, provider.model);
  tracer.step({
    type: "request",
    label: `Classify article against topic priorities (${mode})`,
    input: { feedItemId: item.id, url: item.url, mode, inputKind, attempt },
    metadata: {
      classificationHash: hash,
      usedTranslation: resolved.usedTranslation,
      // Requirement (v2-11): how big the article is and which path it takes —
      // the two facts that explain every chunk-analysis log line that follows.
      articleChars: (text.body ?? "").length,
      needsChunking,
    },
  });
  tracer.step({
    type: "context",
    label: "Topic configuration",
    output: {
      // The topic lists AS THEY STOOD. Editing them tomorrow reopens the article
      // for a fresh verdict and writes a new run; this one keeps the old lists,
      // which is the only way "why was this rejected in March" stays answerable.
      highPriorityTopics: priorities.high,
      mediumPriorityTopics: priorities.medium,
      avoidedTopics: priorities.avoided,
      companyDescription: context.companyDescription,
      targetAudience: context.targetAudience,
    },
    metadata: { mode, withCompanyContext: hasCompanyContext(context) },
  });
  tracer.step({
    type: "source",
    label: "Text judged",
    output: needsChunking ? undefined : { title: text.title, content: text.body },
    metadata: {
      // Which text the verdict was made on: a completed translation is what gets
      // judged, so a Bulgarian topic list is compared against Bulgarian text.
      usedTranslation: resolved.usedTranslation,
      bodyChars: (text.body ?? "").length,
      needsChunking,
    },
  });

  // Diagnostics carry sizes and counts, never the article body or the topic lists.
  const diag = {
    feedItemId: item.id,
    url: item.url,
    mode,
    inputKind,
    usedTranslation: resolved.usedTranslation,
    bodyLength: (text.body ?? "").length,
    // Whether the prompt carried brand copy — never the copy itself. Enough to
    // tell "this company's verdicts were made blind" from "they were not".
    withCompanyContext: hasCompanyContext(context),
    attempt,
    needsChunking,
  };
  const startedAtMs = now().getTime();
  const attemptTimeoutMs = deps.attemptTimeoutMs ?? CLASSIFICATION_ATTEMPT_TIMEOUT_MS;
  const pathDefaultTimeoutMs = needsChunking
    ? CLASSIFICATION_CHUNKED_ITEM_TIMEOUT_MS
    : CLASSIFICATION_ITEM_TIMEOUT_MS;
  const itemTimeoutMs =
    deps.itemTimeoutMs ??
    (deps.remainingRunBudgetMs === undefined
      ? pathDefaultTimeoutMs
      : Math.min(pathDefaultTimeoutMs, deps.remainingRunBudgetMs));
  const itemDeadlineMs = startedAtMs + itemTimeoutMs;
  const maxRepairs = deps.maxRepairAttempts ?? MAX_CLASSIFICATION_REPAIR_ATTEMPTS;
  console.info("[classification] classifying", diag);

  /**
   * Asks the verdict model once, vets the reply, and — for a reply that is
   * merely the wrong shape or internally inconsistent — asks once more with
   * the exact problem named.
   *
   * A THROWN error (a timeout, a dead transport) deliberately does not repair:
   * nothing about the reply was wrong, so there is nothing to tell the model.
   */
  const askVerdictUntilUsable = async (
    userPrompt: string,
    systemPrompt: string
  ): Promise<{ outcome: ClassificationOutcome; calls: number }> => {
    let prompt = userPrompt;
    let last: ClassificationOutcome | null = null;

    for (let call = 1; call <= maxRepairs + 1; call++) {
      tracer.step({
        type: "prompt",
        label: call > 1 ? `Call ${call} — repair prompt` : `Call ${call}`,
        attempt: call,
        input: { systemPrompt, userPrompt: prompt },
        metadata: {
          temperature: 0,
          maxTokens: MAX_CLASSIFICATION_OUTPUT_TOKENS,
          isRepair: call > 1,
        },
      });

      const callStartedAt = new Date();
      const response = await withTimeout(
        provider.instance.generate({
          systemPrompt,
          userPrompt: prompt,
          // Deterministic: the same article and the same configuration must not
          // produce a different verdict on a re-run.
          temperature: 0,
          maxTokens: MAX_CLASSIFICATION_OUTPUT_TOKENS,
          format: CLASSIFICATION_JSON_SCHEMA,
        }),
        attemptTimeoutMs,
        "attempt"
      );
      tracer.setAttempts(call);
      tracer.step({
        type: "llm_call",
        label: `Call ${call}`,
        attempt: call,
        startedAt: callStartedAt,
        completedAt: new Date(),
        input: { request: { temperature: 0, maxTokens: MAX_CLASSIFICATION_OUTPUT_TOKENS } },
        metadata: { providerPayload: response.raw ?? null },
      });
      tracer.step({
        type: "raw_response",
        label: `Call ${call}`,
        attempt: call,
        output: { text: response.text },
        metadata: { chars: response.text?.length ?? 0 },
      });

      const parsed = parseClassificationResponse(response.text, priorities);
      if (parsed.status === "ok") {
        tracer.step({
          type: "parsed_result",
          label: `Call ${call} accepted`,
          attempt: call,
          output: {
            classification: parsed.classification,
            rejectionReason: parsed.rejectionReason,
            matchedTopics: parsed.matchedTopics,
            primaryTopic: parsed.primaryTopic,
            mainSubject: parsed.mainSubject,
            reason: parsed.reason,
          },
        });
        return { outcome: parsed, calls: call };
      }

      last = parsed;
      const willRepair = call <= maxRepairs;
      tracer.step({
        type: "retry",
        label: willRepair
          ? `Call ${call} rejected — repairing`
          : `Call ${call} rejected — untrusted`,
        attempt: call,
        status: "failed",
        output: { problem: parsed.problem, willRepair },
      });
      if (!willRepair) break;

      console.warn("[classification] reply rejected — repairing", {
        ...diag,
        call,
        problem: parsed.problem,
      });
      prompt = buildClassificationRepairPrompt(userPrompt, response.text ?? "", parsed.feedback);
    }

    return { outcome: last!, calls: maxRepairs + 1 };
  };

  /**
   * Analyzes ONE chunk, with its own (single) repair attempt. A reply that
   * still cannot be trusted after repair is treated exactly like a timeout —
   * both throw {@link ClassificationChunkPartialProgressError} with
   * `alreadyBanked` (everything up to, but NOT including, this chunk), so the
   * caller's single recovery path (bank-and-resume, or fail once attempts run
   * out) covers both. Mirrors `translateChunked`'s own unification of
   * "timed out" and "could not get reliable output after retries" into one
   * `TranslationPartialProgressError`.
   */
  const analyzeChunk = async (
    chunkIndex: number,
    chunkText: string,
    chunkCount: number,
    title: string | null,
    alreadyBanked: ClassificationChunkProgress
  ): Promise<ChunkAnalysis> => {
    const remainingMs = itemDeadlineMs - now().getTime();
    if (remainingMs <= 0) {
      throw new ClassificationChunkPartialProgressError(
        `Ran out of item budget before analyzing chunk ${chunkIndex + 1}/${chunkCount}.`,
        alreadyBanked,
        Object.keys(alreadyBanked).length,
        chunkCount
      );
    }

    const systemPrompt = buildChunkAnalysisSystemPrompt();
    let userPrompt = buildChunkAnalysisUserPrompt({ title, chunkText, chunkIndex, chunkCount });
    const chunkAttemptTimeoutMs = Math.min(
      attemptTimeoutMs,
      CHUNK_ANALYSIS_ATTEMPT_TIMEOUT_MS,
      Math.max(remainingMs, 1)
    );

    for (let call = 1; call <= maxRepairs + 1; call++) {
      tracer.step({
        type: "prompt",
        label: `Chunk ${chunkIndex + 1}/${chunkCount} — call ${call}${call > 1 ? " (repair)" : ""}`,
        attempt: call,
        input: { systemPrompt, userPrompt },
        metadata: {
          chunkIndex,
          chunkCount,
          chunkChars: chunkText.length,
          isRepair: call > 1,
        },
      });

      let response: { text: string | null; raw?: unknown };
      try {
        response = await withTimeout(
          provider.instance.generate({
            systemPrompt,
            userPrompt,
            temperature: 0,
            maxTokens: MAX_CHUNK_ANALYSIS_OUTPUT_TOKENS,
            format: CHUNK_ANALYSIS_JSON_SCHEMA,
          }),
          chunkAttemptTimeoutMs,
          "attempt"
        );
      } catch (err) {
        throw new ClassificationChunkPartialProgressError(
          `Could not analyze chunk ${chunkIndex + 1}/${chunkCount}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          alreadyBanked,
          Object.keys(alreadyBanked).length,
          chunkCount
        );
      }

      tracer.step({
        type: "raw_response",
        label: `Chunk ${chunkIndex + 1}/${chunkCount} — call ${call}`,
        attempt: call,
        output: { text: response.text },
        metadata: { chars: response.text?.length ?? 0 },
      });

      let parsed;
      try {
        parsed = parseChunkAnalysisResponse(response.text);
      } catch (err) {
        if (err instanceof ChunkAnalysisParseError) {
          throw new ClassificationChunkPartialProgressError(
            `Chunk ${chunkIndex + 1}/${chunkCount} returned an empty response.`,
            alreadyBanked,
            Object.keys(alreadyBanked).length,
            chunkCount
          );
        }
        throw err;
      }

      if (parsed.status === "ok") {
        tracer.step({
          type: "parsed_result",
          label: `Chunk ${chunkIndex + 1}/${chunkCount} analyzed — ${parsed.centrality}`,
          attempt: call,
          output: {
            mainPoint: parsed.mainPoint,
            topics: parsed.topics,
            entities: parsed.entities,
            importantFacts: parsed.importantFacts,
            centrality: parsed.centrality,
          },
        });
        const { status: _status, ...analysis } = parsed;
        return analysis;
      }

      const willRepair = call <= maxRepairs;
      tracer.step({
        type: "retry",
        label: willRepair
          ? `Chunk ${chunkIndex + 1}/${chunkCount} rejected — repairing`
          : `Chunk ${chunkIndex + 1}/${chunkCount} rejected — untrusted`,
        attempt: call,
        status: "failed",
        output: { problem: parsed.problem, willRepair },
      });
      if (!willRepair) {
        throw new ClassificationChunkPartialProgressError(
          `Chunk ${chunkIndex + 1}/${chunkCount} could not be reliably analyzed: ${parsed.problem}`,
          alreadyBanked,
          Object.keys(alreadyBanked).length,
          chunkCount
        );
      }
      userPrompt = buildChunkAnalysisRepairPrompt(userPrompt, response.text ?? "", parsed.feedback);
    }

    // Unreachable — the loop above always returns or throws — but keeps the
    // function's return type honest without a non-null assertion at the call site.
    throw new ClassificationChunkPartialProgressError(
      `Chunk ${chunkIndex + 1}/${chunkCount} exhausted its repair attempts.`,
      alreadyBanked,
      Object.keys(alreadyBanked).length,
      chunkCount
    );
  };

  /**
   * Persists a verdict that survived `parseClassificationResponse`, guarded by
   * the lease this run stamped — the same fencing the pre-chunking code always
   * used. Shared by both paths so a chunked run's success write is
   * byte-for-byte the short path's, plus clearing `classificationChunkProgress`
   * (a completed verdict needs no more banked progress; the next reclassification,
   * if any, starts clean).
   */
  const persistVerdict = async (outcome: Extract<ClassificationOutcome, { status: "ok" }>) => {
    return db.feedItem.updateMany({
      where: {
        id: item.id,
        classificationStatus: "classifying",
        classificationLeaseExpiresAt: leaseExpiresAt,
      },
      data: {
        classification: outcome.classification,
        classificationRejectionReason: outcome.rejectionReason,
        classificationMatchedTopics: outcome.matchedTopics,
        classificationReason: outcome.reason,
        classificationMainSubject: outcome.mainSubject,
        classificationPrimaryTopic: outcome.primaryTopic,
        classificationStatus: "completed",
        classificationHash: hash,
        classificationError: null,
        classifiedAt: now(),
        classificationProvider: provider.provider,
        classificationModel: provider.model,
        classificationLeaseExpiresAt: null,
        classificationChunkProgress: Prisma.JsonNull,
      },
    });
  };

  // Hoisted above the try so the generic catch branch (the FINAL verdict call
  // failing, after every chunk already succeeded) can still persist whatever
  // was analyzed THIS attempt — same object reference `banked` below mutates
  // into, so it reflects every chunk finished before the failure, not just
  // what was resumed at the start.
  let bankedChunksForFailure: ClassificationChunkProgress | null = null;

  try {
    let article: ClassificationArticleInput;
    let aggregateForTrace: AggregatedArticleContext | null = null;
    let chunkCountForTrace: number | null = null;

    if (needsChunking) {
      const chunked = planClassificationChunks(text.title, text.body as string);
      chunkCountForTrace = chunked.chunks.length;

      const resumed = readStoredChunkProgress(item.classificationChunkProgress, hash);
      const banked: ClassificationChunkProgress = { ...resumed };
      bankedChunksForFailure = banked;

      tracer.step({
        type: "prompt",
        label: `Article split into ${chunked.chunks.length} chunk${chunked.chunks.length === 1 ? "" : "s"} for classification`,
        metadata: {
          articleChars: (text.body ?? "").length,
          chunkCount: chunked.chunks.length,
          chunkSizes: chunked.chunks.map((c) => c.text.length),
          resumedChunkCount: Object.keys(resumed).length,
        },
      });
      console.info("[classification] article split into chunks", {
        ...diag,
        chunkCount: chunked.chunks.length,
        resumedChunkCount: Object.keys(resumed).length,
      });

      for (let i = 0; i < chunked.chunks.length; i += 1) {
        if (String(i) in banked) continue; // resumed from a prior attempt
        const analysis = await analyzeChunk(
          i,
          chunked.chunks[i].text,
          chunked.chunks.length,
          text.title,
          banked
        );
        banked[String(i)] = analysis;
      }

      const analyses = chunked.chunks.map((_, i) => banked[String(i)]);
      const aggregate = aggregateChunkAnalyses(analyses);
      aggregateForTrace = aggregate;

      tracer.step({
        type: "parsed_result",
        label: "Chunk analyses synthesized",
        output: {
          chunkCount: aggregate.chunkCount,
          centralPoints: aggregate.centralPoints,
          supportingPoints: aggregate.supportingPoints,
          topics: aggregate.topics,
          entities: aggregate.entities,
          importantFacts: aggregate.importantFacts,
        },
        metadata: { truncated: aggregate.truncated },
      });
      console.info("[classification] chunk analyses synthesized", {
        ...diag,
        chunkCount: aggregate.chunkCount,
        centralPointCount: aggregate.centralPoints.length,
        supportingPointCount: aggregate.supportingPoints.length,
        topicCount: aggregate.topics.length,
        entityCount: aggregate.entities.length,
        factCount: aggregate.importantFacts.length,
        truncated: aggregate.truncated,
      });

      article = { kind: "aggregate", title: text.title, aggregate };
    } else {
      article = { kind: "text", text, inputKind };
    }

    const systemPrompt = buildClassificationSystemPrompt(mode);
    const userPrompt = buildClassificationUserPrompt({ article, context });

    const { outcome, calls } = await withTimeout(
      askVerdictUntilUsable(userPrompt, systemPrompt),
      Math.max(itemDeadlineMs - now().getTime(), 1),
      "item"
    );

    if (outcome.status === "invalid") {
      throw new UntrustworthyClassificationError(outcome.problem);
    }

    // Guarded by the lease this run stamped: a concurrent run that reclaimed an
    // expired claim owns the item now, and a late verdict must not overwrite it.
    const written = await persistVerdict(outcome);
    if (written.count === 0) {
      tracer.skipped(
        "persistence",
        "A concurrent run reclaimed this article; the verdict was discarded."
      );
      return { status: "skipped", reason: "claimed" };
    }

    tracer.step({
      type: "persistence",
      label: `Verdict stored — ${outcome.classification}`,
      output: {
        classification: outcome.classification,
        rejectionReason: outcome.rejectionReason,
        matchedTopics: outcome.matchedTopics,
        primaryTopic: outcome.primaryTopic,
        mainSubject: outcome.mainSubject,
        reason: outcome.reason,
      },
      metadata: {
        provider: provider.provider,
        model: provider.model,
        modelCalls: calls,
        classificationHash: hash,
        needsChunking,
        chunkCount: chunkCountForTrace,
        aggregateTruncated: aggregateForTrace?.truncated ?? null,
      },
    });

    console.info("[classification] classified", {
      ...diag,
      elapsedMs: now().getTime() - startedAtMs,
      classification: outcome.classification,
      rejectionReason: outcome.rejectionReason,
      // The topic the verdict rests on, which is the one thing worth reading in
      // this line when a HIGH looks wrong. The article's own text stays out.
      primaryTopic: outcome.primaryTopic,
      matchedCount: outcome.matchedTopics.length,
      modelCalls: calls,
      chunkCount: chunkCountForTrace,
      provider: provider.provider,
      model: provider.model,
    });

    return {
      status: "classified",
      classification: outcome.classification,
      rejectionReason: outcome.rejectionReason,
      matchedTopics: outcome.matchedTopics,
      provider: provider.provider,
      model: provider.model,
    };
  } catch (err) {
    if (err instanceof ClassificationChunkPartialProgressError) {
      // NOT a failure — see the class's own comment. The chunks that
      // succeeded are real, banked progress; what happens next depends only
      // on whether this claim's attempt was the item's last one.
      const elapsedMs = now().getTime() - startedAtMs;
      const remainingChunkCount = err.totalChunkCount - err.processedChunkCount;
      const isFinalAttempt = attempt >= MAX_CLASSIFICATION_ATTEMPTS;
      const toStore: StoredChunkProgress = { hash, chunks: err.analyzedChunks };

      if (isFinalAttempt) {
        const failMessage =
          `Oversized article: needed ${err.totalChunkCount} chunk(s), only ` +
          `${err.processedChunkCount} analyzed across ${MAX_CLASSIFICATION_ATTEMPTS} attempts.`;
        console.warn("[classification] oversized article FAILED — attempt budget exhausted", {
          ...diag,
          elapsedMs,
          attempt,
          maxAttempts: MAX_CLASSIFICATION_ATTEMPTS,
          chunkCount: err.totalChunkCount,
          processedChunkCount: err.processedChunkCount,
          remainingChunkCount,
        });
        tracer.fail("CLASSIFICATION_TIMEOUT", failMessage);
        const written = await db.feedItem.updateMany({
          where: {
            id: item.id,
            classificationStatus: "classifying",
            classificationLeaseExpiresAt: leaseExpiresAt,
          },
          data: {
            classificationStatus: "failed",
            classificationError: failMessage,
            classificationLeaseExpiresAt: null,
            // Preserved even on a terminal failure: the analyses already paid
            // for are still valid evidence should the item ever be reopened
            // (a topic-settings change reopens `failed` rows too), and
            // discarding them would force paying for the same chunks again.
            // Cast: Prisma's InputJsonObject requires an index signature that
            // a typed interface like StoredChunkProgress does not carry; the
            // shape itself (a plain hash + a map of chunk analyses, all
            // strings/arrays) is valid JSON.
            classificationChunkProgress: toStore as unknown as Prisma.InputJsonValue,
          },
        });
        if (written.count === 0) return { status: "skipped", reason: "claimed" };
        return { status: "failed", error: failMessage };
      }

      // More attempts remain — bank progress and release the claim immediately
      // (back to `pending`, no backoff: this is not a fault) so the very next
      // selection resumes right where this call stopped.
      console.info("[classification] chunked article progressing — resuming next run", {
        ...diag,
        elapsedMs,
        attempt,
        maxAttempts: MAX_CLASSIFICATION_ATTEMPTS,
        chunkCount: err.totalChunkCount,
        processedChunkCount: err.processedChunkCount,
        remainingChunkCount,
      });
      tracer.step({
        type: "retry",
        label: `Chunk analysis paused — ${err.processedChunkCount}/${err.totalChunkCount} done`,
        status: "failed",
        output: { reason: err.message, processedChunkCount: err.processedChunkCount },
      });
      const written = await db.feedItem.updateMany({
        where: {
          id: item.id,
          classificationStatus: "classifying",
          classificationLeaseExpiresAt: leaseExpiresAt,
        },
        data: {
          classificationStatus: "pending",
          classificationLeaseExpiresAt: null,
          classificationChunkProgress: toStore as unknown as Prisma.InputJsonValue,
        },
      });
      if (written.count === 0) return { status: "skipped", reason: "claimed" };
      return {
        status: "partial",
        processedChunkCount: err.processedChunkCount,
        totalChunkCount: err.totalChunkCount,
      };
    }

    const error = err instanceof Error ? err.message : "Unknown classification error.";
    tracer.fail(
      err instanceof ClassificationTimeoutError
        ? "CLASSIFICATION_TIMEOUT"
        : err instanceof UntrustworthyClassificationError
          ? "UNTRUSTWORTHY_CLASSIFICATION"
          : "CLASSIFICATION_TRANSPORT_ERROR",
      error
    );

    console.warn("[classification] FAILED", {
      ...diag,
      elapsedMs: now().getTime() - startedAtMs,
      timedOut: err instanceof ClassificationTimeoutError,
      emptyResponse: err instanceof ClassificationParseError,
      untrustworthy: err instanceof UntrustworthyClassificationError,
      error,
    });

    // Guarded by this run's lease, for the same reason the success write is. The
    // verdict columns are deliberately NOT touched: a failure leaves whatever was
    // last known (usually nothing) rather than writing a rejection. Chunk
    // progress IS written when present: this branch is also reached when every
    // chunk analyzed cleanly but the FINAL verdict call then failed (a timeout,
    // an untrustworthy reply) — without this, the chunks analyzed THIS attempt
    // would be silently thrown away even though they cost real model calls.
    const written = await db.feedItem.updateMany({
      where: {
        id: item.id,
        classificationStatus: "classifying",
        classificationLeaseExpiresAt: leaseExpiresAt,
      },
      data: {
        classificationStatus: "failed",
        classificationError: error,
        ...(bankedChunksForFailure && Object.keys(bankedChunksForFailure).length > 0
          ? {
              classificationChunkProgress: {
                hash,
                chunks: bankedChunksForFailure,
              } as unknown as Prisma.InputJsonValue,
            }
          : {}),
        classificationLeaseExpiresAt: null,
      },
    });
    if (written.count === 0) return { status: "skipped", reason: "claimed" };

    return { status: "failed", error };
  } finally {
    // In a `finally` so a timeout or an untrusted reply is on the record exactly
    // as fully as a verdict — a failure here leaves `classification` NULL, and
    // "why has this article no verdict" is what the trace has to answer.
    await tracer.flush();
  }
}
