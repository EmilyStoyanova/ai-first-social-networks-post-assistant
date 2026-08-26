/**
 * Whole-article classification — chunk analysis.
 *
 * Classification used to see the article through a keyhole: either the whole
 * short body, or a hand-picked approximation of a long one (first a blind
 * `slice(0, N)`, then a beginning/middle/end sample). Both are guesses about
 * where an article's real subject lives. This module is the alternative: read
 * EVERY part of a long article with the same local model classification
 * already uses, distilling each bounded section into a small structured
 * record — then hand the FINAL classifier the synthesis of all of them,
 * never a sample of the raw text.
 *
 * Reuses the natural-boundary splitter translation already has
 * (`chunkArticleForTranslation`) rather than re-deriving sentence/paragraph
 * boundaries — the packing problem (fit sentences into a bounded chunk
 * without cutting mid-sentence or mid-word) is identical; only the PURPOSE of
 * a chunk differs (summarize it here, translate it there). Reuses
 * `findJsonObject`/`asString` from `feed-item-classification.ts` for the same
 * reason: one JSON-extraction scan, not a second copy of it.
 *
 * Pure logic only — no I/O, no Prisma, no provider. `classify-feed-item.service.ts`
 * is what calls a model with these prompts and persists the result.
 */

import { chunkArticleForTranslation, type ChunkedArticle } from "./translation/ollama-chunking";
import { asString, findJsonObject } from "./feed-item-classification";

// ─── Chunking ───────────────────────────────────────────────────────────────

/**
 * Hard ceiling on one chunk's character count, for the ANALYSIS call (not the
 * final synthesis, which has its own bound — see `MAX_AGGREGATE_*` below).
 *
 * Matches translation's own proven chunk size (`OLLAMA_CHUNK_MAX_CHARS`)
 * deliberately: it is served by the same worker under the same latency and
 * output-token budget already measured safe for a single call, and a chunk
 * analysis reply is if anything SMALLER than a chunk translation, so nothing
 * about reusing that number is a stretch.
 */
export const CLASSIFICATION_CHUNK_MAX_CHARS = 3000;

/** See `OLLAMA_CHUNK_TARGET_MIN_CHARS` — same packing heuristic, same reason. */
export const CLASSIFICATION_CHUNK_TARGET_MIN_CHARS = 2500;

/**
 * Splits a (translated) article body into natural-boundary chunks for
 * per-chunk classification analysis.
 *
 * Delegates entirely to `chunkArticleForTranslation` — the same sentence-
 * and-paragraph-aware packer translation uses — sized for this call instead
 * of a translation call. No boundary-finding logic is reimplemented here.
 */
export function planClassificationChunks(title: string | null, body: string): ChunkedArticle {
  return chunkArticleForTranslation(title, body, {
    maxChunkChars: CLASSIFICATION_CHUNK_MAX_CHARS,
    targetMinChars: CLASSIFICATION_CHUNK_TARGET_MIN_CHARS,
  });
}

// ─── The per-chunk reply ────────────────────────────────────────────────────

export const CHUNK_CENTRALITY = ["central", "supporting"] as const;
export type ChunkCentrality = (typeof CHUNK_CENTRALITY)[number];

/** Per-field and per-list caps — deliberately small: this is a DISTILLATION, not a copy. */
export const MAX_CHUNK_MAIN_POINT_CHARS = 220;
export const MAX_CHUNK_LIST_ITEM_CHARS = 60;
export const MAX_CHUNK_FACT_CHARS = 220;
export const MAX_CHUNK_TOPICS = 6;
export const MAX_CHUNK_ENTITIES = 8;
export const MAX_CHUNK_FACTS = 4;

/** Output ceiling for one chunk-analysis call — smaller than the final verdict's. */
export const MAX_CHUNK_ANALYSIS_OUTPUT_TOKENS = 400;
export const CHUNK_ANALYSIS_ATTEMPT_TIMEOUT_MS = 45_000;

/**
 * One chunk's distilled record. Company-agnostic and topic-agnostic on
 * purpose: a chunk's `topics` are FREEFORM — what this piece of text is
 * actually about, in the model's own words — not matched against any
 * company's configured list. Matching against the company's real topics is
 * the FINAL classifier's job, over the aggregate of every chunk; keeping
 * chunk analysis free of that dependency is what makes it valid to bank and
 * resume across an interrupted run without re-deriving it if the company's
 * topic configuration happens to change mid-run.
 */
