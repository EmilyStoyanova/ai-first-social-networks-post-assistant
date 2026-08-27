import type { ILlmProvider } from "@/lib/ai/types";
import {
  buildContentChunkPrompt,
  buildTranslationPrompts,
  buildTranslationRetryPrompt,
  isRetriableParseFailure,
  parseTranslationResponse,
  samplingForTry,
  shrinkTranslationContentBudget,
  TranslationParseError,
  MAX_TRANSLATION_CONTENT_CHARS,
  MAX_TRANSLATION_OUTPUT_TOKENS,
  MAX_TRANSLATION_RETRIES,
  MIN_TRANSLATION_CONTENT_CHARS,
  type JsonRepair,
  type TranslationParseFailure,
} from "@/lib/ai/feed-item-translation";
import type {
  ArticleTranslation,
  ArticleTranslationContext,
  ArticleTranslationRequest,
  TranslationProvider,
} from "./translation-provider";
import { TranslationPartialProgressError } from "./translation-provider";
import { TranslationTimeoutError, withTranslationTimeout } from "./translation-timeout";
import { protectTokens, restoreTokens, type ProtectedValue } from "./protected-tokens";
import { isDataOnlySegment } from "./segment-repair";
import {
  chunkArticleForTranslation,
  reassembleChunkedTranslation,
  shouldChunkForTranslation,
} from "./ollama-chunking";

/**
 * The prompt-based translation engine — the one this pipeline has always used.
 *
 * This is a MOVE, not a rewrite: the in-request regeneration loop, its sampling
 * schedule, its truncation shrink, its trace steps and its log lines are the same
 * ones that ran before the provider abstraction existed. Nothing about the default
 * path changed; it simply now sits behind an interface so a second engine can sit
 * beside it.
 *
 * It is called "ollama" after the engine class, not the transport: whichever LLM
 * provider the admin default resolves to is what runs here, which today is the
 * self-hosted text worker fronting Ollama. The exact model is a deployment choice —
 * `TEXT_WORKER_MODEL` for every text-worker call, or `TRANSLATION_OLLAMA_MODEL` to
 * override it for translation alone (see translation-provider-config.ts) — never
 * assumed or hardcoded here.
 *
 * ── Two paths, chosen by size OR protected-token complexity ───────────────────
 * `buildTranslationPrompts` sends the whole article in ONE JSON call and, to keep
 * that call inside the worker's latency budget, caps the body at
 * {@link MAX_TRANSLATION_CONTENT_CHARS} (3000) — see that constant's own comment.
 * Anything under the cap is unaffected by it and keeps running the ORIGINAL,
 * UNCHANGED single-call loop below exactly as it always has.
 *
 * An article whose sanitised body EXCEEDS that cap used to simply lose everything
 * past it — the truncation this file exists to remove. A SHORT article can fail
 * the same way for a different reason: one carrying many protected-token
 * placeholders (model names, SKUs, version strings — see protected-tokens.ts) fails
 * `protected_token` regardless of its character count, because restoration requires
 * every placeholder back exactly once and that chance falls geometrically with the
 * count. `shouldChunkForTranslation` (see ollama-chunking.ts) checks BOTH conditions,
 * and either one routes the article to `translateChunked` instead: the body is split
 * into chunks bounded by BOTH a character ceiling and a protected-token ceiling, each
 * chunk gets its own `{"content": "..."}` call with its OWN placeholders and its OWN
 * retry cycle, and the results are stitched back into one article. The routing
 * decision is made HERE, inside the engine, exactly as MADLAD already decides its
 * own segmentation internally — `translate-feed-item.service.ts` builds
 * `request.prompts` the same way for every engine and neither engine is obliged to
 * use it; MADLAD has always ignored it in favour of `request.title`/`request.content`,
 * and the chunked path below does the same.
 */
export class OllamaTranslationProvider implements TranslationProvider {
  readonly kind = "ollama" as const;
  /** One initial call plus the in-request regenerations. */
  readonly maxTries = MAX_TRANSLATION_RETRIES + 1;

