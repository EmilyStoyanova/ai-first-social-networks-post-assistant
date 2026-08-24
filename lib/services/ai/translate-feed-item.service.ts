import { prisma } from "@/lib/db/client";
import { Prisma } from "@prisma/client";
import type { ILlmProvider } from "@/lib/ai/types";
import type { TranslationReplyMode } from "@/lib/ai/feed-item-translation";
import {
  buildTranslationPrompts,
  classifyTranslationInput,
  computeTranslationBackoff,
  computeTranslationHash,
  estimateTokenCount,
  TranslationParseError,
  MAX_TRANSLATION_ATTEMPTS,
  TRANSLATION_ATTEMPT_TIMEOUT_MS,
  TRANSLATION_ITEM_TIMEOUT_MS,
} from "@/lib/ai/feed-item-translation";
import { claimFeedItemForTranslation } from "@/lib/ai/feed-item-translation-claim";
import { resolveLlmSelection } from "./resolve-llm-selection.service";
import {
  buildSupportedProvider,
  ProviderNotAvailableError,
} from "@/lib/ai/llm/supported-providers";
import { GenerationTracer } from "@/lib/generation-trace/tracer";
import type {
  ArticleTranslation,
  ArticleTranslationContext,
  TranslationProvider,
} from "@/lib/ai/translation/translation-provider";
import {
  MadladPartialProgressError,
  TranslationTransportError,
} from "@/lib/ai/translation/translation-provider";
import {
  buildOllamaTranslationProvider,
  buildTranslationProvider,
} from "@/lib/ai/translation/translation-provider-factory";
import type { EnvLike } from "@/lib/ai/translation/translation-provider-config";
import { TranslationTimeoutError } from "@/lib/ai/translation/translation-timeout";

/**
 * Translates one feed item into the source's target language (v2-4).
 *
 * Invariants:
 *   • `title`/`content` are never written here — the original article is source
 *     data. Output goes to the translated* columns only.
 *   • Nothing is ever asked of the model that the source cannot answer. An item with
 *     no article body is translated as a TITLE ONLY, and one with no text at all is
 *     settled as `skipped` without a model call — so no reply can be a fabricated
 *     article, and no retry is spent on a source that is simply missing.
 *   • The provider is the admin default (see resolve-llm-selection.service.ts).
 *     Translation never passes a per-generation llmConfigId, and a provider that
 *     cannot be built is an error — never a silent swap to another provider.
 *   • Failures are recorded with a capped backoff rather than thrown, so one bad
 *     article cannot stall a cron run.
 */

export type TranslateFeedItemOutcome =
  | {
      status: "translated";
      provider: string;
      model: string;
      /** "title_only" when the article had no body — the translation carries no content. */
      mode: TranslationReplyMode;
    }
  /**
   * MADLAD stopped after `processedBatchCount` of `totalBatchCount` HTTP batches — an
   * article too large for one item budget. NOT a failure: real progress was banked and
   * the claim was released back to `pending` (no backoff) so the very next selection
   * resumes exactly here. See MadladPartialProgressError and `translationProgress`.
   */
  | { status: "partial"; processedBatchCount: number; totalBatchCount: number }
  /**
   * No LLM call was made:
   *   • "unchanged"    — hash matches an already-completed translation;
   *   • "empty_source" — the item has neither a title nor an article body to translate;
   *   • "max_attempts" — the retry budget is exhausted;
   *   • "claimed"      — a concurrent run holds the atomic claim (in flight);
   *   • "superseded"   — a concurrent run finished/reclaimed it after this attempt started.
   */
  | {
      status: "skipped";
      reason: "unchanged" | "empty_source" | "max_attempts" | "claimed" | "superseded";
    }
  /** No admin default provider configured; deliberately does NOT count an attempt. */
  | { status: "no_provider" }
  | { status: "failed"; error: string; nextRetryAt: Date };