export interface ChunkAnalysis {
  /** One sentence: what THIS section says. */
  mainPoint: string;
  /** Freeform subjects this section discusses. May be empty. */
  topics: string[];
  /** People, places, organizations, or named products mentioned. May be empty. */
  entities: string[];
  /** Concrete facts, figures, quotes, or claims worth remembering. May be empty. */
  importantFacts: string[];
  /**
   * Whether this section carries part of the article's own main thesis,
   * argument, or central conflict (`central`), or is background, scene-
   * setting, an example, or incidental context (`supporting`). This is the
   * signal the final classifier uses to stop a frequent but incidental
   * mention from outweighing the article's real subject.
   */
  centrality: ChunkCentrality;
}

export const CHUNK_ANALYSIS_JSON_SCHEMA = {
  type: "object",
  properties: {
    mainPoint: { type: "string" },
    topics: { type: "array", items: { type: "string" } },
    entities: { type: "array", items: { type: "string" } },
    importantFacts: { type: "array", items: { type: "string" } },
    centrality: { type: "string", enum: ["central", "supporting"] },
  },
  required: ["mainPoint", "topics", "entities", "importantFacts", "centrality"],
  additionalProperties: false,
} as const;

export type ChunkAnalysisOutcome =
  ({ status: "ok" } & ChunkAnalysis) | { status: "invalid"; problem: string; feedback: string };

export class ChunkAnalysisParseError extends Error {
  readonly code = "CHUNK_ANALYSIS_EMPTY_RESPONSE" as const;
  constructor(message: string) {
    super(message);
    this.name = "ChunkAnalysisParseError";
  }
}

function invalidChunk(problem: string, feedback: string): ChunkAnalysisOutcome {
  return { status: "invalid", problem, feedback };
}

/** Exported so `article-understanding.ts` reuses it for its own reply shapes. */
export function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const s = asString(entry);
    if (s !== null) out.push(s);
  }
  return out;
}

/** Exported so `article-understanding.ts` reuses it for its own reply shapes. */
export function capList(list: string[], itemCap: number, listCap: number): string[] {
  return list.slice(0, listCap).map((s) => s.slice(0, itemCap));
}

/**
 * Parses and vets ONE chunk's reply. Mirrors `parseClassificationResponse`'s
 * shape (a `findJsonObject` scan, a throw on a genuinely empty reply, an
 * `invalid` outcome — with actionable feedback — for anything that parses but
 * cannot be trusted) so both replies are repaired the same way by their
 * respective callers.
 */
