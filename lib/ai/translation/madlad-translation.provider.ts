import { requestSignal } from "@/lib/http/request-deadline";
import type {
  ArticleTranslation,
  ArticleTranslationContext,
  ArticleTranslationRequest,
  TranslationProvider,
} from "./translation-provider";
import { TranslationTransportError } from "./translation-provider";
import { TranslationTimeoutError, withTranslationTimeout } from "./translation-timeout";
import { reassembleArticle, segmentArticle } from "./madlad-segmentation";
import { assertUsableTranslation } from "./translated-text-validation";
import { extractUrls, protectTokens, restoreTokens, type ProtectedValue } from "./protected-tokens";
import { TranslationParseError } from "@/lib/ai/feed-item-translation";

/**
 * google/madlad400-3b-mt, served by the EXISTING text worker.
 *
 * No new service and no new port: the model runs inside the Mac text worker that
 * already answers `/generate` and `/embed`, under a third endpoint on the same host,
 * behind the same `x-worker-api-key`.
 *
 * ── The wire contract ────────────────────────────────────────────────────────
 * POST {TEXT_WORKER_URL}/translate
 *
 *   request:  { "text": "…", "sourceLanguage": "en", "targetLanguage": "bg" }
 *   response: { "text": "…", "provider": "madlad",
 *               "model": "google/madlad400-3b-mt", "durationMs": 412 }
 *
 * ONE text per call — this is the shape the running worker actually implements, and
 * it is what this class sends, field for field, with nothing extra. An article is
 * therefore N calls, one per segment, issued strictly in sequence: the Python side
 * holds a single 3B model and serialises anyway, so concurrency here would only move
 * the queue from the worker into the network and make each call's latency a
 * measurement of the others.
 *
 * The app owns the splitting and the reassembly (see madlad-segmentation.ts), so the
 * worker stays a dumb, stateless translator and the structure-preserving logic stays
 * unit-testable on this side.
 *
 * ── Why exactly one ATTEMPT ──────────────────────────────────────────────────
 * The prompt-based engine regenerates a rejected reply because a fresh sample of a
 * chat model genuinely differs. MADLAD decodes with beam search: re-sending the same
 * text returns the same text, so a retry would spend the budget to reproduce the
 * defect. A rejected translation is therefore recorded as a failure and picked up by
 * the normal cross-run backoff, exactly like an exhausted retry budget. `maxTries`
 * counts ATTEMPTS, not HTTP calls — one attempt costs one call per segment, reported
 * separately as `modelCalls`.
 */

/**
 * The source language declared to the worker.
 *
 * Every content source this pipeline ingests is English, and the prompt-based engine
 * assumes the same thing in its prompt. Stated as a named constant rather than an
 * environment knob so the two engines cannot silently disagree about it.
 */
export const MADLAD_SOURCE_LANGUAGE = "en";

/** Per-request cap for ONE segment call. Bounded further by the caller's own budget. */
export const MADLAD_SEGMENT_TIMEOUT_MS = 120_000;

/** What the worker is expected to answer with. Every field is validated before use. */
interface MadladWorkerReply {
  text?: unknown;
  provider?: unknown;
  model?: unknown;
  device?: unknown;
  durationMs?: unknown;
  error?: unknown;
}

/** One validated segment translation. */
interface SegmentReply {
  text: string;
  model: string | null;
  device: string | null;
  durationMs: number | null;
}

export class MadladTranslationProvider implements TranslationProvider {
  readonly kind = "madlad" as const;
  /**
   * MADLAD is served BY the text worker, so the provenance stored on the feed item and
   * shown in the trace is the worker — the same label the prompt-based path records when
   * it runs there. The engine is named separately (`kind`), which is what actually
   * distinguishes a MADLAD run from a Qwen one; the model tells them apart in the data.
   */
  readonly providerLabel = "TEXT_WORKER";
  /** Beam search is deterministic — a second attempt would reproduce the first. */
  readonly maxTries = 1;