/** The FeedItem fields translation reads. */
export interface TranslatableItem {
  id: string;
  /**
   * Which company this article belongs to. Read only so the trace run can be
   * filed under it — nothing in translation branches on it, and it is optional
   * so a caller assembled before tracing existed stays valid.
   */
  companyId?: string;
  title: string | null;
  content: string | null;
  /** The article's own URL — logged for diagnostics so a hang/timeout is traceable. */
  url: string;
  translationStatus: string | null;
  translationHash: string | null;
  translationAttemptCount: number;
  /**
   * Raw MADLAD batch progress banked by an earlier, capped call for THIS attempt
   * sequence — see the schema comment on FeedItem.translationProgress. `null`/absent
   * for every item that has never been capped mid-translation (i.e. almost all of
   * them), in which case translation proceeds exactly as it always has.
   */
  translationProgress?: Record<string, string> | null;
}

/** Narrow DB surface — real Prisma satisfies it; tests inject a fake. */
export interface TranslateFeedItemDb {
  feedItem: {
    update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
    /**
     * Conditional write used for BOTH the atomic claim and the guarded failure write.
     * Each is an `UPDATE ... WHERE <still-eligible>` returning the number of rows
     * actually changed, so a run can tell whether it still owns the item (count 1) or
     * a concurrent run took it (count 0).
     */
    updateMany: (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
  };
}

export interface TranslateFeedItemDeps {
  db?: TranslateFeedItemDb;
  /** Resolves the provider instance + provenance. Defaults to the admin default. */
  resolveProvider?: () => Promise<
    { ok: true; instance: ILlmProvider; provider: string; model: string } | { ok: false }
  >;
  now?: () => Date;
  /** Wall-clock cap for ONE model call. Overridable so tests need not wait 90s. */
  attemptTimeoutMs?: number;
  /** Wall-clock cap for the whole item, across all in-request retries. */
  itemTimeoutMs?: number;
  /**
   * The trace recorder for this translation. Injected in tests; production
   * starts its own run. Observation only — nothing here branches on it.
   */
  tracer?: GenerationTracer;
  /**
   * Where the ENGINE selection is read from. Defaults to `process.env`, which is the
   * only thing production ever passes; injected so a test can exercise
   * `TRANSLATION_PROVIDER=madlad` without mutating the process for every other test
   * running beside it.
   */
  env?: EnvLike;
  /**
   * MADLAD-only: caps how many NEW HTTP batches this call may start — see
   * ArticleTranslationContext.maxBatchesThisCall. Set by `translate-feed-items.service.ts`
   * for an article whose estimate exceeds one item budget; `undefined` for every other
   * article, which behaves exactly as before.
   */
  maxBatchesThisCall?: number;
}

// Moved to lib/ai/translation/translation-timeout.ts so a provider can enforce its own
// per-call budget without importing this service. Re-exported because it is part of this
// module's published surface.
export { TranslationTimeoutError };

async function defaultResolveProvider(): Promise<
  { ok: true; instance: ILlmProvider; provider: string; model: string } | { ok: false }
> {
  // No llmConfigId/preference: translation is system work, so it uses the admin
  // default exactly like cron generation does.
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
    // Active provider whose env config is absent — report unavailable rather
    // than falling back to a different provider.
    if (err instanceof ProviderNotAvailableError) return { ok: false };
    throw err;
  }
}

/**
 * Extracts Ollama's generation metrics from the provider's raw response, when present.
 * Durations arrive in nanoseconds (Ollama's unit) and are converted to whole milliseconds;
 * counts and the stop reason pass through as-is. Returns {} for any provider (e.g. Groq) or
 * worker that does not forward these fields, so logging never breaks on a plain {text} reply.
 */
