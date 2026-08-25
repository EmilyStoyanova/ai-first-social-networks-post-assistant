import { requestSignal } from "@/lib/http/request-deadline";
import { GenerationTracer } from "@/lib/generation-trace/tracer";
import type {
  ArticleTranslation,
  ArticleTranslationContext,
  ArticleTranslationRequest,
  TranslationProvider,
} from "./translation-provider";
import { TranslationPartialProgressError, TranslationTransportError } from "./translation-provider";
import { TranslationTimeoutError, withTranslationTimeout } from "./translation-timeout";
import { reassembleArticle, segmentArticle } from "./madlad-segmentation";
import { assertUsableTranslation } from "./translated-text-validation";
import {
  extractUrls,
  protectTokens,
  restoreTokens,
  type ProtectedText,
  type ProtectedValue,
} from "./protected-tokens";
import { buildTranslationPrompts, TranslationParseError } from "@/lib/ai/feed-item-translation";
import {
  emptyRepairReport,
  isDataOnlySegment,
  maxRepairsFor,
  MIN_REPAIR_BUDGET_MS,
  originalSegments,
  repairedSegments,
  REPAIR_BUDGET_MS,
  unpreservedValues,
  type RepairReport,
  type ResolveRepairProvider,
} from "./segment-repair";

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
 * The repair facts every log line, trace step and stored payload reports, under ONE
 * set of names so a reader never has to correlate three different spellings.
 *
 * A segment that stayed English is named explicitly and counted separately from one
 * that was successfully repaired — the two are very different things to a reader, and
 * collapsing them into a single "repairs" number would hide exactly the case that
 * matters: text the pipeline chose not to translate.
 */
function repairMetadata(report: RepairReport): Record<string, unknown> {
  const repaired = repairedSegments(report);
  const original = originalSegments(report);
  return {
    repairedSegments: repaired.length,
    fallbackToOriginalSegments: original.length,
    repairedSegmentIndices: repaired,
    fallbackSegmentIndices: original,
    repairProvider: report.provider,
    repairModel: report.model,
    repairFailureReasons: report.records
      .filter((r) => r.reason !== null)
      .map((r) => ({ segment: r.segment, reason: r.reason, lostValues: r.lostValues ?? [] })),
  };
}

/**
 * The bypass facts, under their OWN names.
 *
 * Deliberately separate from the repair counters: a bypassed segment was never sent,
 * never repaired and never fell back, so folding it into `repairedSegments` or
 * `fallbackToOriginalSegments` would overstate both and hide the one thing a reader
 * needs to know — that the pipeline recognised the segment as data and left it alone.
 */
