import { prisma } from "@/lib/db/client";
import type { ILlmProvider } from "@/lib/ai/types";
import {
  buildTranslationPrompts,
  computeTranslationBackoff,
  computeTranslationHash,
  estimateTokenCount,
  isRetriableParseFailure,
  parseTranslationResponse,
  samplingForTry,
  TranslationParseError,
  TRANSLATION_JSON_SCHEMA,
  MAX_TRANSLATION_ATTEMPTS,
  MAX_TRANSLATION_OUTPUT_TOKENS,
  MAX_TRANSLATION_RETRIES,
  TRANSLATION_ATTEMPT_TIMEOUT_MS,
  TRANSLATION_ITEM_TIMEOUT_MS,
} from "@/lib/ai/feed-item-translation";
import { claimFeedItemForTranslation } from "@/lib/ai/feed-item-translation-claim";
import { resolveLlmSelection } from "./resolve-llm-selection.service";
import {
  buildSupportedProvider,
  ProviderNotAvailableError,
} from "@/lib/ai/llm/supported-providers";

/**
 * Translates one feed item into the source's target language (v2-4).
 *
 * Invariants:
 *   • `title`/`content` are never written here — the original article is source
 *     data. Output goes to the translated* columns only.
 *   • The provider is the admin default (see resolve-llm-selection.service.ts).
 *     Translation never passes a per-generation llmConfigId, and a provider that
 *     cannot be built is an error — never a silent swap to another provider.
 *   • Failures are recorded with a capped backoff rather than thrown, so one bad
 *     article cannot stall a cron run.
 */

export type TranslateFeedItemOutcome =
  | { status: "translated"; provider: string; model: string }
  /**
   * No LLM call was made because another run owns the item:
   *   • "unchanged"    — hash matches an already-completed translation;
   *   • "max_attempts" — the retry budget is exhausted;
   *   • "claimed"      — a concurrent run holds the atomic claim (in flight);
   *   • "superseded"   — a concurrent run finished/reclaimed it after this attempt started.
   */
  | { status: "skipped"; reason: "unchanged" | "max_attempts" | "claimed" | "superseded" }
  /** No admin default provider configured; deliberately does NOT count an attempt. */
  | { status: "no_provider" }
  | { status: "failed"; error: string; nextRetryAt: Date };

/** The FeedItem fields translation reads. */
export interface TranslatableItem {
  id: string;
  title: string | null;
  content: string | null;
  /** The article's own URL — logged for diagnostics so a hang/timeout is traceable. */
  url: string;
  translationStatus: string | null;
  translationHash: string | null;
  translationAttemptCount: number;
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
}

/** One model call (or one item) exceeded its wall-clock budget. */
export class TranslationTimeoutError extends Error {
  readonly code = "TRANSLATION_TIMEOUT" as const;
  constructor(ms: number, scope: "attempt" | "item") {
    super(`Translation ${scope} exceeded its ${ms}ms budget.`);
    this.name = "TranslationTimeoutError";
  }
}

/**
 * Rejects with a {@link TranslationTimeoutError} if `work` has not settled within `ms`.
 *
 * The underlying request is NOT cancelled — the provider owns its own AbortSignal and will
 * tear the socket down at its own (much longer) cap. This bound exists so a hung article
 * stops occupying the batch, not to manage the socket: control returns immediately, the item
 * is recorded failed, and the run moves to the next article. A late settle is swallowed
 * rather than surfacing as an unhandled rejection.
 */