function ollamaMetrics(raw: unknown): Record<string, number | string> {
  if (raw === null || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const ms = (ns: unknown): number | undefined =>
    typeof ns === "number" ? Math.round(ns / 1e6) : undefined;
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

  const out: Record<string, number | string> = {};
  const total = ms(r.total_duration);
  const evalMs = ms(r.eval_duration);
  const promptEvalMs = ms(r.prompt_eval_duration);
  const evalCount = num(r.eval_count);
  const promptEvalCount = num(r.prompt_eval_count);
  if (total !== undefined) out.ollamaTotalMs = total;
  if (evalMs !== undefined) out.ollamaEvalMs = evalMs;
  if (promptEvalMs !== undefined) out.ollamaPromptEvalMs = promptEvalMs;
  if (evalCount !== undefined) out.ollamaEvalCount = evalCount;
  if (promptEvalCount !== undefined) out.ollamaPromptEvalCount = promptEvalCount;
  if (typeof r.done_reason === "string") out.ollamaDoneReason = r.done_reason;
  return out;
}

export async function translateFeedItem(
  item: TranslatableItem,
  targetLang: string,
  deps: TranslateFeedItemDeps = {}
): Promise<TranslateFeedItemOutcome> {
  const db = deps.db ?? prisma;
  const now = deps.now ?? (() => new Date());
  const resolveProvider = deps.resolveProvider ?? defaultResolveProvider;

  const hash = computeTranslationHash(item.title, item.content, targetLang);

  // Nothing changed since the last successful translation — no LLM call.
  if (item.translationHash === hash && item.translationStatus === "completed") {
    return { status: "skipped", reason: "unchanged" };
  }

  const inputKind = classifyTranslationInput(item.title, item.content);

  // There is nothing to translate. Ingestion legitimately stores bodyless items (a paywall
  // stub, a failed fetch, a feed entry with no summary), and one with no title either has no
  // text at all. Asking a translator for {title, content} here produced exactly what the logs
  // showed: an empty `content`, rejected, regenerated twice, rejected again, then a failure
  // with a backoff — three model calls spent on a defect no sample can fix. So the item is
  // settled here instead, WITHOUT a provider, a claim, an attempt, or a retry. `skipped` is
  // the existing terminal state for "this item is not translated" — it is not selectable by
  // the cron, and the UI already reads it as "original", which is exactly what generation
  // will use. The hash is stored so re-ingesting the same empty article changes nothing.
  if (inputKind === "empty") {
    const settled = await db.feedItem.updateMany({
      where: {
        id: item.id,
        OR: [
          { translationStatus: { in: ["pending", "failed", "translating"] } },
          // A previously completed translation whose article has since lost its text.
          { translationStatus: "completed", translationHash: { not: hash } },
        ],
      },
      data: {
        translationStatus: "skipped",
        translationHash: hash,
        translationLanguage: targetLang,
        translationError: null,
        translationNextRetryAt: null,
        translationLeaseExpiresAt: null,
      },
    });
    console.info("[rss-translation] nothing to translate — skipping without a model call", {
      feedItemId: item.id,
      sourceUrl: item.url,
      reason: "empty_source",
      articleTextLength: item.content?.length ?? 0,
      hasTitle: false,
      settled: settled.count === 1,
    });
    return { status: "skipped", reason: "empty_source" };
  }

  // Exhausted its budget: stays failed, never retried again.
  if (item.translationAttemptCount >= MAX_TRANSLATION_ATTEMPTS) {
    return { status: "skipped", reason: "max_attempts" };
  }

  // Which ENGINE translates (ollama | madlad) is decided here, once, from the environment.
  // With TRANSLATION_PROVIDER unset this resolves to exactly the path that has always run.
  const built = await buildTranslationProvider({ resolveLlm: resolveProvider, env: deps.env });
  if (!built.ok) {
    // A missing admin default — or a MADLAD selection with no text worker configured — is an
    // operator problem, not an article problem: leave the item queued at its current attempt
    // count so it translates normally once a provider is configured.
    console.warn("[rss-translation] no translation provider available", {
      feedItemId: item.id,
      engine: built.config.kind,
      reason: built.reason,
    });
    return { status: "no_provider" };
  }
  let translator: TranslationProvider = built.provider;

  const attempt = item.translationAttemptCount + 1;

  // Atomically CLAIM the item before calling out. This is the single point that makes
  // translation safe under concurrency: the scheduled cron and a continuation job select
  // candidates with no lock, so both can hold this same item — but only one wins the
  // conditional write below. The winner flips the row to `translating`, stamps a lease,
  // stores the input hash, and counts the attempt exactly once; the loser matches no row
  // and skips WITHOUT calling the LLM. This eliminates duplicate calls, double attempt
  // increments, and the racing writes at their source. A crashed claim self-recovers once
  // its lease expires (see feed-item-translation-claim.ts). The lease is reused below as a
  // fencing token so a stale attempt can never clobber a fresher claim or a completion.
  const claimAt = now();
  const { claimed, leaseExpiresAt } = await claimFeedItemForTranslation(db, {
    id: item.id,
    hash,
    targetLang,
    now: claimAt,
  });
  if (!claimed) {
    console.info("[rss-translation] item already claimed by another run — skipping", {
      feedItemId: item.id,
      sourceUrl: item.url,
    });
    return { status: "skipped", reason: "claimed" };
  }

  // Built here, not inside the engine, so the trace's `source` step and whatever the
  // engine sends can never disagree about which article text was actually used. The
  // prompt-based engine sends this bundle as-is; MADLAD reads only `mode` from it and
  // works from the raw title/content.
  const prompts = buildTranslationPrompts(item.title, item.content, targetLang);
  const { systemPrompt, userPrompt, mode, contentChars, derivedTitle } = prompts;

  // ── Trace ─────────────────────────────────────────────────────────────────
  // Started only HERE, after the claim, because everything above returns without
  // calling a model — and a run recorded for "nothing to do" would sit in front
  // of the real translation as the most recent one, which is what a post's trace
  // links to. A run therefore exists if and only if a model was asked something.
  const tracer =
    deps.tracer ??
    GenerationTracer.start({
      kind: "translation",
      trigger: "system",
      companyId: item.companyId ?? null,
      feedItemId: item.id,
      language: targetLang,
      options: { targetLang, mode, attempt, maxAttempts: MAX_TRANSLATION_ATTEMPTS },
    });
  // Set explicitly rather than only through the init above, so an injected
  // tracer (tests, and any future caller that owns the run) is filed under the
  // same company and model as one this function started itself.
  tracer.setCompany(item.companyId);
  tracer.setLanguage(targetLang);
  tracer.setLlm(translator.providerLabel, translator.model);
  tracer.step({
    type: "request",
    label: `Translate article to ${targetLang}`,
    input: { feedItemId: item.id, url: item.url, targetLang, mode, attempt },
    metadata: {
      inputKind,
      derivedTitle,
      contentHash: hash,
      // Which ENGINE ran, spelled out, because `providerLabel` alone cannot say it:
      // both engines are served by the text worker, so without this a MADLAD run and a
      // Qwen run are not distinguishable in a trace.
      translationEngine: translator.kind,
      translationProvider: translator.providerLabel,
      translationModel: translator.model,
    },
  });
  tracer.step({
    type: "source",
    label: "Original article",
    output: { title: item.title, content: item.content, url: item.url },
    metadata: {
      titleChars: item.title?.length ?? 0,
      contentChars: item.content?.length ?? 0,
      // How much of the page survived boilerplate/credit removal and capping —
      // compared against contentChars it says how much was noise.
      bodyCharsSent: contentChars,
      truncatedForPrompt: (item.content?.length ?? 0) > contentChars,
    },
  });

  // Per-translation diagnostics. The article BODY is never logged — only its length —
  // so a request that hangs or times out can be tied to an exact feed item (id, title,
  // source URL) and correlated with prompt/article size, without dumping content.
  const diag = {
    feedItemId: item.id,
    title: item.title ?? "(untitled)",
    sourceUrl: item.url,
    promptLength: systemPrompt.length + userPrompt.length,
    articleTextLength: item.content?.length ?? 0,
    // Body characters actually sent, AFTER boilerplate/credit/language-switcher removal and
    // capping. Compared against articleTextLength it shows how much of a page was noise —
    // the ArchDaily articles in the logs were roughly half.
    translatedBodyChars: contentChars,
    // The article had no title of its own, so the model was asked to derive one from the body
    // rather than return "" — the `(untitled)` rows.
    ...(derivedTitle ? { derivedTitle: true } : {}),
    // "title_only" says, in one field, that this item had no article body — the reply
    // contract, the stored result and the retry budget all follow from it.
    mode,
    // Rough prompt-token estimate — carried on every log (start/success/failure) so a timeout
    // can be correlated with input size and the num_predict ceiling at a glance.
    promptTokenEstimate: estimateTokenCount(systemPrompt + userPrompt),
    // The engine and the exact model, on EVERY line this article produces. Without it a
    // log tells you an article failed but not which translator failed it, which is the
    // one thing you need when two engines are being compared.
    translationEngine: translator.kind,
    translationProvider: translator.providerLabel,
    translationModel: translator.model,
  };
  const startedAtMs = now().getTime();
  const attemptTimeoutMs = deps.attemptTimeoutMs ?? TRANSLATION_ATTEMPT_TIMEOUT_MS;
  const itemDeadlineMs = startedAtMs + (deps.itemTimeoutMs ?? TRANSLATION_ITEM_TIMEOUT_MS);
  const maxTries = translator.maxTries;
  // The one line an operator greps for to answer "which translator is actually running?".
  // All three facts, because no two of them imply the third: both engines are served by
  // the text worker, and one worker could serve either model.
  console.info(
    `[rss-translation] Translation Engine: ${translator.kind} | ` +
      `Provider: ${translator.providerLabel} | Model: ${translator.model}`
  );
  // Logged BEFORE the call so an item whose request hangs and never returns (e.g. process
  // killed or lease reaped) still leaves a line naming the exact in-flight feed item.
  console.info("[rss-translation] translating item", { ...diag, maxTries });

  // Declared outside the delegated call so the failure log can report how many model
  // calls were spent — a return value cannot answer that when the engine throws.
  let tries = 0;
  /**
   * Set only when a TECHNICAL MADLAD failure was retried on the other engine. Carried to
   * the trace, the success log and the failure log, because "this article is Qwen output
   * even though the deployment says MADLAD" is invisible otherwise — and it is exactly
   * the thing that would quietly poison a MADLAD-vs-Qwen comparison.
   */
  let fallback: { from: string; to: string; reason: string } | null = null;

  try {
    // ── The one delegated step ────────────────────────────────────────────────
    // Everything around it belongs to the ITEM (claim, attempts, backoff, trace,
    // persistence) and is identical whichever engine ran. Everything inside belongs to
    // the ENGINE: how it is prompted, whether it regenerates, and what it accepts.
    const request = {
      feedItemId: item.id,
      url: item.url,
      title: item.title,
      content: item.content,
      targetLang,
      mode,
      prompts,
    };
    const contextFor = (engine: TranslationProvider): ArticleTranslationContext => ({
      tracer,
      now,
      diag: {
        ...diag,
        translationEngine: engine.kind.toUpperCase(),
        translationModel: engine.model,
      },
      attemptTimeoutMs,
      itemDeadlineMs,
      itemTimeoutMs: deps.itemTimeoutMs ?? TRANSLATION_ITEM_TIMEOUT_MS,
      reportTry: (n: number) => {
        tries = n;
      },
      maxBatchesThisCall: deps.maxBatchesThisCall,
      resumeSegments: item.translationProgress ?? undefined,
    });

    let result: ArticleTranslation;
    try {
      result = await translator.translate(request, contextFor(translator));
    } catch (err) {
      // ── Fallback, narrowly ──────────────────────────────────────────────────
      // ONLY a technical fault (unreachable worker, non-2xx, malformed envelope,
      // timeout) may be retried on another engine, ONLY when explicitly enabled, and
      // never silently. A rejected TRANSLATION is not a fault — it is the engine's
      // answer, and swapping engines behind it would hide exactly what a MADLAD trial
      // exists to measure. TranslationParseError is therefore deliberately absent from
      // the condition below: a bad translation fails the item, as it always has.
      const technical =
        err instanceof TranslationTransportError || err instanceof TranslationTimeoutError;
      const replacement =
        translator.kind === "madlad" && built.config.fallbackToOllamaOnTransportError && technical
          ? await buildOllamaTranslationProvider({ resolveLlm: resolveProvider, env: deps.env })
          : null;
      if (!replacement) throw err;

      const reason = err instanceof Error ? err.message : String(err);
      fallback = {
        from: `madlad (${translator.model})`,
        to: `${replacement.kind} (${replacement.model})`,
        reason,
      };
      console.warn(`[rss-translation] MADLAD FAILED TECHNICALLY — falling back to ${fallback.to}`, {
        ...diag,
        fallbackUsed: true,
        ...fallback,
        error: reason,
      });
      tracer.step({
        type: "retry",
        label: `MADLAD unavailable — falling back to ${fallback.to}`,
        status: "failed",
        output: { fallbackUsed: true, ...fallback },
        error: err,
      });

      // Provenance follows the engine that actually produced the text; otherwise the
      // stored provider/model would name an engine that never ran.
      translator = replacement;
      tracer.setLlm(replacement.providerLabel, replacement.model);
      tries = 0;
      result = await translator.translate(request, contextFor(translator));
    }

    const { translatedTitle, translatedContent, usedRepair, repairs } = result;
    /** HTTP calls to the model. Differs from `tries` for the segment-at-a-time engine. */
    const modelCalls = result.modelCalls ?? result.tries;
    /** Raw provider payload of the try that SUCCEEDED — source of the Ollama metrics below. */
    const lastResponseRaw = result.raw;
    tries = result.tries;

    // Success is written UNCONDITIONALLY by id and always wins: a genuine, completed
    // translation is the outcome we most want to keep, even if a lease-expiry hand-off
    // means a second run is also working on the item. Clearing the lease marks the claim
    // released.
    await db.feedItem.update({
      where: { id: item.id },
      data: {
        translatedTitle,
        translatedContent,
        translationLanguage: targetLang,
        translationStatus: "completed",
        translationHash: hash,
        translatedAt: now(),
        translationProvider: translator.providerLabel,
        translationModel: translator.model,
        translationError: null,
        translationNextRetryAt: null,
        translationLeaseExpiresAt: null,
      },
    });

    tracer.step({
      type: "persistence",
      label: "Translation stored",
      output: { translatedTitle, translatedContent, targetLang },
      metadata: {
        engine: translator.kind,
        provider: translator.providerLabel,
        model: translator.model,
        mode,
        tries,
        modelCalls,
        translationHash: hash,
        // Present and true only on the narrow technical-fallback path, so a reader of
        // this run never has to infer which engine's text they are looking at.
        ...(fallback
          ? { fallbackUsed: true, fallbackFrom: fallback.from, fallbackTo: fallback.to }
          : { fallbackUsed: false }),
      },
    });

    console.info("[rss-translation] item translated", {
      ...diag,
      elapsedMs: now().getTime() - startedAtMs,
      // How many attempts this item cost — >1 means a regeneration was needed — and how
      // many HTTP calls that came to, which for the segment-at-a-time engine is one per
      // segment rather than one per attempt.
      tries,
      modelCalls,
      provider: translator.providerLabel,
      model: translator.model,
      ...(fallback
        ? { fallbackUsed: true, fallbackFrom: fallback.from, fallbackReason: fallback.reason }
        : {}),
      // When true, structured output was NOT clean and the defensive repair salvaged the
      // reply — a signal that Ollama's `format` may not be honoured for this model/worker.
      usedRepair,
      // Exactly WHICH salvage was needed (a <think> block, a fence, a missing brace, a
      // string closed after a truncation) — the actionable half of usedRepair.
      ...(repairs.length > 0 ? { repairs } : {}),
      // Null on a title-only translation: the article had no body, so neither has this.
      translatedContentLength: translatedContent?.length ?? null,
      completionTokenEstimate: estimateTokenCount(
        (translatedContent ?? "") + (translatedTitle ?? "")
      ),
      // Ollama's own generation metrics when the worker forwards them: total/eval/prompt-eval
      // durations (ms) plus exact token counts and the stop reason. done_reason="length" means
      // the num_predict ceiling was hit (the runaway case we now bound); "stop" is a clean end.
      ...ollamaMetrics(lastResponseRaw),
    });

    return {
      status: "translated",
      provider: translator.providerLabel,
      model: translator.model,
      mode,
    };
  } catch (err) {
    if (err instanceof MadladPartialProgressError) {
      // NOT a failure — see MadladPartialProgressError's own comment. The batches that
      // ran succeeded; what happens next depends only on whether this claim's attempt
      // was the item's last one.
      const elapsedMs = now().getTime() - startedAtMs;
      const remainingBatchCount = err.totalBatchCount - err.processedBatchCount;
      const isFinalAttempt = attempt >= MAX_TRANSLATION_ATTEMPTS;

      if (isFinalAttempt) {
        // Exhausted its cross-run attempt budget before every batch ran — a genuinely
        // oversized article, not a loop: this is the EXPLICIT failure the invariant
        // requires instead of banking progress forever. `translationProgress` is
        // cleared so a future re-translation of this exact item (e.g. after the
        // worker's batch size or timeout budget changes) starts clean rather than
        // resuming from a stale, possibly-mismatched partial state.
        const failMessage =
          `Oversized article: needed ${err.totalBatchCount} MADLAD HTTP batch(es), only ` +
          `${err.processedBatchCount} completed across ${MAX_TRANSLATION_ATTEMPTS} attempts.`;
        console.warn("[rss-translation] oversized article FAILED — attempt budget exhausted", {
          ...diag,
          elapsedMs,
          attempt,
          maxAttempts: MAX_TRANSLATION_ATTEMPTS,
          batchCount: err.totalBatchCount,
          processedBatchCount: err.processedBatchCount,
          remainingBatchCount,
          progressMade: true,
          continuationReason: "attempt_budget_exhausted",
        });
        tracer.fail("TRANSLATION_TIMEOUT", failMessage);
        const nextRetryAt = computeTranslationBackoff(attempt, now());
        const written = await db.feedItem.updateMany({
          where: {
            id: item.id,
            translationStatus: "translating",
            translationLeaseExpiresAt: leaseExpiresAt,
          },
          data: {
            translationStatus: "failed",
            translationError: failMessage,
            translationNextRetryAt: nextRetryAt,
            translationLeaseExpiresAt: null,
            translationProgress: Prisma.JsonNull,
          },
        });
        if (written.count === 0) {
          console.info("[rss-translation] failure superseded by a concurrent run", { ...diag });
          return { status: "skipped", reason: "superseded" };
        }
        return { status: "failed", error: failMessage, nextRetryAt };
      }

      // More attempts remain — bank progress and release the claim immediately (no
      // backoff: this is not a fault) so the very next selection resumes right where
      // this call stopped instead of re-translating batches that already succeeded.
      console.info("[rss-translation] MADLAD article progressing — resuming next run", {
        ...diag,
        elapsedMs,
        attempt,
        maxAttempts: MAX_TRANSLATION_ATTEMPTS,
        batchCount: err.totalBatchCount,
        processedBatchCount: err.processedBatchCount,
        remainingBatchCount,
        progressMade: true,
        continuationReason: "batch_cap_reached",
      });
      const written = await db.feedItem.updateMany({
        where: {
          id: item.id,
          translationStatus: "translating",
          translationLeaseExpiresAt: leaseExpiresAt,
        },
        data: {
          translationStatus: "pending",
          translationProgress: err.translatedSegments,
          translationNextRetryAt: null,
          translationLeaseExpiresAt: null,
        },
      });
      if (written.count === 0) {
        console.info("[rss-translation] progress superseded by a concurrent run", { ...diag });
        return { status: "skipped", reason: "superseded" };
      }
      return {
        status: "partial",
        processedBatchCount: err.processedBatchCount,
        totalBatchCount: err.totalBatchCount,
      };
    }

    const error = err instanceof Error ? err.message : "Unknown translation error.";
    tracer.fail(
      err instanceof TranslationTimeoutError
        ? "TRANSLATION_TIMEOUT"
        : err instanceof TranslationParseError
          ? `TRANSLATION_${err.reason.toUpperCase()}`
          : "TRANSLATION_TRANSPORT_ERROR",
      error
    );
    const nextRetryAt = computeTranslationBackoff(attempt, now());

    // Names the exact feed item that failed (e.g. a >300s text-worker timeout) with how
    // long it ran and the error, so a hang is pinned to one article, not the whole batch.
    console.warn("[rss-translation] item translation FAILED", {
      ...diag,
      elapsedMs: now().getTime() - startedAtMs,
      tries,
      // Distinguishes "ran out of time" from "the model kept returning unusable output" —
      // the two need different operator responses (worker capacity vs. model/prompt quality).
      timedOut: err instanceof TranslationTimeoutError,
      // The final rejection reason when the model's output was the problem, so a run's
      // failures can be counted by cause without re-reading every warning above them.
      failureReason: err instanceof TranslationParseError ? err.reason : "transport",
      // A failure AFTER a fallback means both engines failed — a different situation
      // from either one failing alone, and one nobody would guess from this line.
      ...(fallback
        ? { fallbackUsed: true, fallbackFrom: fallback.from, fallbackReason: fallback.reason }
        : {}),
      error,
    });

    // Guarded write (defense in depth on top of the claim): only record the failure while
    // this run still holds ITS claim — the row is `translating` AND carries the exact lease
    // this attempt stamped. The lease acts as a fencing token, so the failure lands only if
    // nothing displaced us. It matches no row when a concurrent run has since completed the
    // item (status → completed) or reclaimed an expired lease (a different lease value); in
    // either case we must NOT overwrite their state with a stale "failed", which is precisely
    // the bug where the UI showed "Translation failed" for an item that was actually translated.
    const written = await db.feedItem.updateMany({
      where: {
        id: item.id,
        translationStatus: "translating",
        translationLeaseExpiresAt: leaseExpiresAt,
      },
      data: {
        translationStatus: "failed",
        translationError: error,
        translationNextRetryAt: nextRetryAt,
        translationLeaseExpiresAt: null,
      },
    });

    if (written.count === 0) {
      // Another run finished or reclaimed this item after our attempt started — its state
      // stands. Report skipped (not failed): this run translated nothing, and the run that
      // owns the item now is the one that counts its outcome.
      console.info("[rss-translation] failure superseded by a concurrent run", { ...diag });
      return { status: "skipped", reason: "superseded" };
    }

    return { status: "failed", error, nextRetryAt };
  } finally {
    // In a `finally` so a run that timed out, threw, or was superseded is on the
    // record just as fully as one that succeeded — those are the ones somebody
    // is trying to explain.
    await tracer.flush();
  }
}
