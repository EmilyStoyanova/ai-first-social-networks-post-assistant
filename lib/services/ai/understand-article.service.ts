import type { ILlmProvider } from "@/lib/ai/types";
import { fitsSingleClassificationCall } from "@/lib/ai/feed-item-classification";
import {
  planClassificationChunks,
  aggregateChunkAnalyses,
  buildChunkAnalysisRepairPrompt,
  buildChunkAnalysisSystemPrompt,
  buildChunkAnalysisUserPrompt,
  parseChunkAnalysisResponse,
  ChunkAnalysisParseError,
  CHUNK_ANALYSIS_JSON_SCHEMA,
  MAX_CHUNK_ANALYSIS_OUTPUT_TOKENS,
  type ChunkAnalysis,
} from "@/lib/ai/classification-chunk-analysis";
import {
  buildArticleUnderstandingDirectPrompt,
  buildArticleUnderstandingRepairPrompt,
  buildArticleUnderstandingSynthesisPrompt,
  buildArticleUnderstandingSystemPrompt,
  parseArticleUnderstandingResponse,
  reduceForSynthesis,
  computeConfidenceSignals,
  confidenceCeiling,
  ARTICLE_UNDERSTANDING_JSON_SCHEMA,
  MAX_UNDERSTANDING_OUTPUT_TOKENS,
  type ArticleUnderstanding,
  type ArticleUnderstandingOutcome,
} from "@/lib/ai/article-understanding";

/**
 * Produces the ONE `ArticleUnderstanding` a whole article resolves to.
 *
 * Short articles are read directly, in one call. Long articles are split and
 * analyzed chunk by chunk (reusing `classification-chunk-analysis.ts` — the
 * exact same per-chunk prompt, parser, and repair loop `classify-feed-item.service.ts`
 * already uses), reduced (`reduceForSynthesis`, never a hard "first N" cap —
 * see that function's own comment), and handed to ONE global synthesis call
 * that never sees raw article text, only the reduced distillation of every
 * chunk. Per-chunk `centrality` is a HINT the synthesis prompt renders under a
 * CENTRAL/CONTEXT heading; the synthesis call alone decides the article's real
 * subject, thesis, conflict, and topic tiers — no chunk decides this on its
 * own.
 *
 * Pure of persistence: unlike `classify-feed-item.service.ts`, this has no
 * DB row of its own (no claim, no lease, no cross-run resumability) — a
 * process restart mid-run simply re-runs from the top. That is an accepted
 * scoping choice, not an oversight: understanding has nothing yet to persist
 * partial progress INTO. A caller that wants resumability can add a stored
 * progress column and adapt this loop, mirroring classification's own,
 * without changing anything in `lib/ai/article-understanding.ts`.
 */

export interface UnderstandArticleInput {
  title: string | null;
  body: string;
}

export interface UnderstandArticleDeps {
  provider: ILlmProvider;
  /**
   * Provider/model labels for rejection diagnostics only — never read to decide
   * behavior. Omitted callers (tests, mostly) log "unknown" rather than failing.
   */
  providerLabel?: string;
  model?: string;
  now?: () => Date;
  /** Wall-clock cap for ONE model call. Overridable so tests need not wait. */
  attemptTimeoutMs?: number;
  /** Extra calls one step (a chunk, or the synthesis) may spend repairing its own reply. */
  maxRepairAttempts?: number;
}

/** First N characters of a model reply, bounded so a rejection log never carries the whole article back out through its echo. */
const RESPONSE_PREVIEW_CHARS = 500;
function previewOf(text: string | null | undefined): string {
  return (text ?? "").slice(0, RESPONSE_PREVIEW_CHARS);
}

export type UnderstandArticleOutcome =
  | {
      status: "ok";
      understanding: ArticleUnderstanding;
      chunkCount: number;
      usedChunking: boolean;
    }
  | { status: "failed"; error: string };

export const UNDERSTANDING_ATTEMPT_TIMEOUT_MS = 60_000;
export const MAX_UNDERSTANDING_REPAIR_ATTEMPTS = 1;

export class ArticleUnderstandingTimeoutError extends Error {
  constructor(ms: number) {
    super(`Article understanding call exceeded its ${ms}ms budget.`);
    this.name = "ArticleUnderstandingTimeoutError";
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ArticleUnderstandingTimeoutError(ms)), ms);
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