function withTimeout<T>(work: Promise<T>, ms: number, scope: "attempt" | "item"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TranslationTimeoutError(ms, scope)), ms);
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

  // Exhausted its budget: stays failed, never retried again.
  if (item.translationAttemptCount >= MAX_TRANSLATION_ATTEMPTS) {
    return { status: "skipped", reason: "max_attempts" };
  }

  const resolved = await resolveProvider();
  if (!resolved.ok) {
    // A missing admin default is an operator problem, not an article problem:
    // leave the item queued at its current attempt count so it translates
    // normally once a provider is configured.
    return { status: "no_provider" };
  }

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

  const { systemPrompt, userPrompt } = buildTranslationPrompts(
    item.title,
    item.content,
    targetLang
  );

  // Per-translation diagnostics. The article BODY is never logged — only its length —
  // so a request that hangs or times out can be tied to an exact feed item (id, title,
  // source URL) and correlated with prompt/article size, without dumping content.
  const diag = {
    feedItemId: item.id,
    title: item.title ?? "(untitled)",
    sourceUrl: item.url,
    promptLength: systemPrompt.length + userPrompt.length,
    articleTextLength: item.content?.length ?? 0,
    // Rough prompt-token estimate — carried on every log (start/success/failure) so a timeout
    // can be correlated with input size and the num_predict ceiling at a glance.
    promptTokenEstimate: estimateTokenCount(systemPrompt + userPrompt),
  };
  const startedAtMs = now().getTime();
  const attemptTimeoutMs = deps.attemptTimeoutMs ?? TRANSLATION_ATTEMPT_TIMEOUT_MS;
  const itemDeadlineMs = startedAtMs + (deps.itemTimeoutMs ?? TRANSLATION_ITEM_TIMEOUT_MS);
  const maxTries = MAX_TRANSLATION_RETRIES + 1;
  // Logged BEFORE the call so an item whose request hangs and never returns (e.g. process
  // killed or lease reaped) still leaves a line naming the exact in-flight feed item.
  console.info("[rss-translation] translating item", { ...diag, maxTries });

  // Declared outside the try so the failure log can report how many model calls were spent.
  let tries = 0;

  try {
    let translatedTitle: string | null = null;
    let translatedContent = "";
    let usedRepair = false;
    /** Raw provider payload of the try that SUCCEEDED — source of the Ollama metrics below. */
    let lastResponseRaw: unknown;

    // In-request regeneration loop. A bad reply from the self-hosted model (invalid JSON, a
    // decoding loop, drifted language) is usually transient, and a fresh sample seconds later
    // succeeds — far better than failing the item and waiting out a 5-minute backoff. Each try
    // varies the sampling (see samplingForTry): re-issuing the same prompt at temperature 0
    // would deterministically reproduce the same bad reply.
    for (let tryIndex = 0; tryIndex < maxTries; tryIndex += 1) {
      const remainingMs = itemDeadlineMs - now().getTime();
      if (remainingMs <= 0) {
        throw new TranslationTimeoutError(
          deps.itemTimeoutMs ?? TRANSLATION_ITEM_TIMEOUT_MS,
          "item"
        );
      }
      // Never let one try run past the item's own budget.
      const budgetMs = Math.min(attemptTimeoutMs, remainingMs);
      const { temperature, repeatPenalty } = samplingForTry(tryIndex);
      const tryStartedMs = now().getTime();
      tries = tryIndex + 1;

      console.info("[rss-translation] attempt", {
        feedItemId: item.id,
        try: tries,
        of: maxTries,
        temperature,
        repeatPenalty,
        budgetMs,
      });

      const response = await withTimeout(
        resolved.instance.generate({
          systemPrompt,
          userPrompt,
          // Schema-constrained structured output: the Ollama `format` schema makes the reply a
          // strict {title, content} object instead of free-form text. Temperature starts at 0
          // for fidelity and rises only on a regeneration.
          temperature,
          repeatPenalty,
          format: TRANSLATION_JSON_SCHEMA,
          // Bounded generation: without this Ollama runs unlimited and a runaway article never
          // returns within the deadline. The capped body fits well under this ceiling.
          maxTokens: MAX_TRANSLATION_OUTPUT_TOKENS,
        }),
        budgetMs,
        "attempt"
      );

      try {
        ({ translatedTitle, translatedContent, usedRepair } = parseTranslationResponse(
          response.text,
          targetLang
        ));
        lastResponseRaw = response.raw;
        break;
      } catch (parseErr) {
        // The transport succeeded (HTTP 200) but the reply was rejected. Log the SHAPE of the
        // raw output — first/last 200 chars and total length only, never the full body — plus
        // the failure `reason` so the modes are distinguishable: invalid JSON, a
        // schema-validation failure, wrong-language output, or a repetition loop.
        const text = response.text ?? "";
        const reason = parseErr instanceof TranslationParseError ? parseErr.reason : "invalid_json";
        const willRetry = isRetriableParseFailure(reason) && tryIndex < maxTries - 1;
        console.warn("[rss-translation] unusable model response", {
          ...diag,
          try: tries,
          of: maxTries,
          reason,
          willRetry,
          ...(parseErr instanceof TranslationParseError && parseErr.repetition
            ? {
                repetitionKind: parseErr.repetition.kind,
                repetitionSample: parseErr.repetition.sample.slice(0, 40),
                repetitionCount: parseErr.repetition.count,
              }
            : {}),
          elapsedMs: now().getTime() - tryStartedMs,
          responseLength: text.length,
          responseFirst200: text.slice(0, 200),
          responseLast200: text.length > 200 ? text.slice(-200) : "",
          error: parseErr instanceof Error ? parseErr.message : String(parseErr),
        });
        // Retries exhausted (or a reason regeneration cannot fix) — record the failure.
        if (!willRetry) throw parseErr;
      }
    }

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
        translationProvider: resolved.provider,
        translationModel: resolved.model,
        translationError: null,
        translationNextRetryAt: null,
        translationLeaseExpiresAt: null,
      },
    });

    console.info("[rss-translation] item translated", {
      ...diag,
      elapsedMs: now().getTime() - startedAtMs,
      // How many model calls this item actually cost — >1 means a regeneration was needed.
      tries,
      provider: resolved.provider,
      model: resolved.model,
      // When true, structured output was NOT clean and the defensive repair salvaged the
      // reply — a signal that Ollama's `format` may not be honoured for this model/worker.
      usedRepair,
      completionTokenEstimate: estimateTokenCount(translatedContent + (translatedTitle ?? "")),
      // Ollama's own generation metrics when the worker forwards them: total/eval/prompt-eval
      // durations (ms) plus exact token counts and the stop reason. done_reason="length" means
      // the num_predict ceiling was hit (the runaway case we now bound); "stop" is a clean end.
      ...ollamaMetrics(lastResponseRaw),
    });

    return { status: "translated", provider: resolved.provider, model: resolved.model };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown translation error.";
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
  }
}