  constructor(
    private readonly llm: ILlmProvider,
    readonly providerLabel: string,
    readonly model: string
  ) {}

  async translate(
    request: ArticleTranslationRequest,
    context: ArticleTranslationContext
  ): Promise<ArticleTranslation> {
    // Chunking applies to a "full" article body only — title_only mode has no body
    // to chunk (the source classified it that way BEFORE this engine ever saw it;
    // see classifyTranslationInput), and a title is never remotely close to either
    // ceiling.
    if (request.mode === "full" && shouldChunkForTranslation(request.content)) {
      return this.translateChunked(request, context);
    }
    return this.translateSingleCall(request, context);
  }

  /**
   * The ORIGINAL single-call path, untouched: the whole title+body in one JSON
   * reply, `request.prompts` exactly as the caller built it, the same regeneration
   * loop, sampling schedule, truncation shrink, trace steps and log lines this
   * pipeline has always run. Used for every article that already fits under
   * {@link MAX_TRANSLATION_CONTENT_CHARS}, and for every title_only item.
   */
  private async translateSingleCall(
    request: ArticleTranslationRequest,
    context: ArticleTranslationContext
  ): Promise<ArticleTranslation> {
    const { tracer, now, diag } = context;
    const { systemPrompt, userPrompt, schema } = request.prompts;
    const mode = request.mode;
    const maxTries = MAX_TRANSLATION_RETRIES + 1;

    let translatedTitle: string | null = null;
    let translatedContent: string | null = null;
    let usedRepair = false;
    let repairs: JsonRepair[] = [];
    /** Raw provider payload of the try that SUCCEEDED — the source of the Ollama metrics. */
    let lastResponseRaw: unknown;
    /**
     * The prompt for the NEXT try. Starts as the original request and, after a rejected reply,
     * becomes the original request plus a correction naming the exact defect — so a retry is a
     * correction rather than a re-roll (see buildTranslationRetryPrompt).
     */
    let currentUserPrompt = userPrompt;
    /**
     * The request a correction is appended TO. Normally the original, but a truncation replaces
     * it with a shorter-bodied rebuild, so every later try inherits the smaller article rather
     * than reverting to the one that could not be finished.
     */
    let baseUserPrompt = userPrompt;
    /** Body budget in force. Halved (down to a floor) each time a reply is cut off. */
    let contentBudget = MAX_TRANSLATION_CONTENT_CHARS;
    /** Declared outside the loop so a thrown failure still reports the calls it spent. */
    let tries = 0;
    /**
     * The protected values `currentUserPrompt` actually carries `[[n]]` placeholders for,
     * refreshed alongside it whenever a truncation rebuilds the prompt (see below) — the
     * restoration after parsing must always check against the SAME source text that was
     * just sent, not the article's original, unshrunk one.
     */
    let currentTitleValues: readonly ProtectedValue[] = request.prompts.titleProtectedValues;
    let currentContentValues: readonly ProtectedValue[] = request.prompts.contentProtectedValues;
    /**
     * The body text `currentUserPrompt` actually carries, placeholders and all — what
     * the reply's completeness is measured against. Refreshed alongside the protected
     * values above for exactly the same reason: after a shrink the reply is answering a
     * SMALLER article, and measuring it against the original would condemn a complete
     * translation of the article it was actually given.
     */
    let currentSourceContent = request.prompts.contentProtectedText;
    /**
     * Why the PREVIOUS try was rejected, so the next one can be sampled for the defect it is
     * actually correcting rather than by try number alone — `null` on the first try, which has
     * no previous. See samplingForTry: the escalating temperature/repeat-penalty schedule
     * breaks decoding loops but actively suppresses `[[n]]` placeholders, so a
     * `protected_token` rejection is retried at the base sampling instead.
     */
    let lastFailure: TranslationParseFailure | null = null;

    // In-request regeneration loop. A bad reply from the self-hosted model (invalid JSON, a
    // decoding loop, drifted language) is usually transient, and a fresh sample seconds later
    // succeeds — far better than failing the item and waiting out a 5-minute backoff. Each try
    // varies the sampling (see samplingForTry): re-issuing the same prompt at temperature 0
    // would deterministically reproduce the same bad reply.
    for (let tryIndex = 0; tryIndex < maxTries; tryIndex += 1) {
      const remainingMs = context.itemDeadlineMs - now().getTime();
      if (remainingMs <= 0) {
        throw new TranslationTimeoutError(context.itemTimeoutMs, "item");
      }
      // Never let one try run past the item's own budget.
      const budgetMs = Math.min(context.attemptTimeoutMs, remainingMs);
      const { temperature, repeatPenalty } = samplingForTry(tryIndex, lastFailure);
      const tryStartedMs = now().getTime();
      tries = tryIndex + 1;
      context.reportTry?.(tries);

      console.info("[rss-translation] attempt", {
        feedItemId: request.feedItemId,
        try: tries,
        of: maxTries,
        temperature,
        repeatPenalty,
        // What this try is correcting, so a reader can tell WHY the sampling is what it is —
        // a try 2 at temperature 0 is the protected-token path, not a stuck schedule.
        correcting: lastFailure,
        budgetMs,
      });

      tracer.step({
        type: "prompt",
        label: tries > 1 ? `Try ${tries} — corrected prompt` : `Try ${tries}`,
        attempt: tries,
        input: { systemPrompt, userPrompt: currentUserPrompt },
        metadata: {
          temperature,
          repeatPenalty,
          correcting: lastFailure,
          contentBudget,
          schema,
          isRetryPrompt: tries > 1,
        },
      });

      const callStartedAt = new Date();
      const response = await withTranslationTimeout(
        this.llm.generate({
          systemPrompt,
          userPrompt: currentUserPrompt,
          // Schema-constrained structured output: the Ollama `format` schema makes the reply a
          // strict object instead of free-form text — {title, content} normally, {title} alone
          // for a bodyless item, so the model is never constrained to invent an article.
          // Temperature starts at 0 for fidelity and rises only on a regeneration.
          temperature,
          repeatPenalty,
          format: schema,
          // Bounded generation: without this Ollama runs unlimited and a runaway article never
          // returns within the deadline. The capped body fits well under this ceiling.
          maxTokens: MAX_TRANSLATION_OUTPUT_TOKENS,
        }),
        budgetMs,
        "attempt"
      );

      tracer.step({
        type: "llm_call",
        label: `Try ${tries} of ${maxTries}`,
        attempt: tries,
        startedAt: callStartedAt,
        completedAt: new Date(),
        input: {
          request: { temperature, repeatPenalty, maxTokens: MAX_TRANSLATION_OUTPUT_TOKENS },
        },
        metadata: { providerPayload: response.raw ?? null, budgetMs },
      });
      tracer.step({
        type: "raw_response",
        label: `Try ${tries}`,
        attempt: tries,
        output: { text: response.text },
        metadata: { chars: response.text?.length ?? 0 },
      });

      try {
        const parsedReply = parseTranslationResponse(response.text, request.targetLang, {
          mode,
          sourceContent: currentSourceContent,
        });
        // The reply still carries `[[n]]` placeholders wherever a URL, identifier, SKU, or
        // version string was held out of the decoder (see buildTranslationPrompts). Restoring
        // them is not optional cleanup — it is the programmatic check that the model actually
        // preserved these values, byte-exact, rather than trusting the prompt instructions
        // alone: a reply that dropped, duplicated, or invented a placeholder is rejected here
        // exactly as MADLAD's own segment restoration rejects one (see protected-tokens.ts),
        // and funnels into the SAME retry loop below via the `protected_token` reason.
        const restoredTitle =
          parsedReply.translatedTitle !== null
            ? restoreTokens(parsedReply.translatedTitle, currentTitleValues, "title")
            : null;
        const restoredContent =
          parsedReply.translatedContent !== null
            ? restoreTokens(parsedReply.translatedContent, currentContentValues, "content")
            : null;
        translatedTitle = restoredTitle;
        translatedContent = restoredContent;
        usedRepair = parsedReply.usedRepair;
        repairs = parsedReply.repairs;
        lastResponseRaw = response.raw;
        tracer.setAttempts(tries);
        tracer.step({
          type: "parsed_result",
          label: `Try ${tries} accepted`,
          attempt: tries,
          output: { translatedTitle, translatedContent },
          metadata: { usedRepair, repairs },
        });
        break;
      } catch (parseErr) {
        // The transport succeeded (HTTP 200) but the reply was rejected. Log the SHAPE of the
        // raw output — first/last 200 chars and total length only, never the full body — plus
        // the failure `reason` so the modes are distinguishable: invalid JSON, a
        // schema-validation failure, an empty translation, wrong-language output, or a loop.
        const text = response.text ?? "";
        const parseError = parseErr instanceof TranslationParseError ? parseErr : null;
        const reason = parseError?.reason ?? "invalid_json";
        const willRetry = isRetriableParseFailure(reason) && tryIndex < maxTries - 1;
        // Carried into the NEXT try's sampling, so a retry is tuned for the defect it is
        // correcting rather than by try number alone (see samplingForTry).
        lastFailure = reason;
        console.warn("[rss-translation] unusable model response", {
          ...diag,
          try: tries,
          of: maxTries,
          reason,
          willRetry,
          // Separates "the model wrote something wrong" from "the model never finished" — the
          // two are both invalid_json in the logs but only one is fixed by asking for less.
          truncated: parseError?.truncated ?? false,
          ...(parseError?.repetition
            ? {
                repetitionKind: parseError.repetition.kind,
                repetitionSample: parseError.repetition.sample.slice(0, 40),
                repetitionCount: parseError.repetition.count,
              }
            : {}),
          elapsedMs: now().getTime() - tryStartedMs,
          responseLength: text.length,
          responseFirst200: text.slice(0, 200),
          responseLast200: text.length > 200 ? text.slice(-200) : "",
          error: parseErr instanceof Error ? parseErr.message : String(parseErr),
        });
        tracer.setAttempts(tries);
        tracer.step({
          type: "retry",
          label: willRetry
            ? `Try ${tries} rejected — regenerating`
            : `Try ${tries} rejected — giving up`,
          attempt: tries,
          status: "failed",
          output: {
            reason,
            willRetry,
            truncated: parseError?.truncated ?? false,
            repetition: parseError?.repetition ?? null,
          },
          error: parseErr,
        });
        // Retries exhausted (or a reason regeneration cannot fix) — record the failure.
        if (!willRetry) throw parseErr;

        // A cut-off reply means the request was too big to finish, so re-asking for the same
        // article would truncate again — the exact three-truncations-then-failed pattern in the
        // logs. Rebuild the request around a smaller body first; the correction is then appended
        // to THAT, and every later try inherits it. Only the size changes: the number of tries
        // (maxTries) and the cross-run attempt/backoff schedule are untouched.
        if (parseError?.truncated && contentBudget > MIN_TRANSLATION_CONTENT_CHARS) {
          contentBudget = shrinkTranslationContentBudget(contentBudget);
          const shorter = buildTranslationPrompts(
            request.title,
            request.content,
            request.targetLang,
            { maxContentChars: contentBudget }
          );
          baseUserPrompt = shorter.userPrompt;
          // A smaller body is re-protected from scratch, so a later restore must check
          // against THESE values, not the ones the original (larger) prompt carried —
          // and the completeness check must measure against THIS body for the same
          // reason.
          currentTitleValues = shorter.titleProtectedValues;
          currentContentValues = shorter.contentProtectedValues;
          currentSourceContent = shorter.contentProtectedText;
          console.info("[rss-translation] shrinking article for the next try", {
            feedItemId: request.feedItemId,
            try: tries,
            contentBudget,
            translatedBodyChars: shorter.contentChars,
          });
        }

        // Name the defect in the next request. Without this the retry differs only in its
        // sampling, and a model that answered in prose (or in Macedonian) has been given no
        // reason to answer differently.
        if (parseError) {
          currentUserPrompt = buildTranslationRetryPrompt(baseUserPrompt, {
            reason: parseError.reason,
            feedback: parseError.feedback,
          });
        }
      }
    }

    return {
      translatedTitle,
      translatedContent,
      tries,
      usedRepair,
      repairs,
      raw: lastResponseRaw,
    };
  }