function dataOnlyMetadata(indices: readonly number[]): Record<string, unknown> {
  return {
    bypassedDataOnlySegments: indices.length,
    bypassedDataOnlyIndices: [...indices],
  };
}

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
    private readonly httpBatchSize: number = 30,
    /**
     * Builds the engine that repairs a segment MADLAD could not carry — see
     * segment-repair.ts. Optional: with no resolver (or one that yields null) a
     * segment that cannot be restored keeps its original English, which is the same
     * graceful degradation an unusable repair produces. Called AT MOST ONCE per
     * article, and only after a segment has actually failed, so a healthy article
     * never resolves an LLM at all.
     */
    private readonly resolveRepairProvider: ResolveRepairProvider | null = null
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

    // A segment that is nothing BUT protected values — a flattened spec-table cell like
    // "44GB" or "43.2PB/sec" — carries no language at all, and a successful restoration
    // would hand back its source byte for byte anyway. It is therefore never sent: the
    // model can only damage it (a lone "[[0]]" comes back as "[0]"), and on feed item
    // 67e084f6 that was 23 of 33 restoration failures. See isDataOnlySegment.
    const dataOnly = protectedSegments.map(isDataOnlySegment);
    const dataOnlyIndices = dataOnly.flatMap((v, i) => (v ? [i + 1] : []));
    /** Article indices, in order, of the segments actually sent to the worker. */
    const sendIndices = segments.map((_, i) => i).filter((i) => !dataOnly[i]);

    if (sendIndices.length === 0) {
      // Every segment is data. Storing it verbatim would record an untranslated article
      // as "completed", so this fails loudly instead — a parse failure rather than a
      // transport one, because the engine is fine and the INPUT is not translatable.
      throw new TranslationParseError(
        `Nothing translatable in ${segments.length} segment(s) — every segment is protected data.`,
        "empty_translation"
      );
    }

    // ── Resumption ────────────────────────────────────────────────────────────
    // Segments an EARLIER, capped call for this same article already translated (raw,
    // pre-restoration). Empty on a first call and on every article whose estimate fits
    // one item budget — see ArticleTranslationContext.resumeSegments.
    const resumeSegments = context.resumeSegments ?? {};
    const pendingIndices = sendIndices.filter((i) => !(i in resumeSegments));

    // HTTP batches — see DEFAULT_MADLAD_HTTP_BATCH_SIZE. Computed up front: chunking is
    // deterministic, so the planned request count is known before the first call.
    // Batches carry ARTICLE indices, so a batch knows which segment each entry is and
    // every diagnostic stays article-level even though the bypassed ones are absent.
    // `totalBatches` is the whole article's plan (diagnostics + the "is this article
    // done yet" check below); `pendingBatches` is what THIS attempt still needs to run.
    const totalBatches = chunkIntoBatches(sendIndices, this.httpBatchSize);
    const pendingBatches = chunkIntoBatches(pendingIndices, this.httpBatchSize);
    const processedBatchCountBefore = totalBatches.length - pendingBatches.length;

    // `maxBatchesThisCall` caps how many of the PENDING batches this call may start —
    // see ArticleTranslationContext.maxBatchesThisCall. Floored at 1 defensively: this
    // provider must never itself be the source of a zero-progress call, regardless of
    // what a caller passes, because a call that starts zero batches would throw
    // TranslationPartialProgressError below reporting no progress at all.
    const batchCap =
      context.maxBatchesThisCall === undefined
        ? undefined
        : Math.max(1, context.maxBatchesThisCall);
    const batchesToRun =
      batchCap === undefined ? pendingBatches : pendingBatches.slice(0, batchCap);

    context.reportTry?.(1);
    console.info("[rss-translation] attempt", {
      feedItemId: request.feedItemId,
      try: 1,
      of: 1,
      engine: "madlad",
      model: this.model,
      segments: segments.length,
      segmentsSent: sendIndices.length,
      bypassedDataOnlySegments: dataOnlyIndices.length,
      httpBatchSize: this.httpBatchSize,
      httpBatchCount: totalBatches.length,
      batchesThisCall: batchesToRun.length,
      processedBatchCount: processedBatchCountBefore,
      remainingBatchCount: pendingBatches.length,
      protectedTokens: protectedCount,
    });

    // The "prompt" for an NMT engine is the batch itself — recorded under the same step
    // type so a MADLAD run reads in the trace timeline exactly where an Ollama one does.
    // Reflects only what THIS call actually sends — a resumed article's earlier batches
    // were traced by the call that ran them.
    tracer.step({
      type: "prompt",
      label: "Segments sent to MADLAD",
      attempt: 1,
      input: {
        sourceLanguage: this.sourceLang,
        targetLanguage: request.targetLang,
        // What actually goes on the wire, placeholders and all — so a trace shows the
        // request as sent rather than a tidied-up version of it. Bypassed data-only
        // segments are absent here because they are genuinely never sent.
        segments: batchesToRun.flat().map((i) => protectedSegments[i].text),
      },
      metadata: {
        engine: "madlad",
        model: this.model,
        segmentCount: segments.length,
        segmentsSent: sendIndices.length,
        httpBatchSize: this.httpBatchSize,
        httpBatchCount: totalBatches.length,
        batchesThisCall: batchesToRun.length,
        contentChars,
        pieces: plan.body.length,
        hasTitle: plan.titleIndex !== null,
        protectedTokens: protectedCount,
        protectedKinds: protectedValues.flat().map((v) => v.kind),
        ...dataOnlyMetadata(dataOnlyIndices),
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
    //
    // `context.attemptTimeoutMs` (TRANSLATION_ATTEMPT_TIMEOUT_MS, 90s) is NOT used
    // here. It is a SHARED, cron-linked constant sized for "one model call" in the
    // shape it has always meant — one Ollama completion, or, before batching existed,
    // one tiny MADLAD segment (see its own doc comment: "a healthy capped-body
    // translation lands in ~45-60s, so 90s is generous"). A BATCH of up to
    // `httpBatchSize` segments is not that shape: a real 29-segment batch in
    // production ran past 90s and was wrongly aborted (feed item
    // 0a0e3631-2fed-4283-b686-3506a31fbc09, 2026-08-20, "MADLAD request exceeded its
    // deadline (batch 1/1)" at 90090ms — exactly `min(attemptTimeoutMs, remainingMs)`
    // with remainingMs still comfortably above it). Reusing that constant here would
    // silently re-impose a per-segment-era limit on a batch-era request, and it is
    // shared with Ollama, so it cannot simply be raised without changing Ollama's
    // own timeout too — which is out of scope.
    //
    // Instead each batch gets a FAIR SHARE of whatever article time is actually
    // left, split across the batches not yet attempted. For a single-batch article
    // (httpBatchCount 1 — exactly the failing case above) this is the entire
    // remaining item budget, which is the direct fix. For a multi-batch article it
    // both prevents an early batch from starving the ones after it (bounded by
    // dividing, not by taking everything) AND is self-correcting: a batch that
    // finishes faster than its share leaves MORE than a flat share for the next
    // one, since remainingMs shrinks by less than budgetMs did. By construction
    // `budgetMs` can never exceed `remainingMs`, so the TOTAL across every batch
    // can never exceed the article's own item deadline either.
    const batchReplies: BatchReply[] = [];
    for (const batch of batchesToRun) {
      const remainingMs = context.itemDeadlineMs - now().getTime();
      if (remainingMs <= 0) throw new TranslationTimeoutError(context.itemTimeoutMs, "item");
      const remainingBatchesThisCall = batchesToRun.length - batchReplies.length;
      const budgetMs = Math.max(1, Math.floor(remainingMs / remainingBatchesThisCall));

      const reply = await withTranslationTimeout(
        this.callWorkerBatch(
          batch.map((i) => protectedSegments[i].text),
          request.targetLang,
          budgetMs,
          // Article-level indices, so an error names the segment the ARTICLE has even
          // though bypassed segments were never in the batch.
          batch,
          // ARTICLE-level batch position (accounts for batches an earlier, capped call
          // already ran), so a resumed article's error messages still read "batch 7/10"
          // rather than restarting the count at 1 for every call.
          processedBatchCountBefore + batchReplies.length,
          totalBatches.length,
          segments.length
        ),
        budgetMs,
        "attempt"
      );
      batchReplies.push(reply);
    }

    // Raw (pre-restoration) reply for every segment translated so far, ARTICLE-indexed —
    // whatever an earlier call banked, plus what THIS call just produced.
    const rawBySegment: Record<string, string> = { ...resumeSegments };
    batchesToRun.forEach((batch, bi) => {
      batch.forEach((articleIndex, pos) => {
        rawBySegment[articleIndex] = batchReplies[bi].texts[pos];
      });
    });
    const processedBatchCount = processedBatchCountBefore + batchesToRun.length;

    if (batchesToRun.length < pendingBatches.length) {
      // The cap stopped us before every PENDING batch ran. What did run is banked, not
      // reassembled or validated — see TranslationPartialProgressError's own comment for why
      // this must never reach the quality gate. The caller persists `translatedSegments`
      // and this same article resumes from here on its next claim, which is what makes
      // this progress rather than a re-run of the same doomed calculation.
      const remainingBatchCount = totalBatches.length - processedBatchCount;
      console.info(
        "[rss-translation] MADLAD batch progress banked — article too large for one call",
        {
          feedItemId: request.feedItemId,
          segments: segments.length,
          httpBatchCount: totalBatches.length,
          processedBatchCount,
          remainingBatchCount,
          progressMade: batchesToRun.length > 0,
          continuationReason: "batch_cap_reached",
        }
      );
      throw new TranslationPartialProgressError(
        `MADLAD article ${request.feedItemId} needs ${totalBatches.length} HTTP batch(es); ` +
          `${processedBatchCount} done, ${remainingBatchCount} remaining.`,
        rawBySegment,
        processedBatchCount,
        totalBatches.length
      );
    }

    // Every pending batch ran (this call or an earlier one) — the article is complete.
    // Back to ARTICLE order and ARTICLE length. A bypassed segment takes its own source
    // text verbatim; everything else takes whichever call's answer translated it.
    const translations: string[] = segments.slice();
    sendIndices.forEach((articleIndex) => {
      translations[articleIndex] = rawBySegment[articleIndex];
    });
    const batchDurations = batchReplies
      .map((reply) => reply.durationMs)
      .filter((ms): ms is number => ms !== null);
    // Sourced from the first batch's own reply rather than a "first to resolve"
    // race, so the reported model/device never depends on completion order. On a
    // resumed article this describes only the FINAL call — earlier calls' replies
    // were not persisted beyond their translated text, only its provenance is lost.
    const workerModel = batchReplies[0]?.model ?? null;
    const workerDevice = batchReplies[0]?.device ?? null;

    const workerDurationMs = batchDurations.reduce((sum, ms) => sum + ms, 0);

    tracer.step({
      type: "llm_call",
      label:
        `MADLAD translate — ${segments.length} segment${segments.length === 1 ? "" : "s"}` +
        ` in ${totalBatches.length} HTTP batch${totalBatches.length === 1 ? "" : "es"}`,
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
        // and at what configured batch size. `workerRequests` counts every batch the
        // article needed, including ones an earlier, capped call already ran.
        segmentCount: segments.length,
        httpBatchSize: this.httpBatchSize,
        workerRequests: totalBatches.length,
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
    let repairReport: RepairReport = emptyRepairReport();

    try {
      // Never GUESSED at: a placeholder that did not come back is not repaired by
      // deciding which value probably belonged where. A segment MADLAD could not carry
      // is re-translated by a DIFFERENT engine and then verified byte-for-byte, or it
      // keeps its original English — see segment-repair.ts.
      const restoration = await this.restoreSegments(
        translations,
        protectedSegments,
        segments,
        dataOnly,
        request,
        context
      );
      repairReport = restoration.report;

      // Two arrays, deliberately: `forGate` is what the quality gate judges and keeps
      // the PLACEHOLDER form for untouched segments (a restored URL is a run of Latin
      // letters, and the Bulgarian check counts letters), while `restored` is what is
      // stored. A repaired or original-English segment is identical in both, so a
      // segment left in English IS shown to the language gate rather than hidden from
      // it — that is what makes the gate a genuine second bound on how much of an
      // article may stay untranslated.
      const placeholderForm = reassembleArticle(plan, restoration.forGate);
      const restoredForm = reassembleArticle(plan, restoration.restored);
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
        workerRequests: totalBatches.length,
        // Reported on the FAILURE path too: "how far did repair get before the article
        // was failed" is the first question asked of an article that hit the cap.
        repairedSegments: repairedSegments(repairReport).length,
        fallbackToOriginalSegments: originalSegments(repairReport).length,
        bypassedDataOnlySegments: dataOnlyIndices.length,
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
        metadata: { ...repairMetadata(repairReport), ...dataOnlyMetadata(dataOnlyIndices) },
      });
      throw err;
    }

    const repaired = repairedSegments(repairReport);
    const leftOriginal = originalSegments(repairReport);
    if (dataOnlyIndices.length > 0) {
      // Its own line, not folded into the repair summary: these segments were never
      // sent and never repaired, and an operator comparing "segments" against
      // "workerRequests × batchSize" needs to see why the two no longer agree.
      console.info("[rss-translation] data-only segments bypassed", {
        feedItemId: request.feedItemId,
        segments: segments.length,
        segmentsSent: sendIndices.length,
        ...dataOnlyMetadata(dataOnlyIndices),
      });
    }
    if (repairReport.records.length > 0) {
      // Never only in the trace: an article carrying English segments must be visible
      // to someone reading logs, not just to someone who opens the run.
      console.info("[rss-translation] segments repaired outside MADLAD", {
        feedItemId: request.feedItemId,
        segments: segments.length,
        repairedSegments: repaired.length,
        fallbackToOriginalSegments: leftOriginal.length,
        repairedIndices: repaired,
        fallbackIndices: leftOriginal,
        repairProvider: repairReport.provider,
        repairModel: repairReport.model,
        reasons: repairReport.records
          .filter((r) => r.reason !== null)
          .map((r) => `${r.segment}: ${r.reason}`),
      });
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
        workerRequests: totalBatches.length,
        protectedTokens: protectedCount,
        urls: extractUrls(segments.join("\n")).length,
        ...repairMetadata(repairReport),
        ...dataOnlyMetadata(dataOnlyIndices),
      },
    });

    return {
      translatedTitle,
      translatedContent,
      tries: 1,
      // The TRUE HTTP call count — batching means this is no longer one per segment.
      // See `translatedSegments`/`httpBatchSize` on `raw` for the segment-level counts.
      // Batch calls PLUS the repair calls — an article that needed repairs cost more
      // than its batches, and reporting only the batches would understate it.
      modelCalls: totalBatches.length + repairReport.records.length,
      // `usedRepair`/`repairs` are the JSON-SALVAGE fields of the prompt-based engine
      // (a truncated reply patched back into valid JSON). An NMT engine has no JSON to
      // salvage, so they stay false/empty here — segment repair is a different thing
      // entirely and is reported under its own names below, deliberately not folded
      // into these, so "did the reply need repairing to parse" keeps meaning exactly
      // what it has always meant.
      usedRepair: false,
      repairs: [],
      raw: {
        provider: "madlad",
        model: workerModel ?? this.model,
        device: workerDevice,
        durationMs: workerDurationMs || null,
        translatedSegments: translations.length,
        httpBatchSize: this.httpBatchSize,
        workerRequests: totalBatches.length,
        protectedTokens: protectedCount,
        ...repairMetadata(repairReport),
        ...dataOnlyMetadata(dataOnlyIndices),
      },
    };
  }

  /**
   * Restores every segment, repairing the ones MADLAD could not carry.
   *
   * Returns two parallel arrays in SOURCE ORDER — index i is always segment i, whether
   * it was restored untouched, repaired, or left English — because reassembly folds
   * them positionally and a reordering here would silently rearrange the article.
   */
  private async restoreSegments(
    translations: readonly string[],
    protectedSegments: readonly ProtectedText[],
    sourceSegments: readonly string[],
    /** Per-segment: was this bypassed as data-only and therefore never sent? */
    dataOnly: readonly boolean[],
    request: ArticleTranslationRequest,
    context: ArticleTranslationContext
  ): Promise<{ restored: string[]; forGate: string[]; report: RepairReport }> {
    const restored: string[] = [];
    const forGate: string[] = [];
    const report = emptyRepairReport();
    const limit = maxRepairsFor(sourceSegments.length);

    /** `undefined` = not resolved yet, `null` = resolved and unavailable. */
    let repairProvider: TranslationProvider | null | undefined = undefined;

    for (let index = 0; index < translations.length; index += 1) {
      const values = protectedSegments[index].values;
      const where = `segment ${index + 1}/${sourceSegments.length}`;

      if (dataOnly[index]) {
        // Never sent, so there is nothing to restore and nothing to verify. The stored
        // text is the source byte for byte — exactly what a successful restoration
        // would have produced, since every value in it was protected. Consumes NO
        // repair quota and is counted under its own metric.
        //
        // It contributes NOTHING to the quality gate, deliberately. The gate judges what
        // the MODEL produced, and no model ran here. Feeding it the placeholder form
        // instead is actively wrong: every such segment renders as "[[0]]" (each segment
        // numbers its own placeholders from zero), so a table of two dozen cells reads to
        // `detectRepetition` as the word "0" repeated two dozen times and condemns a
        // perfectly good article as a decoding loop. Feeding it the SOURCE would be wrong
        // the other way — a run of Latin letters dragging the Bulgarian-share check down.
        // An empty string is the honest answer: this segment was not translated, so it is
        // not evidence either for or against the translation's quality.
        restored.push(sourceSegments[index]);
        forGate.push("");
        continue;
      }

      /** The restoration failure, kept so it can be re-thrown unchanged if unrepairable. */
      let restorationError: unknown;
      try {
        restored.push(restoreTokens(translations[index], values, where));
        forGate.push(translations[index]);
        continue;
      } catch (err) {
        // ── What may be repaired, and nothing else ───────────────────────────
        // ONLY a protected-token restoration failure on a segment that actually had
        // protected values. A repetition loop, a drifted language, a transport fault
        // and a malformed reply all keep their existing semantics and fail the
        // article, because re-translating one segment does not address any of them —
        // and a segment with NO protected values has nothing for the byte-exact check
        // to verify, so a "repair" there would be an unverifiable substitution.
        const repairable =
          err instanceof TranslationParseError &&
          err.reason === "protected_token" &&
          values.length > 0;
        if (!repairable) throw err;
        restorationError = err;
      }

      if (repairProvider === undefined) {
        try {
          repairProvider = (await this.resolveRepairProvider?.()) ?? null;
        } catch {
          repairProvider = null;
        }
        if (repairProvider !== null) {
          report.provider = repairProvider.providerLabel;
          report.model = repairProvider.model;
        }
      }

      // No repair engine at all — so nothing was attempted, nothing was verified, and
      // there is no evidence on which to keep a segment. This is the pre-repair
      // behaviour, preserved exactly: reject the article rather than storing text the
      // pipeline never checked. Graceful degradation to the original English is what a
      // deployment gets by CONFIGURING a repair engine, not something it gets by
      // omission — see repairSegment for the cases it then covers.
      if (repairProvider === null) throw restorationError;

      if (report.records.length >= limit) {
        // Deliberately fails the WHOLE article rather than storing one that is mostly
        // English. See MAX_REPAIR_SHARE for how the bound was measured.
        throw new TranslationParseError(
          `Translation needed more than ${limit} repaired segment(s) of ` +
            `${sourceSegments.length} — the article is too damaged to store ` +
            `(repaired ${repairedSegments(report).join(", ") || "none"}; ` +
            `kept original ${originalSegments(report).join(", ") || "none"}).`,
          "protected_token"
        );
      }

      const outcome = await this.repairSegment(
        sourceSegments[index],
        values,
        repairProvider,
        request,
        context,
        where
      );
      report.records.push({ segment: index + 1, ...outcome.record });
      restored.push(outcome.text);
      forGate.push(outcome.text);
    }

    return { restored, forGate, report };
  }

  /**
   * Re-translates ONE segment with the repair engine, or reports why the original was
   * kept. Never throws except when the ARTICLE's own deadline has already passed.
   */
  private async repairSegment(
    source: string,
    values: readonly ProtectedValue[],
    provider: TranslationProvider,
    request: ArticleTranslationRequest,
    context: ArticleTranslationContext,
    where: string
  ): Promise<{
    text: string;
    record: { outcome: "repaired" | "original"; reason: string | null; lostValues?: string[] };
  }> {
    const keepOriginal = (reason: string, lostValues?: string[]) => ({
      text: source,
      record: { outcome: "original" as const, reason, ...(lostValues ? { lostValues } : {}) },
    });

    const remainingMs = context.itemDeadlineMs - context.now().getTime();
    // Already past the article's budget: that is a timeout for the article, not a
    // fallback decision, and it is reported exactly as the batch loop reports it.
    if (remainingMs <= 0) throw new TranslationTimeoutError(context.itemTimeoutMs, "item");
    if (remainingMs < MIN_REPAIR_BUDGET_MS) {
      return keepOriginal(
        `only ${remainingMs}ms of the item budget remained, below the ${MIN_REPAIR_BUDGET_MS}ms a repair needs`
      );
    }

    // The repair engine receives the ORIGINAL segment with its real identifiers — never
    // the `[[n]]` form. A prompt-based model is instructed to keep brand and model
    // strings unchanged, which is the whole reason it can succeed where MADLAD cannot;
    // handing it placeholders would recreate the very problem being repaired.
    //
    // `content: null` puts buildTranslationPrompts into its `title_only` mode, whose
    // schema is `{"title": "..."}` and whose prompt explicitly forbids inventing a
    // body. That mode already existed; nothing about prompt generation is duplicated
    // here, and the engine's own 3000-char article cap is irrelevant to one segment.
    const prompts = buildTranslationPrompts(source, null, request.targetLang);
    const budgetMs = Math.min(REPAIR_BUDGET_MS, remainingMs);

    let result;
    try {
      result = await provider.translate(
        { ...request, title: source, content: null, mode: prompts.mode, prompts },
        {
          ...context,
          // A NARROWED context is what bounds the repair: the prompt engine enforces
          // its own budget from these two fields, so no timeout logic is duplicated
          // and its behaviour is not modified. `reportTry` is dropped so a repair's
          // internal regenerations never inflate the ARTICLE's attempt count.
          attemptTimeoutMs: Math.min(context.attemptTimeoutMs, budgetMs),
          itemDeadlineMs: context.now().getTime() + budgetMs,
          itemTimeoutMs: budgetMs,
          tracer: GenerationTracer.disabled(),
          reportTry: undefined,
        }
      );
    } catch (err) {
      return keepOriginal(
        `repair engine failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const translated = result.translatedTitle;
    if (translated === null || translated.trim().length === 0) {
      return keepOriginal("repair engine returned nothing");
    }

    // The bar the whole mechanism exists for. Measured on real segments, the prompt
    // engine transliterates an identifier often enough that trusting it would just
    // move the silent corruption one engine along ("Gen.2" → "Ген.2").
    const lost = unpreservedValues(values, translated);
    if (lost.length > 0) {
      return keepOriginal(
        `repair did not preserve ${lost.join(", ")} byte-identically in ${where}`,
        lost
      );
    }

    return { text: translated.trim(), record: { outcome: "repaired", reason: null } };
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
    /**
     * Article-level index (0-based) of each entry in `texts`, in the same order.
     * Carried rather than derived from a start offset because data-only segments are
     * bypassed, so a batch's entries are no longer contiguous in the article.
     */
    articleIndices: readonly number[],
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
        // `budgetMs` is the caller's fair-share-of-remaining-article-time budget (see
        // `translate()`), already bounded by the item deadline — no separate fixed
        // ceiling is applied here. A previous fixed ceiling (120s) was removed after
        // it was proven wrong by a real production batch (see `translate()`'s
        // comment); a hardcoded guess is exactly the failure class this fix removes,
        // not one to reintroduce at a different number.
        signal: requestSignal(Math.max(1, budgetMs)),
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
      const segmentWhere = `segment ${articleIndices[i] + 1}/${totalSegments} (${where})`;
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
