import type { ILlmProvider } from "@/lib/ai/types";
import {
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
import { TranslationTimeoutError, withTranslationTimeout } from "./translation-timeout";
import { restoreTokens, type ProtectedValue } from "./protected-tokens";

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
        const parsedReply = parseTranslationResponse(response.text, request.targetLang, { mode });
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
          // against THESE values, not the ones the original (larger) prompt carried.
          currentTitleValues = shorter.titleProtectedValues;
          currentContentValues = shorter.contentProtectedValues;
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
}