  /**
   * Translates a large article by splitting its body into ~2500–3000-char chunks
   * (see ollama-chunking.ts) and translating each — plus the title, as its own tiny
   * call — independently, with its own protected-token placeholders and its own
   * retry cycle. Reuses `request.title`/`request.content` directly rather than
   * `request.prompts`, exactly as MADLAD already does, because the caller's prompt
   * was built for the single-call path and is capped accordingly.
   *
   * ── Resumable, unit by unit ──────────────────────────────────────────────────
   * `context.resumeSegments` is read (and `banked` grown from it) exactly as MADLAD
   * already reads it for its own segments — the SAME field, the SAME shape, keyed
   * here by `"title"` or a chunk's index. A unit already present in `banked` is
   * never re-sent: this is what makes a failure partway through an article cost
   * only the units after the failure, both within one call (a later unit can still
   * run out of item budget and stop cleanly) and across cross-run attempts (the
   * next claim resumes from `translationProgress` and skips every unit this call
   * already finished).
   */
  private async translateChunked(
    request: ArticleTranslationRequest,
    context: ArticleTranslationContext
  ): Promise<ArticleTranslation> {
    const { tracer, now } = context;
    const targetLang = request.targetLang;

    const chunked = chunkArticleForTranslation(request.title, request.content, {});
    const totalUnits = (chunked.title !== null ? 1 : 0) + chunked.chunks.length;
    const resumed = context.resumeSegments ?? {};
    const banked: Record<string, string> = { ...resumed };

    // Per-chunk diagnostics (requirement: chars, protected-token count, and WHY each
    // chunk ended where it did — a size-bound split reads very differently from a
    // token-bound one when diagnosing a `protected_token` failure after the fact).
    const chunkSizes = chunked.chunks.map((c) => c.text.length);
    const chunkProtectedTokenCounts = chunked.chunks.map((c) => c.protectedTokenCount);
    const chunkSplitReasons = chunked.chunks.map((c) => c.splitReason);

    console.info("[rss-translation] article split into chunks for translation", {
      feedItemId: request.feedItemId,
      engine: "ollama",
      originalChars: chunked.contentChars,
      hasTitle: chunked.title !== null,
      chunkCount: chunked.chunks.length,
      chunkSizes,
      chunkProtectedTokenCounts,
      chunkSplitReasons,
      resumedUnits: Object.keys(resumed).length,
      totalUnits,
    });

    tracer.step({
      type: "prompt",
      label: `Article split into ${chunked.chunks.length} chunk${chunked.chunks.length === 1 ? "" : "s"} for translation`,
      input: {
        title: chunked.title,
        chunks: chunked.chunks.map((c) => c.text),
      },
      metadata: {
        engine: "ollama",
        originalChars: chunked.contentChars,
        hasTitle: chunked.title !== null,
        chunkCount: chunked.chunks.length,
        chunkSizes,
        chunkProtectedTokenCounts,
        chunkSplitReasons,
        resumedUnits: Object.keys(resumed).length,
        totalUnits,
      },
    });

    // One ATTEMPT, however many model calls it takes — see modelCalls below, and
    // MADLAD's own reportTry(1) for the same reasoning: the cross-run attempt is
    // tracked by the caller, this reports the ONE claim's worth of work.
    context.reportTry?.(1);

    let modelCalls = 0;
    let anyUsedRepair = false;
    const allRepairs: JsonRepair[] = [];
    let lastResponseRaw: unknown;

    /** Wraps one unit: resume, bypass, or translate — and bank the result. */
    const runUnit = async (
      key: string,
      label: string,
      sourceText: string,
      build: () => UnitPrompt
    ): Promise<void> => {
      if (key in banked) {
        console.info("[rss-translation] chunk already translated — resuming", {
          feedItemId: request.feedItemId,
          unit: label,
        });
        return;
      }

      const remainingMs = context.itemDeadlineMs - now().getTime();
      if (remainingMs <= 0) {
        throw new TranslationPartialProgressError(
          `Ran out of item budget before translating ${label}.`,
          banked,
          Object.keys(banked).length,
          totalUnits,
          "item_budget_exhausted"
        );
      }

      // Reused, not reimplemented: the SAME bypass MADLAD uses for a spec-table
      // cell — a chunk carrying nothing but protected values has no language in
      // it at all, and sending it can only mangle the placeholders. Bypassed
      // units cost no retry, no attempt, and no model call.
      const protection = protectTokens(sourceText);
      if (isDataOnlySegment(protection)) {
        console.info("[rss-translation] chunk bypassed — nothing but protected data", {
          feedItemId: request.feedItemId,
          unit: label,
          protectedTokens: protection.values.length,
        });
        banked[key] = sourceText;
        return;
      }

      const built = build();
      let outcome: UnitOutcome;
      try {
        outcome = await this.translateUnit(
          built.systemPrompt,
          built.userPrompt,
          built.schema,
          built.mode,
          built.protectedValues,
          targetLang,
          context,
          request,
          label,
          built.sourceContent
        );
      } catch (err) {
        // Retries exhausted for THIS unit (or the item's own deadline was crossed
        // mid-retry) — everything banked so far, INCLUDING every earlier unit in
        // this same call, survives; only this unit and whatever follows it is left
        // for a later attempt. See TranslationPartialProgressError's own comment.
        if (err instanceof TranslationTimeoutError) {
          throw new TranslationPartialProgressError(
            `Ran out of item budget translating ${label}.`,
            banked,
            Object.keys(banked).length,
            totalUnits,
            "item_budget_exhausted"
          );
        }
        throw new TranslationPartialProgressError(
          `Could not translate ${label} after ${MAX_TRANSLATION_RETRIES + 1} tries: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          banked,
          Object.keys(banked).length,
          totalUnits,
          "unit_retry_exhausted",
          err instanceof TranslationParseError ? err.reason : null
        );
      }

      banked[key] = outcome.text;
      modelCalls += outcome.tries;
      if (outcome.usedRepair) anyUsedRepair = true;
      allRepairs.push(...outcome.repairs);
      lastResponseRaw = outcome.raw;

      console.info("[rss-translation] chunk translated", {
        feedItemId: request.feedItemId,
        unit: label,
        tries: outcome.tries,
        protectedTokens: built.protectedValues.length,
        translatedChars: outcome.text.length,
      });
    };

    if (chunked.title !== null) {
      await runUnit("title", "title", chunked.title, () => {
        const built = buildTranslationPrompts(chunked.title, null, targetLang);
        return {
          systemPrompt: built.systemPrompt,
          userPrompt: built.userPrompt,
          schema: built.schema,
          protectedValues: built.titleProtectedValues,
          mode: "title_only",
          // A title is far below the completeness check's own length floor, and a cut
          // title is already refused outright by parseTranslationResponse.
          sourceContent: null,
        };
      });
    }

    for (let i = 0; i < chunked.chunks.length; i += 1) {
      const chunk = chunked.chunks[i];
      const label = `chunk ${i + 1}/${chunked.chunks.length}`;
      await runUnit(String(i), label, chunk.text, () => {
        const built = buildContentChunkPrompt(chunk.text, targetLang, {
          chunkIndex: i,
          chunkCount: chunked.chunks.length,
        });
        return {
          systemPrompt: built.systemPrompt,
          userPrompt: built.userPrompt,
          schema: built.schema,
          protectedValues: built.protectedValues,
          mode: "content_only",
          // THIS chunk's own source text, so a chunk that came back half-translated
          // fails on its own account rather than being averaged away by its neighbours
          // once the article is reassembled.
          sourceContent: built.protectedText,
        };
      });
    }

    // Every unit is present in `banked` — nothing was thrown, so nothing was
    // skipped and nothing was left English by accident (requirement: no silent
    // drops). `mode: full` therefore really does mean the complete article.
    const translatedTitle = chunked.title !== null ? (banked.title ?? null) : null;
    const translatedChunkTexts = chunked.chunks.map((_, i) => banked[String(i)] ?? "");
    const { translatedContent } = reassembleChunkedTranslation(
      chunked,
      translatedTitle,
      translatedChunkTexts
    );

    tracer.step({
      type: "parsed_result",
      label: "Chunked translation accepted",
      output: { translatedTitle, translatedContent },
      metadata: {
        engine: "ollama",
        chunkCount: chunked.chunks.length,
        modelCalls,
        usedRepair: anyUsedRepair,
        repairs: allRepairs,
        originalChars: chunked.contentChars,
        translatedChars: translatedContent?.length ?? 0,
      },
    });

    console.info("[rss-translation] chunked article translated", {
      feedItemId: request.feedItemId,
      engine: "ollama",
      chunkCount: chunked.chunks.length,
      modelCalls,
      originalChars: chunked.contentChars,
      translatedChars: translatedContent?.length ?? 0,
    });

    return {
      translatedTitle,
      translatedContent,
      // One attempt, N model calls — see `modelCalls` below and MADLAD's own
      // `tries: 1` for the same reasoning: the ARTICLE-level attempt is tracked by
      // the caller (translate-feed-item.service.ts), this reports the one claim.
      tries: 1,
      modelCalls,
      usedRepair: anyUsedRepair,
      repairs: allRepairs,
      raw: lastResponseRaw,
    };
  }

  /**
   * Translates ONE unit (the title, or one content chunk) with its own in-request
   * regeneration loop — the SAME sampling schedule, retry-prompt wording, and
   * protected-token restoration the single-call path uses, scoped to one prompt
   * instead of the whole article. Deliberately WITHOUT the single-call path's
   * content-shrink-on-truncation special case: a unit is already sized to the same
   * budget that case exists to reach (see ollama-chunking.ts's OLLAMA_CHUNK_MAX_CHARS,
   * matched to MAX_TRANSLATION_CONTENT_CHARS), so a truncated reply here is a
   * genuine anomaly, not a sizing problem — it is retried like any other defect and,
   * if it persists, the unit fails and the article banks what it has.
   */
  private async translateUnit(
    systemPrompt: string,
    userPrompt: string,
    schema: unknown,
    mode: "title_only" | "content_only",
    protectedValues: readonly ProtectedValue[],
    targetLang: string,
    context: ArticleTranslationContext,
    request: ArticleTranslationRequest,
    label: string,
    sourceContent: string | null
  ): Promise<UnitOutcome> {
    const { tracer, now, diag } = context;
    const maxTries = MAX_TRANSLATION_RETRIES + 1;
    let currentUserPrompt = userPrompt;
    let lastFailure: TranslationParseFailure | null = null;
    let tries = 0;

    for (let tryIndex = 0; tryIndex < maxTries; tryIndex += 1) {
      const remainingMs = context.itemDeadlineMs - now().getTime();
      if (remainingMs <= 0) {
        throw new TranslationTimeoutError(context.itemTimeoutMs, "item");
      }
      const budgetMs = Math.min(context.attemptTimeoutMs, remainingMs);
      const { temperature, repeatPenalty } = samplingForTry(tryIndex, lastFailure);
      const tryStartedMs = now().getTime();
      tries = tryIndex + 1;

      console.info("[rss-translation] attempt", {
        feedItemId: request.feedItemId,
        unit: label,
        try: tries,
        of: maxTries,
        temperature,
        repeatPenalty,
        correcting: lastFailure,
        budgetMs,
      });

      const callStartedAt = new Date();
      const response = await withTranslationTimeout(
        this.llm.generate({
          systemPrompt,
          userPrompt: currentUserPrompt,
          temperature,
          repeatPenalty,
          format: schema,
          maxTokens: MAX_TRANSLATION_OUTPUT_TOKENS,
        }),
        budgetMs,
        "attempt"
      );

      tracer.step({
        type: "llm_call",
        label: `${label} — try ${tries} of ${maxTries}`,
        attempt: tries,
        startedAt: callStartedAt,
        completedAt: new Date(),
        input: {
          request: { temperature, repeatPenalty, maxTokens: MAX_TRANSLATION_OUTPUT_TOKENS },
        },
        metadata: { providerPayload: response.raw ?? null, budgetMs, unit: label },
      });
      tracer.step({
        type: "raw_response",
        label: `${label} — try ${tries}`,
        attempt: tries,
        output: { text: response.text },
        metadata: { chars: response.text?.length ?? 0, unit: label },
      });

      try {
        const parsedReply = parseTranslationResponse(response.text, targetLang, {
          mode,
          sourceContent,
        });
        const raw = parsedReply.translatedTitle ?? parsedReply.translatedContent ?? "";
        const restored = restoreTokens(raw, protectedValues, label);
        tracer.setAttempts(tries);
        tracer.step({
          type: "parsed_result",
          label: `${label} — try ${tries} accepted`,
          attempt: tries,
          output: { text: restored },
          metadata: {
            usedRepair: parsedReply.usedRepair,
            repairs: parsedReply.repairs,
            unit: label,
          },
        });
        return {
          text: restored,
          tries,
          usedRepair: parsedReply.usedRepair,
          repairs: parsedReply.repairs,
          raw: response.raw,
        };
      } catch (parseErr) {
        const text = response.text ?? "";
        const parseError = parseErr instanceof TranslationParseError ? parseErr : null;
        const reason = parseError?.reason ?? "invalid_json";
        const willRetry = isRetriableParseFailure(reason) && tryIndex < maxTries - 1;
        lastFailure = reason;
        console.warn("[rss-translation] unusable model response", {
          ...diag,
          unit: label,
          try: tries,
          of: maxTries,
          reason,
          willRetry,
          truncated: parseError?.truncated ?? false,
          ...(parseError?.repetition
            ? {
                repetitionKind: parseError.repetition.kind,
                repetitionSample: parseError.repetition.sample.slice(0, 40),
                repetitionCount: parseError.repetition.count,
              }
            : {}),
          elapsedMs: now().getTime() - tryStartedMs,
          responseLength: text.length,
          responseFirst200: text.slice(0, 200),
          responseLast200: text.length > 200 ? text.slice(-200) : "",
          error: parseErr instanceof Error ? parseErr.message : String(parseErr),
        });
        tracer.setAttempts(tries);
        tracer.step({
          type: "retry",
          label: willRetry
            ? `${label} — try ${tries} rejected — regenerating`
            : `${label} — try ${tries} rejected — giving up`,
          attempt: tries,
          status: "failed",
          output: {
            reason,
            willRetry,
            truncated: parseError?.truncated ?? false,
            repetition: parseError?.repetition ?? null,
            unit: label,
          },
          error: parseErr,
        });
        if (!willRetry) throw parseErr;

        if (parseError) {
          currentUserPrompt = buildTranslationRetryPrompt(userPrompt, {
            reason: parseError.reason,
            feedback: parseError.feedback,
          });
        }
      }
    }

    // Unreachable: `maxTries` is always ≥ 1, and the last iteration's catch block
    // always either returns (accepted) or throws (willRetry is false once
    // tryIndex === maxTries - 1). Present only so the function is provably total.
    throw new Error(`Exhausted retries translating ${label} without a terminal outcome.`);
  }
}

/** Everything one unit's (title's, or one chunk's) prompt-building step hands back. */
interface UnitPrompt {
  systemPrompt: string;
  userPrompt: string;
  schema: unknown;
  protectedValues: readonly ProtectedValue[];
  /**
   * Which reply contract this unit's schema expects — passed explicitly rather than
   * inferred from `schema`'s shape at call time, so a title call and a chunk call
   * can never be misclassified by one.
   */
  mode: "title_only" | "content_only";
  /**
   * This unit's own source text in the reply's representation (placeholders and
   * all), for the completeness check — `null` for a title, which is too short to
   * measure. See `assessTranslationCoverage`.
   */
  sourceContent: string | null;
}

/** What one unit's (title's, or one chunk's) translation call produced. */
interface UnitOutcome {
  /** FINAL, restored text — placeholders already swapped back to their real values. */
  text: string;
  tries: number;
  usedRepair: boolean;
  repairs: JsonRepair[];
  raw: unknown;
}