/**
 * Analyzes ONE chunk, with its own repair attempt — the exact contract
 * `classify-feed-item.service.ts`'s `analyzeChunk` uses, minus the DB-backed
 * cross-run banking that has no equivalent here yet (see the module comment).
 * Returns `null` (never throws) when the chunk could not be reliably
 * analyzed after repair — the caller decides what a lost chunk means for the
 * whole run.
 */
async function analyzeOneChunk(
  chunkIndex: number,
  chunkText: string,
  chunkCount: number,
  title: string | null,
  provider: ILlmProvider,
  attemptTimeoutMs: number,
  maxRepairs: number,
  providerLabel: string,
  model: string
): Promise<ChunkAnalysis | null> {
  const systemPrompt = buildChunkAnalysisSystemPrompt();
  let userPrompt = buildChunkAnalysisUserPrompt({ title, chunkText, chunkIndex, chunkCount });

  for (let call = 1; call <= maxRepairs + 1; call++) {
    let text: string | null;
    try {
      const response = await withTimeout(
        provider.generate({
          systemPrompt,
          userPrompt,
          temperature: 0,
          maxTokens: MAX_CHUNK_ANALYSIS_OUTPUT_TOKENS,
          format: CHUNK_ANALYSIS_JSON_SCHEMA,
        }),
        attemptTimeoutMs
      );
      text = response.text;
    } catch (err) {
      console.warn("[article-understanding] chunk analysis call failed", {
        chunkIndex,
        chunkCount,
        call,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    let parsed;
    try {
      parsed = parseChunkAnalysisResponse(text);
    } catch (err) {
      if (err instanceof ChunkAnalysisParseError) {
        console.warn("[article-understanding] chunk analysis returned empty response", {
          chunkIndex,
          chunkCount,
          call,
        });
        return null;
      }
      throw err;
    }

    if (parsed.status === "ok") {
      const { status: _status, ...analysis } = parsed;
      return analysis;
    }

    const willRepair = call <= maxRepairs;
    if (!willRepair) {
      console.warn("[article-understanding] chunk analysis untrustworthy after repair", {
        provider: providerLabel,
        model,
        chunkIndex,
        chunkCount,
        problem: parsed.problem,
        responsePreview: previewOf(text),
      });
      return null;
    }
    userPrompt = buildChunkAnalysisRepairPrompt(userPrompt, text ?? "", parsed.feedback);
  }
  return null;
}

/**
 * Asks the global-synthesis (or direct) call once, and once more with the
 * exact problem named if the reply cannot be trusted. Shared by both paths —
 * they differ only in which prompt built the request and how many real
 * chunks bound `evidence[].chunkIndex`.
 */
async function askUnderstandingUntilUsable(
  userPrompt: string,
  systemPrompt: string,
  totalChunkCount: number,
  provider: ILlmProvider,
  attemptTimeoutMs: number,
  maxRepairs: number,
  providerLabel: string,
  model: string
): Promise<ArticleUnderstandingOutcome> {
  let prompt = userPrompt;
  let last: ArticleUnderstandingOutcome | null = null;

  for (let call = 1; call <= maxRepairs + 1; call++) {
    const response = await withTimeout(
      provider.generate({
        systemPrompt,
        userPrompt: prompt,
        temperature: 0,
        maxTokens: MAX_UNDERSTANDING_OUTPUT_TOKENS,
        format: ARTICLE_UNDERSTANDING_JSON_SCHEMA,
      }),
      attemptTimeoutMs
    );

    const parsed = parseArticleUnderstandingResponse(response.text, totalChunkCount);
    if (parsed.status === "ok") return parsed;

    last = parsed;
    const willRepair = call <= maxRepairs;
    console.warn("[article-understanding] synthesis reply rejected", {
      provider: providerLabel,
      model,
      call,
      problem: parsed.problem,
      responsePreview: previewOf(response.text),
      willRepair,
    });
    if (!willRepair) break;
    prompt = buildArticleUnderstandingRepairPrompt(
      userPrompt,
      response.text ?? "",
      parsed.feedback
    );
  }

  return last!;
}

export async function understandArticle(
  input: UnderstandArticleInput,
  deps: UnderstandArticleDeps
): Promise<UnderstandArticleOutcome> {
  const attemptTimeoutMs = deps.attemptTimeoutMs ?? UNDERSTANDING_ATTEMPT_TIMEOUT_MS;
  const maxRepairs = deps.maxRepairAttempts ?? MAX_UNDERSTANDING_REPAIR_ATTEMPTS;
  const providerLabel = deps.providerLabel ?? "unknown";
  const model = deps.model ?? "unknown";
  const body = input.body.trim();
  const articleChars = body.length;

  console.info("[article-understanding] starting", { articleChars, title: input.title ?? null });

  try {
    if (fitsSingleClassificationCall(body)) {
      const systemPrompt = buildArticleUnderstandingSystemPrompt("direct");
      const userPrompt = buildArticleUnderstandingDirectPrompt({ title: input.title, body });

      const outcome = await askUnderstandingUntilUsable(
        userPrompt,
        systemPrompt,
        1,
        deps.provider,
        attemptTimeoutMs,
        maxRepairs,
        providerLabel,
        model
      );
      if (outcome.status !== "ok") {
        return { status: "failed", error: outcome.problem };
      }

      const { status: _status, ...understanding } = outcome;
      logResult(articleChars, 1, false, understanding);
      return { status: "ok", understanding, chunkCount: 1, usedChunking: false };
    }

    const chunked = planClassificationChunks(input.title, body);
    const chunkCount = chunked.chunks.length;
    console.info("[article-understanding] article split into chunks", {
      articleChars,
      chunkCount,
    });

    const analyses: ChunkAnalysis[] = [];
    for (let i = 0; i < chunked.chunks.length; i++) {
      const analysis = await analyzeOneChunk(
        i,
        chunked.chunks[i].text,
        chunkCount,
        input.title,
        deps.provider,
        attemptTimeoutMs,
        maxRepairs,
        providerLabel,
        model
      );
      if (analysis === null) {
        return {
          status: "failed",
          error: `Could not reliably analyze chunk ${i + 1}/${chunkCount}.`,
        };
      }
      analyses.push(analysis);
      console.info("[article-understanding] chunk analyzed", {
        chunkIndex: i,
        chunkCount,
        mainPoint: analysis.mainPoint,
        centrality: analysis.centrality,
      });
    }

    const points = reduceForSynthesis(analyses);
    const aggregate = aggregateChunkAnalyses(analyses);
    const signals = computeConfidenceSignals(analyses);
    const ceiling = confidenceCeiling(signals);

    const systemPrompt = buildArticleUnderstandingSystemPrompt("synthesis");
    const userPrompt = buildArticleUnderstandingSynthesisPrompt({
      title: input.title,
      totalChunkCount: chunkCount,
      points,
      topics: aggregate.topics,
      entities: aggregate.entities,
      importantFacts: aggregate.importantFacts,
    });

    const outcome = await askUnderstandingUntilUsable(
      userPrompt,
      systemPrompt,
      chunkCount,
      deps.provider,
      attemptTimeoutMs,
      maxRepairs,
      providerLabel,
      model
    );
    if (outcome.status !== "ok") {
      return { status: "failed", error: outcome.problem };
    }

    const { status: _status, confidence: modelConfidence, ...rest } = outcome;
    const understanding: ArticleUnderstanding = {
      ...rest,
      confidence: Math.min(modelConfidence, ceiling),
    };

    console.info("[article-understanding] global synthesis", {
      articleChars,
      chunkCount,
      centralShare: signals.centralShare,
      topicCoherence: signals.topicCoherence,
      confidenceCeiling: ceiling,
      modelConfidence,
    });
    logResult(articleChars, chunkCount, true, understanding);

    return { status: "ok", understanding, chunkCount, usedChunking: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn("[article-understanding] FAILED", { articleChars, error });
    return { status: "failed", error };
  }
}

function logResult(
  articleChars: number,
  chunkCount: number,
  usedChunking: boolean,
  understanding: ArticleUnderstanding
): void {
  console.info("[article-understanding] final understanding", {
    articleChars,
    chunkCount,
    usedChunking,
    mainSubject: understanding.mainSubject,
    centralThesis: understanding.centralThesis,
    centralConflict: understanding.centralConflict,
    articleType: understanding.articleType,
    confidence: understanding.confidence,
    evidenceChunks: understanding.evidence.map((e) => e.chunkIndex),
  });
}
