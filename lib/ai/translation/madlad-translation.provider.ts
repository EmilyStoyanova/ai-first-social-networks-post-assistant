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
 *   request:  { "texts": ["…", "…"], "sourceLanguage": "en", "targetLanguage": "bg" }
 *   response: { "texts": ["…", "…"], "provider": "madlad",
 *               "model": "google/madlad400-3b-mt", "durationMs": 3120 }
 *
 * The worker (text-worker commit d829fec) also still answers the older singular
 * `{ text }` / `{ text }` shape, but this class never sends it: `texts[]` is used for
 * every request, including a "batch" of one, so there is exactly one wire format and
 * one response-parsing path to reason about and test — see
 * `DEFAULT_MADLAD_HTTP_BATCH_SIZE` for why 30, not 1 or the worker's ceiling of 32.
 *
 * An article's segments are chunked into HTTP batches and sent STRICTLY IN SEQUENCE,
 * never simultaneously: the Python side holds a single 3B model, and measurement
 * showed concurrent single-segment HTTP requests make total latency WORSE, not
 * better (see `DEFAULT_MADLAD_CONCURRENCY`). Batching is a different lever — fewer,
 * larger HTTP calls, each translated as one internal `model.generate` batch on the
 * worker — and it measured a real 1.52x speedup on a 120-segment article precisely
 * because it is NOT client-side concurrency.
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
 * counts ATTEMPTS, not HTTP calls — one attempt costs one HTTP call per BATCH of
 * segments, reported separately as `modelCalls`.
 */

/**
 * The source language declared to the worker.
 *
 * Every content source this pipeline ingests is English, and the prompt-based engine
 * assumes the same thing in its prompt. Stated as a named constant rather than an
 * environment knob so the two engines cannot silently disagree about it.
 */
export const MADLAD_SOURCE_LANGUAGE = "en";

/**
 * Per-request cap for ONE HTTP batch call. Bounded further by the caller's own
 * budget. A batch of {@link DEFAULT_MADLAD_HTTP_BATCH_SIZE} segments measured well
 * under a minute per call in production, so this stays generous headroom rather than
 * a tight fit — it was never tight even back when it bounded a single segment.
 */
export const MADLAD_REQUEST_TIMEOUT_MS = 120_000;

/** Splits `items` into consecutive groups of at most `size`, in order, none empty. */
function chunkIntoBatches<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size));
  }
  return batches;
}

/** What the worker is expected to answer a batch with. Every field is validated before use. */
interface MadladBatchWorkerReply {
  texts?: unknown;
  provider?: unknown;
  model?: unknown;
  device?: unknown;
  durationMs?: unknown;
  error?: unknown;
}

/** One validated HTTP batch's worth of segment translations, still in request order. */
interface BatchReply {
  texts: string[];
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
    private readonly sourceLang: string = MADLAD_SOURCE_LANGUAGE,
    /**
     * Retained for constructor/config backward compatibility only — NOT read by the
     * HTTP batch dispatch below. See `DEFAULT_MADLAD_CONCURRENCY`'s comment.
     */
    private readonly concurrency: number = 1,
    /** Segments per `/translate` HTTP batch. See `DEFAULT_MADLAD_HTTP_BATCH_SIZE`. */
    private readonly httpBatchSize: number = 30
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

    // HTTP batches — see DEFAULT_MADLAD_HTTP_BATCH_SIZE. Computed up front: chunking
    // is deterministic, so the planned request count is known before the first call.
    const batches = chunkIntoBatches(protectedSegments, this.httpBatchSize);