export function parseChunkAnalysisResponse(raw: string | null | undefined): ChunkAnalysisOutcome {
  const text = (raw ?? "").trim();
  if (text === "") {
    throw new ChunkAnalysisParseError("The chunk-analysis model returned an empty response.");
  }

  const json = findJsonObject(text);
  if (json === null) {
    return invalidChunk(
      "The chunk-analysis model replied with prose instead of the required JSON object.",
      "Your reply was not JSON. Answer with a SINGLE JSON object and nothing else — no prose before or after it, no markdown fences."
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return invalidChunk(
      "The chunk-analysis model's JSON could not be parsed.",
      "Your JSON was malformed. Answer again with a single valid JSON object, and check that every string is quoted and every list closed."
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalidChunk(
      "The chunk-analysis model's reply was not a JSON object.",
      "Answer with a single JSON object with the keys described, not an array or a bare value."
    );
  }

  const obj = parsed as Record<string, unknown>;

  const mainPoint = asString(obj.mainPoint);
  if (!mainPoint) {
    return invalidChunk(
      "The reply did not say what this section is about.",
      'The "mainPoint" field must be one sentence describing what THIS section says.'
    );
  }

  const centralityRaw = asString(obj.centrality)?.toLowerCase();
  if (centralityRaw !== "central" && centralityRaw !== "supporting") {
    return invalidChunk(
      `The centrality was missing or not "central"/"supporting" (got ${JSON.stringify(obj.centrality)}).`,
      'The "centrality" field must be exactly "central" or "supporting".'
    );
  }

  return {
    status: "ok",
    mainPoint: mainPoint.slice(0, MAX_CHUNK_MAIN_POINT_CHARS),
    topics: capList(toStringList(obj.topics), MAX_CHUNK_LIST_ITEM_CHARS, MAX_CHUNK_TOPICS),
    entities: capList(toStringList(obj.entities), MAX_CHUNK_LIST_ITEM_CHARS, MAX_CHUNK_ENTITIES),
    importantFacts: capList(
      toStringList(obj.importantFacts),
      MAX_CHUNK_FACT_CHARS,
      MAX_CHUNK_FACTS
    ),
    centrality: centralityRaw,
  };
}

export function buildChunkAnalysisSystemPrompt(): string {
  return [
    "You are reading ONE section of a longer news article, out of several. Your job is not to summarize the whole article — only this section — into a small structured record another process will use to judge the article's overall subject later.",
    "",
    "Reply with a single JSON object and nothing else:",
    "",
    "{",
    '  "mainPoint": "<one sentence: what THIS section says>",',
    '  "topics": ["<a short phrase naming a subject this section discusses>"],',
    '  "entities": ["<a person, place, organization, or named product mentioned>"],',
    '  "importantFacts": ["<a concrete fact, figure, quote, or claim worth remembering>"],',
    '  "centrality": "central" | "supporting"',
    "}",
    "",
    '"central" means this section carries part of the article\'s OWN main thesis, argument, or central conflict — the thing a reader would say the WHOLE article is fundamentally about. "supporting" means this section is background, scene-setting, a passing example, colour, or incidental context that serves the story without itself being what the article is about.',
    "",
    "Judge centrality by what the section IS ABOUT, never by its length or how many named things it mentions — a short section can be central, and a long, detail-heavy section can still be merely supporting context. A travelogue's scenic description is supporting even when it runs long; a single sentence naming the actual conflict or event the piece is built around is central.",
    "",
    '"topics" and "entities" may be empty arrays. "importantFacts" may be empty — never invent one to fill it.',
  ].join("\n");
}

export function buildChunkAnalysisUserPrompt(input: {
  title: string | null;
  chunkText: string;
  chunkIndex: number;
  chunkCount: number;
}): string {
  return [
    `Article title: ${input.title?.trim() || "(untitled)"}`,
    `Section ${input.chunkIndex + 1} of ${input.chunkCount}:`,
    "",
    input.chunkText,
  ].join("\n");
}

/** Mirrors `buildClassificationRepairPrompt` — the request plus the exact problem. */
export function buildChunkAnalysisRepairPrompt(
  originalUserPrompt: string,
  badReply: string,
  feedback: string
): string {
  return [
    originalUserPrompt,
    "",
    "## Your previous answer was rejected",
    "",
    badReply.trim().slice(0, 500),
    "",
    feedback,
    "",
    "Answer again with a single valid JSON object and nothing else.",
  ].join("\n");
}

// ─── Resumability ───────────────────────────────────────────────────────────

/**
 * Chunk analyses banked so far, keyed by chunk index (as a string — the same
 * convention `FeedItem.translationProgress` uses, for the same JSON-column
 * reason: object keys are always strings). Persisted to
 * `FeedItem.classificationChunkProgress` so an interrupted run does not
 * re-analyze a chunk that already succeeded.
 */
export type ClassificationChunkProgress = Record<string, ChunkAnalysis>;

/**
 * Thrown when the item's time budget runs out before every chunk has been
 * analyzed. NOT a failure — mirrors `TranslationPartialProgressError`
 * exactly: the chunks that succeeded are real, banked progress, and the
 * caller decides whether to bank-and-resume (attempts remain) or fail
 * (attempt budget exhausted) — see `classify-feed-item.service.ts`.
 */
export class ClassificationChunkPartialProgressError extends Error {
  constructor(
    message: string,
    readonly analyzedChunks: ClassificationChunkProgress,
    readonly processedChunkCount: number,
    readonly totalChunkCount: number
  ) {
    super(message);
    this.name = "ClassificationChunkPartialProgressError";
  }
}

// ─── Aggregation ────────────────────────────────────────────────────────────

/** Count caps on the final synthesis — see `AggregatedArticleContext`'s own comment. */
const MAX_CENTRAL_POINTS = 10;
const MAX_SUPPORTING_POINTS = 6;
const MAX_AGGREGATE_TOPICS = 15;
const MAX_AGGREGATE_ENTITIES = 15;
const MAX_AGGREGATE_FACTS = 12;

/**
 * Every chunk analysis, synthesized into ONE bounded context the final
 * classifier reads instead of raw article text.
 *
 * `centralPoints` and `supportingPoints` are kept SEPARATE, deliberately —
 * flattening them into one list is exactly how a frequent supporting mention
 * (the Albania-protesters case: travel and scenery described at length as
 * context) can outweigh a central point that appears only once. The final
 * prompt renders them under distinct headings and says so explicitly.
 *
 * Bounded by COUNT, not by re-slicing text: however many chunks a very long
 * article produces, at most `MAX_CENTRAL_POINTS` + `MAX_SUPPORTING_POINTS`
 * points, `MAX_AGGREGATE_TOPICS` topics, `MAX_AGGREGATE_ENTITIES` entities and
 * `MAX_AGGREGATE_FACTS` facts survive into the synthesis — each already
 * capped per-field by `parseChunkAnalysisResponse` — so the rendered prompt
 * cannot grow with the article's length once it is chunked at all. `truncated`
 * is set honestly whenever a cap actually dropped something, so the trace
 * (and a human reading it) can tell a genuinely short synthesis from one that
 * hit a ceiling.
 */
export interface AggregatedArticleContext {
  /** How many chunks this synthesis was built from. */
  chunkCount: number;
  centralPoints: string[];
  supportingPoints: string[];
  topics: string[];
  entities: string[];
  importantFacts: string[];
  truncated: boolean;
}

function dedupeCapped(
  lists: readonly string[][],
  cap: number
): { out: string[]; truncated: boolean } {
  const seen = new Set<string>();
  const out: string[] = [];
  let truncated = false;
  for (const list of lists) {
    for (const item of list) {
      const key = item.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (out.length >= cap) {
        truncated = true;
        continue;
      }
      out.push(item);
    }
  }
  return { out, truncated };
}

/**
 * Synthesizes every chunk's analysis into one bounded aggregate. Order is
 * preserved within each tier — the order the chunks appear in the article —
 * so the synthesis still reads as a narrative rather than a shuffled bag of
 * points.
 */
export function aggregateChunkAnalyses(
  analyses: readonly ChunkAnalysis[]
): AggregatedArticleContext {
  const central = analyses.filter((a) => a.centrality === "central");
  const supporting = analyses.filter((a) => a.centrality === "supporting");

  let truncated = false;

  const centralPoints = central.map((a) => a.mainPoint);
  if (centralPoints.length > MAX_CENTRAL_POINTS) truncated = true;

  const supportingPoints = supporting.map((a) => a.mainPoint);
  if (supportingPoints.length > MAX_SUPPORTING_POINTS) truncated = true;

  const topicsResult = dedupeCapped(
    [...central.map((a) => a.topics), ...supporting.map((a) => a.topics)],
    MAX_AGGREGATE_TOPICS
  );
  const entitiesResult = dedupeCapped(
    [...central.map((a) => a.entities), ...supporting.map((a) => a.entities)],
    MAX_AGGREGATE_ENTITIES
  );
  // Central chunks' facts are listed first — dedupeCapped fills from the
  // front, so a central fact never loses its place to a supporting one.
  const factsResult = dedupeCapped(
    [...central.map((a) => a.importantFacts), ...supporting.map((a) => a.importantFacts)],
    MAX_AGGREGATE_FACTS
  );

  return {
    chunkCount: analyses.length,
    centralPoints: centralPoints.slice(0, MAX_CENTRAL_POINTS),
    supportingPoints: supportingPoints.slice(0, MAX_SUPPORTING_POINTS),
    topics: topicsResult.out,
    entities: entitiesResult.out,
    importantFacts: factsResult.out,
    truncated:
      truncated || topicsResult.truncated || entitiesResult.truncated || factsResult.truncated,
  };
}