  constructor(
    private readonly workerUrl: string,
    private readonly apiKey: string,
    readonly model: string,
    private readonly sourceLang: string = MADLAD_SOURCE_LANGUAGE
  ) {}

  async translate(
    request: ArticleTranslationRequest,
    context: ArticleTranslationContext
  ): Promise<ArticleTranslation> {
    const { tracer, now, diag } = context;

    const { segments, plan, contentChars } = segmentArticle(request.title, request.content, {
      mode: request.mode,
    });

    if (segments.length === 0) {
      // The caller settles a genuinely empty article long before here, so this means the
      // body survived classification but not sanitising — treat it as an engine-level
      // failure rather than sending an empty request.
      throw new TranslationTransportError("Nothing left to translate after segmentation.");
    }

    // Values that are DATA rather than language — URLs, e-mail addresses, model codes —
    // are swapped for `[[n]]` placeholders before the call and swapped back after it.
    // Unprotected, the model deletes or translates them silently; see protected-tokens.ts.
    const protectedSegments = segments.map((segment) => protectTokens(segment));
    const protectedValues: ProtectedValue[][] = protectedSegments.map((p) => p.values);
    const protectedCount = protectedValues.reduce((sum, v) => sum + v.length, 0);

    context.reportTry?.(1);
    console.info("[rss-translation] attempt", {
      feedItemId: request.feedItemId,
      try: 1,
      of: 1,
      engine: "madlad",
      model: this.model,
      segments: segments.length,
      protectedTokens: protectedCount,
    });

    // The "prompt" for an NMT engine is the batch itself — recorded under the same step
    // type so a MADLAD run reads in the trace timeline exactly where an Ollama one does.
    tracer.step({
      type: "prompt",
      label: "Segments sent to MADLAD",
      attempt: 1,
      input: {
        sourceLanguage: this.sourceLang,
        targetLanguage: request.targetLang,
        // What actually goes on the wire, placeholders and all — so a trace shows the
        // request as sent rather than a tidied-up version of it.
        segments: protectedSegments.map((p) => p.text),
      },
      metadata: {
        engine: "madlad",
        model: this.model,
        segmentCount: segments.length,
        contentChars,
        pieces: plan.body.length,
        hasTitle: plan.titleIndex !== null,
        protectedTokens: protectedCount,
        protectedKinds: protectedValues.flat().map((v) => v.kind),
      },
    });

    const callStartedAt = new Date();
    const translations: string[] = [];
    const segmentDurations: number[] = [];
    let workerModel: string | null = null;
    let workerDevice: string | null = null;

    // Sequential by design — see the class comment. Each segment re-checks the item
    // deadline, so a slow worker stops the article at the budget instead of after it.
    for (const [index, segment] of protectedSegments.entries()) {
      const remainingMs = context.itemDeadlineMs - now().getTime();
      if (remainingMs <= 0) throw new TranslationTimeoutError(context.itemTimeoutMs, "item");
      const budgetMs = Math.min(context.attemptTimeoutMs, remainingMs);

      const reply = await withTranslationTimeout(
        this.callWorker(segment.text, request.targetLang, budgetMs, index, segments.length),
        budgetMs,
        "attempt"
      );

      translations.push(reply.text);
      if (reply.durationMs !== null) segmentDurations.push(reply.durationMs);
      workerModel ??= reply.model;
      workerDevice ??= reply.device;
    }

    const workerDurationMs = segmentDurations.reduce((sum, ms) => sum + ms, 0);

    tracer.step({
      type: "llm_call",
      label: `MADLAD translate — ${segments.length} segment${segments.length === 1 ? "" : "s"}`,
      attempt: 1,
      startedAt: callStartedAt,
      completedAt: new Date(),
      input: {
        request: {
          sourceLanguage: this.sourceLang,
          targetLanguage: request.targetLang,
          segments: segments.length,
        },
      },
      metadata: {
        providerPayload: {
          provider: "madlad",
          model: workerModel ?? this.model,
          device: workerDevice,
          durationMs: workerDurationMs || null,
        },
        // The two numbers that answer "what did this article cost?" for an engine whose
        // cost is per segment rather than per attempt.
        segmentCount: segments.length,
        workerCalls: segments.length,
        segmentDurationsMs: segmentDurations,
        elapsedMs: now().getTime() - callStartedAt.getTime(),
      },
    });
    tracer.step({
      type: "raw_response",
      label: "MADLAD segments",
      attempt: 1,
      output: { text: translations.join("\n") },
      metadata: { chars: translations.join("").length, segmentCount: translations.length },
    });

    // ── Restore the protected values ──────────────────────────────────────────
    // Two reassemblies of the same article. The quality gate reads the PLACEHOLDER form
    // because a restored URL is a run of Latin letters, and the Bulgarian-language check
    // counts letters: a legitimately translated sentence carrying a long English URL
    // would otherwise be condemned as "not Bulgarian". The stored text is the restored
    // form. Both come from one `translations` array, so they cannot describe different
    // articles.
    let translatedTitle: string | null;
    let translatedContent: string | null;

    try {
      // Rejected here rather than repaired: a guess about which URL belonged where is
      // exactly the silent corruption the placeholders exist to prevent.
      const restored = translations.map((text, index) =>
        restoreTokens(text, protectedValues[index], `segment ${index + 1}/${segments.length}`)
      );

      const placeholderForm = reassembleArticle(plan, translations);
      const restoredForm = reassembleArticle(plan, restored);
      translatedTitle = restoredForm.translatedTitle;
      translatedContent = restoredForm.translatedContent;

      // The article-level invariant. Restoration already guarantees this per segment;
      // this is the independent second net across the WHOLE article, where a fault in
      // the split or the fold could still drop or double one. Ordered and
      // multiplicity-exact: the same URL twice in the source must be the same URL
      // twice in the translation, in the same order.
      const sourceUrls = extractUrls(segments.join("\n"));
      const translatedUrls = extractUrls(
        [translatedTitle ?? "", translatedContent ?? ""].join("\n")
      );
      if (sourceUrls.join(" ") !== translatedUrls.join(" ")) {
        throw new TranslationParseError(
          `Translation does not carry the source's URLs. Expected [${sourceUrls.join(", ")}], ` +
            `got [${translatedUrls.join(", ")}].`,
          "protected_token"
        );
      }

      assertUsableTranslation(placeholderForm, request.targetLang, request.mode);
    } catch (err) {
      // Same shape of warning the prompt-based engine writes, so a rejected MADLAD
      // translation is greppable alongside a rejected Qwen one. `willRetry` is always
      // false here — see the beam-search note at the top of this file. Note this is NOT
      // a transport fault and therefore can never trigger the fallback.
      const reason = err instanceof Error ? err.message : String(err);
      console.warn("[rss-translation] unusable model response", {
        ...diag,
        try: 1,
        of: 1,
        engine: "madlad",
        willRetry: false,
        workerCalls: segments.length,
        elapsedMs: now().getTime() - callStartedAt.getTime(),
        error: reason,
      });
      tracer.setAttempts(1);
      tracer.step({
        type: "retry",
        label: "MADLAD output rejected — giving up",
        attempt: 1,
        status: "failed",
        output: { willRetry: false },
        error: err,
      });
      throw err;
    }

    tracer.setAttempts(1);
    tracer.step({
      type: "parsed_result",
      label: "MADLAD output accepted",
      attempt: 1,
      output: { translatedTitle, translatedContent },
      metadata: {
        segmentCount: translations.length,
        workerCalls: segments.length,
        protectedTokens: protectedCount,
        urls: extractUrls(segments.join("\n")).length,
      },
    });

    return {
      translatedTitle,
      translatedContent,
      tries: 1,
      modelCalls: segments.length,
      // An NMT engine returns plain strings — there is no JSON to salvage, ever.
      usedRepair: false,
      repairs: [],
      raw: {
        provider: "madlad",
        model: workerModel ?? this.model,
        device: workerDevice,
        durationMs: workerDurationMs || null,
        segmentCount: translations.length,
        workerCalls: segments.length,
        protectedTokens: protectedCount,
      },
    };
  }