    context.reportTry?.(1);
    console.info("[rss-translation] attempt", {
      feedItemId: request.feedItemId,
      try: 1,
      of: 1,
      engine: "madlad",
      model: this.model,
      segments: segments.length,
      httpBatchSize: this.httpBatchSize,
      httpBatchCount: batches.length,
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
        httpBatchSize: this.httpBatchSize,
        httpBatchCount: batches.length,
        contentChars,
        pieces: plan.body.length,
        hasTitle: plan.titleIndex !== null,
        protectedTokens: protectedCount,
        protectedKinds: protectedValues.flat().map((v) => v.kind),
      },
    });

    const callStartedAt = new Date();

    // Sequential by design — see the class comment: measurement showed CONCURRENT
    // single-segment HTTP requests make total latency worse, and batching (fewer,
    // larger sequential calls) is the lever that actually helped. Each batch
    // re-checks the item deadline itself before it is sent, so a slow worker still
    // stops the article at the budget instead of running past it; a batch that
    // throws stops all further batches and the whole call rejects, so a failed
    // batch can never lead to a partial article being reassembled or stored.
    const batchReplies: BatchReply[] = [];
    let segmentsSentSoFar = 0;
    for (const batch of batches) {
      const remainingMs = context.itemDeadlineMs - now().getTime();
      if (remainingMs <= 0) throw new TranslationTimeoutError(context.itemTimeoutMs, "item");
      const budgetMs = Math.min(context.attemptTimeoutMs, remainingMs);

      const reply = await withTranslationTimeout(
        this.callWorkerBatch(
          batch.map((p) => p.text),
          request.targetLang,
          budgetMs,
          segmentsSentSoFar,
          batchReplies.length,
          batches.length,
          segments.length
        ),
        budgetMs,
        "attempt"
      );
      batchReplies.push(reply);
      segmentsSentSoFar += batch.length;
    }

    const translations = batchReplies.flatMap((reply) => reply.texts);
    const batchDurations = batchReplies
      .map((reply) => reply.durationMs)
      .filter((ms): ms is number => ms !== null);
    // Sourced from the first batch's own reply rather than a "first to resolve"
    // race, so the reported model/device never depends on completion order.
    const workerModel = batchReplies[0]?.model ?? null;
    const workerDevice = batchReplies[0]?.device ?? null;

    const workerDurationMs = batchDurations.reduce((sum, ms) => sum + ms, 0);

    tracer.step({
      type: "llm_call",
      label:
        `MADLAD translate — ${segments.length} segment${segments.length === 1 ? "" : "s"}` +
        ` in ${batches.length} HTTP batch${batches.length === 1 ? "" : "es"}`,
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
        // What did this article cost: how many segments were translated, in how many
        // ACTUAL HTTP requests (batched, so no longer one-to-one with segment count),
        // and at what configured batch size.
        segmentCount: segments.length,
        httpBatchSize: this.httpBatchSize,
        workerRequests: batches.length,
        batchDurationsMs: batchDurations,
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
        translatedSegments: segments.length,
        workerRequests: batches.length,
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
        httpBatchSize: this.httpBatchSize,
        workerRequests: batches.length,
        protectedTokens: protectedCount,
        urls: extractUrls(segments.join("\n")).length,
      },
    });

    return {
      translatedTitle,
      translatedContent,
      tries: 1,
      // The TRUE HTTP call count — batching means this is no longer one per segment.
      // See `translatedSegments`/`httpBatchSize` on `raw` for the segment-level counts.
      modelCalls: batches.length,
      // An NMT engine returns plain strings — there is no JSON to salvage, ever.
      usedRepair: false,
      repairs: [],
      raw: {
        provider: "madlad",
        model: workerModel ?? this.model,
        device: workerDevice,
        durationMs: workerDurationMs || null,
        translatedSegments: translations.length,
        httpBatchSize: this.httpBatchSize,
        workerRequests: batches.length,
        protectedTokens: protectedCount,
      },
    };
  }

  /**
   * One HTTP call to the worker for ONE BATCH of segments, with the envelope and
   * every entry in it fully validated before any of it is trusted.
   *
   * Every failure here is a {@link TranslationTransportError} — the engine did not
   * answer, or did not answer in the agreed shape — which is the only class of
   * failure a fallback may ever consider. Nothing is allowed through on a guess: a
   * reply missing its `texts` array, carrying another provider's envelope, holding
   * the wrong number of entries, or holding one empty/non-string entry FAILS THE
   * WHOLE BATCH — never repaired, never partially accepted, so a corrupt or
   * incomplete batch reply can never leave one segment silently untranslated while
   * its neighbours are stored as if the article were complete.
   */
  private async callWorkerBatch(
    texts: string[],
    targetLang: string,
    budgetMs: number,
    /** Article-level index of this batch's FIRST segment — for diagnosable errors. */
    startIndex: number,
    batchIndex: number,
    batchCount: number,
    totalSegments: number
  ): Promise<BatchReply> {
    const url = this.workerUrl.replace(/\/+$/, "");
    const where = `batch ${batchIndex + 1}/${batchCount}`;

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
          texts,
          sourceLanguage: this.sourceLang,
          targetLanguage: targetLang,
        }),
        signal: requestSignal(Math.min(MADLAD_REQUEST_TIMEOUT_MS, Math.max(1, budgetMs))),
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

    let data: MadladBatchWorkerReply;
    try {
      data = (await res.json()) as MadladBatchWorkerReply;
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
    // accidentally wired to `/generate` returns a perfectly shaped reply and the
    // pipeline stores a chat model's output under MADLAD's name — the one confusion
    // that would invalidate every comparison this integration exists to make.
    if (typeof data.provider !== "string" || data.provider.toLowerCase() !== "madlad") {
      throw new TranslationTransportError(
        `MADLAD worker returned a foreign envelope (${where}): provider=${JSON.stringify(data.provider)}`
      );
    }

    if (!Array.isArray(data.texts)) {
      throw new TranslationTransportError(
        `MADLAD worker returned no texts array (${where}): got ${typeof data.texts}`
      );
    }
    if (data.texts.length !== texts.length) {
      throw new TranslationTransportError(
        `MADLAD worker returned ${data.texts.length} translation(s) for ${texts.length} ` +
          `segment(s) requested (${where})`
      );
    }

    const validated: string[] = [];
    for (let i = 0; i < data.texts.length; i += 1) {
      const entry: unknown = data.texts[i];
      const segmentWhere = `segment ${startIndex + i + 1}/${totalSegments} (${where})`;
      if (typeof entry !== "string") {
        throw new TranslationTransportError(
          `MADLAD worker returned no text for ${segmentWhere}: got ${typeof entry}`
        );
      }
      const trimmed = entry.trim();
      if (trimmed.length === 0) {
        // Silently accepting this would drop the segment's paragraph from the article
        // and report success. A translator that answers nothing has not answered.
        throw new TranslationTransportError(
          `MADLAD worker returned an empty translation for ${segmentWhere} ` +
            `(${texts[i].length} characters sent)`
        );
      }
      validated.push(trimmed);
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
      texts: validated,
      model,
      device: typeof data.device === "string" ? data.device : null,
      durationMs: typeof data.durationMs === "number" ? data.durationMs : null,
    };
  }
}