  /**
   * One HTTP call to the worker for ONE segment, with the envelope fully validated
   * before it is trusted.
   *
   * Every failure here is a {@link TranslationTransportError} — the engine did not
   * answer, or did not answer in the agreed shape — which is the only class of failure
   * a fallback may ever consider. Nothing is allowed through on a guess: a reply
   * missing its text, carrying another provider's envelope, or holding an empty string
   * would each silently delete a paragraph from an article nobody reads in the original.
   */
  private async callWorker(
    text: string,
    targetLang: string,
    budgetMs: number,
    index: number,
    total: number
  ): Promise<SegmentReply> {
    const url = this.workerUrl.replace(/\/+$/, "");
    const where = `segment ${index + 1}/${total}`;

    let res: Response;
    try {
      res = await fetch(`${url}/translate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-worker-api-key": this.apiKey,
        },
        // Exactly the three fields the worker accepts. Nothing else is sent: an extra
        // field is a contract this side would then be free to drift on.
        body: JSON.stringify({
          text,
          sourceLanguage: this.sourceLang,
          targetLanguage: targetLang,
        }),
        signal: requestSignal(Math.min(MADLAD_SEGMENT_TIMEOUT_MS, Math.max(1, budgetMs))),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new TranslationTransportError(`MADLAD request exceeded its deadline (${where})`);
      }
      throw new TranslationTransportError(
        `MADLAD worker unreachable (${where}): ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      throw new TranslationTransportError(
        `MADLAD worker error ${res.status} (${where}): ${body.slice(0, 300)}`
      );
    }

    let data: MadladWorkerReply;
    try {
      data = (await res.json()) as MadladWorkerReply;
    } catch {
      throw new TranslationTransportError(`MADLAD worker returned a non-JSON body (${where})`);
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new TranslationTransportError(`MADLAD worker returned a non-object body (${where})`);
    }

    if (typeof data.error === "string" && data.error.length > 0) {
      throw new TranslationTransportError(`MADLAD worker refused (${where}): ${data.error}`);
    }

    // The envelope must name MADLAD. Without this check a `/translate` route
    // accidentally wired to `/generate` returns a perfectly shaped `{ text }` and the
    // pipeline stores a chat model's output under MADLAD's name — the one confusion
    // that would invalidate every comparison this integration exists to make.
    if (typeof data.provider !== "string" || data.provider.toLowerCase() !== "madlad") {
      throw new TranslationTransportError(
        `MADLAD worker returned a foreign envelope (${where}): provider=${JSON.stringify(data.provider)}`
      );
    }

    if (typeof data.text !== "string") {
      throw new TranslationTransportError(
        `MADLAD worker returned no text (${where}): got ${typeof data.text}`
      );
    }
    const translated = data.text.trim();
    if (translated.length === 0) {
      // Silently accepting this would drop the segment's paragraph from the article and
      // report success. A translator that answers nothing has not answered.
      throw new TranslationTransportError(
        `MADLAD worker returned an empty translation (${where}) for ${text.length} characters`
      );
    }

    const model = typeof data.model === "string" ? data.model : null;
    if (model !== null && model !== this.model) {
      // Informational, not fatal: one worker serves one checkpoint, and the app's
      // configured name being stale is an operator note, not a reason to lose an article.
      console.warn("[rss-translation] MADLAD worker is serving a different checkpoint", {
        configured: this.model,
        serving: model,
      });
    }

    return {
      text: translated,
      model,
      device: typeof data.device === "string" ? data.device : null,
      durationMs: typeof data.durationMs === "number" ? data.durationMs : null,
    };
  }
}
