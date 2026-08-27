/**
 * Whole-article understanding — one structured, model-agnostic answer to
 * "what is this article actually about", meant to be the single source of
 * truth downstream steps (keyword extraction, brand classification) read
 * instead of each re-deriving its own guess at the subject.
 *
 * Today `classify-feed-item.service.ts` asks a model for a `mainSubject`
 * bundled into the SAME call that decides a company's verdict — a topic-list
 * match and "what is this article about" are different questions, and asking
 * them together lets the second bias the first (see that module's own
 * `mainSubject` doc comment). This module answers the second question alone,
 * with its own schema, its own vetting, and its own confidence signal.
 *
 * Reuses `classification-chunk-analysis.ts` for everything about SPLITTING and
 * DISTILLING an article — `planClassificationChunks`, the per-chunk prompt and
 * parser, `aggregateChunkAnalyses` — rather than re-deriving any of it. Only
 * the GLOBAL SYNTHESIS step (turning those distilled chunks, or a short
 * article's raw text, into one `ArticleUnderstanding`) is new. Pure logic
 * only — no I/O, no Prisma, no provider; `understand-article.service.ts` is
 * what calls a model with these prompts.
 */

import { asString, findJsonObject } from "./feed-item-classification";
import {
  capList,
  toStringList,
  type ChunkAnalysis,
  type ChunkCentrality,
  type AggregatedArticleContext,
} from "./classification-chunk-analysis";

// ─── Vocabulary ─────────────────────────────────────────────────────────────

export const ARTICLE_TYPES = [
  "news",
  "guide",
  "review",
  "opinion",
  "project",
  "product",
  "interview",
  "analysis",
  "other",
] as const;
export type ArticleType = (typeof ARTICLE_TYPES)[number];

export interface ArticleUnderstandingEvidence {
  /** Index into the chunks the article was split into (0 for an unchunked, direct-read article). */
  chunkIndex: number;
  /** One short reason this chunk supports the stated mainSubject/thesis/conflict. */
  reason: string;
}

export interface ArticleUnderstanding {
  mainSubject: string;
  centralThesis: string | null;
  centralConflict: string | null;
  articleType: ArticleType;
  secondaryTopics: string[];
  incidentalTopics: string[];
  entities: string[];
  /** 0–1. See `confidenceCeiling` — never taken from the model alone on the chunked path. */
  confidence: number;
  evidence: ArticleUnderstandingEvidence[];
}

// ─── Limits ─────────────────────────────────────────────────────────────────

export const MAX_MAIN_SUBJECT_CHARS = 240;
export const MAX_THESIS_CHARS = 300;
export const MAX_CONFLICT_CHARS = 300;
export const MAX_TOPIC_ITEM_CHARS = 60;
export const MAX_SECONDARY_TOPICS = 8;
export const MAX_INCIDENTAL_TOPICS = 8;
export const MAX_UNDERSTANDING_ENTITIES = 12;
export const MAX_EVIDENCE_REASON_CHARS = 200;
export const MAX_EVIDENCE = 6;

/**
 * Bounds `num_predict` on the structured-output call (see `understand-article.service.ts`
 * and `TextWorkerProvider`). Sized from the schema's OWN worst case, not a guess: up to
 * 6 evidence entries at 200 chars each, two 8-item topic lists, 12 entities, plus
 * mainSubject/centralThesis/centralConflict — the answer alone can approach ~900-1000
 * tokens before counting a single token of reasoning. The previous cap (500) left a
 * capable local model no room to finish a maximal answer, let alone one that also emits
 * a thinking preamble before its JSON — see the transport's own comment on qwen3
 * "thinking" builds for why that preamble cannot be assumed away.
 */
export const MAX_UNDERSTANDING_OUTPUT_TOKENS = 1200;

// ─── The reply contract ─────────────────────────────────────────────────────

export const ARTICLE_UNDERSTANDING_JSON_SCHEMA = {
  type: "object",
  properties: {
    mainSubject: { type: "string" },
    centralThesis: { type: ["string", "null"] },
    centralConflict: { type: ["string", "null"] },
    articleType: { type: "string", enum: [...ARTICLE_TYPES] },
    secondaryTopics: { type: "array", items: { type: "string" } },
    incidentalTopics: { type: "array", items: { type: "string" } },
    entities: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
    evidence: {
      type: "array",
      items: {
        type: "object",
        properties: {
          chunkIndex: { type: "number" },
          reason: { type: "string" },
        },
        required: ["chunkIndex", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "mainSubject",
    "centralThesis",
    "centralConflict",
    "articleType",
    "secondaryTopics",
    "incidentalTopics",
    "entities",
    "confidence",
    "evidence",
  ],
  additionalProperties: false,
} as const;

export type ArticleUnderstandingOutcome =
  | ({ status: "ok" } & ArticleUnderstanding)
  | { status: "invalid"; problem: string; feedback: string };

export class ArticleUnderstandingParseError extends Error {
  readonly code = "ARTICLE_UNDERSTANDING_EMPTY_RESPONSE" as const;
  constructor(message: string) {
    super(message);
    this.name = "ArticleUnderstandingParseError";
  }
}

function invalid(problem: string, feedback: string): ArticleUnderstandingOutcome {
  return { status: "invalid", problem, feedback };
}

/**
 * A cheap, deterministic proxy for "this reads as one precise sentence about
 * the article" rather than a bag of keywords: too few words, or a run of
 * short comma-separated fragments with no connecting word anywhere, is what a
 * keyword list looks like when a model is asked for a sentence and reaches
 * for its topic tags instead.
 */
function looksLikeBagOfKeywords(subject: string): boolean {
  const words = subject.trim().split(/\s+/).filter(Boolean);
  if (words.length < 4) return true;

  const segments = subject
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length >= 3) {
    const hasConnector =
      /\b(is|are|was|were|about|that|which|who|whose|to|of|in|on|with|for|amid|amidst|over|against|after|before|as|because|while|during)\b/i.test(
        subject
      );
    if (!hasConnector) return true;
  }
  return false;
}

function normalizeNullableField(value: unknown, cap: number): string | null | "invalid" {
  if (value === null || value === undefined) return null;
  const s = asString(value);
  return s === null ? null : s.slice(0, cap);
}

/**
 * Parses and vets ONE global-synthesis reply — direct (short article) or
 * synthesis (reduced chunk points) mode share the exact same reply shape, so
 * one parser serves both. `totalChunkCount` bounds `evidence[].chunkIndex`: a
 * citation outside the article's real chunk range is fabricated evidence, not
 * a formatting slip, so it is refused rather than clamped — same reasoning as
 * `parseClassificationResponse` refusing an invented topic.
 */
export function parseArticleUnderstandingResponse(
  raw: string | null | undefined,
  totalChunkCount: number
): ArticleUnderstandingOutcome {
  const text = (raw ?? "").trim();
  if (text === "") {
    throw new ArticleUnderstandingParseError(
      "The article-understanding model returned an empty response."
    );
  }

  const json = findJsonObject(text);
  if (json === null) {
    return invalid(
      "The article-understanding model replied with prose instead of the required JSON object.",
      "Your reply was not JSON. Answer with a SINGLE JSON object and nothing else — no prose before or after it, no markdown fences."
    );
  }

  // A second, independent JSON object after the first is an AMBIGUOUS reply — the
  // model restated its answer, appended a worked example, or similar — and is refused
  // rather than guessed at. `findJsonObject` alone would silently take only the first
  // object, which is exactly the "guess which one was meant" this refuses to do.
  const firstObjectEnd = text.indexOf("{") + json.length;
  if (findJsonObject(text.slice(firstObjectEnd)) !== null) {
    return invalid(
      "The article-understanding model's reply contained more than one JSON object.",
      "Answer with exactly ONE JSON object and nothing else — remove any duplicate, example, or restated object."
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return invalid(
      "The article-understanding model's JSON could not be parsed.",
      "Your JSON was malformed. Answer again with a single valid JSON object, and check that every string is quoted and every list closed."
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalid(
      "The article-understanding model's reply was not a JSON object.",
      "Answer with a single JSON object with the keys described, not an array or a bare value."
    );
  }

  const obj = parsed as Record<string, unknown>;

  const mainSubject = asString(obj.mainSubject);
  if (!mainSubject) {
    return invalid(
      "The reply did not say what the article is about.",
      'The "mainSubject" field must be one precise sentence describing what the article is actually about.'
    );
  }
  if (looksLikeBagOfKeywords(mainSubject)) {
    return invalid(
      `"mainSubject" reads like a list of keywords, not a sentence: ${JSON.stringify(mainSubject)}.`,
      '"mainSubject" must be ONE precise sentence — not a category, not the most frequent noun, not a comma-separated list of topics. Write a full sentence that says what the article is actually about.'
    );
  }

  const centralThesis = normalizeNullableField(obj.centralThesis, MAX_THESIS_CHARS);
  const centralConflict = normalizeNullableField(obj.centralConflict, MAX_CONFLICT_CHARS);

  const articleTypeRaw = asString(obj.articleType)?.toLowerCase();
  if (!articleTypeRaw || !(ARTICLE_TYPES as readonly string[]).includes(articleTypeRaw)) {
    return invalid(
      `"articleType" was missing or not one of the allowed values (got ${JSON.stringify(obj.articleType)}).`,
      `"articleType" must be exactly one of: ${ARTICLE_TYPES.join(", ")}.`
    );
  }
  const articleType = articleTypeRaw as ArticleType;

  const confidenceRaw = obj.confidence;
  if (typeof confidenceRaw !== "number" || !Number.isFinite(confidenceRaw)) {
    return invalid(
      `"confidence" was missing or not a number (got ${JSON.stringify(confidenceRaw)}).`,
      '"confidence" must be a number between 0 and 1.'
    );
  }
  const confidence = Math.max(0, Math.min(1, confidenceRaw));

  const rawEvidence = Array.isArray(obj.evidence) ? obj.evidence : [];
  if (rawEvidence.length === 0) {
    return invalid(
      "The reply cited no evidence for its mainSubject.",
      '"evidence" must list at least one chunk index and reason that justify "mainSubject".'
    );
  }
  const evidence: ArticleUnderstandingEvidence[] = [];
  for (const entry of rawEvidence) {
    if (entry === null || typeof entry !== "object") {
      return invalid(
        "One of the evidence entries was not an object.",
        'Every "evidence" entry must be an object with "chunkIndex" (a number) and "reason" (a short string).'
      );
    }
    const e = entry as Record<string, unknown>;
    const chunkIndex = e.chunkIndex;
    if (typeof chunkIndex !== "number" || !Number.isInteger(chunkIndex)) {
      return invalid(
        `An evidence entry had a non-integer chunkIndex (got ${JSON.stringify(chunkIndex)}).`,
        '"chunkIndex" must be a whole number naming one of the section numbers shown to you.'
      );
    }
    if (chunkIndex < 0 || chunkIndex >= totalChunkCount) {
      return invalid(
        `An evidence entry cited chunkIndex ${chunkIndex}, which is outside the article's ${totalChunkCount} section(s).`,
        `"chunkIndex" must be one of the section numbers actually shown to you (0 to ${totalChunkCount - 1}). Do not cite a section that was not shown.`
      );
    }
    const reason = asString(e.reason);
    if (!reason) {
      return invalid(
        "An evidence entry had no reason.",
        'Every "evidence" entry needs a "reason" — one short phrase saying what that section shows.'
      );
    }
    evidence.push({ chunkIndex, reason: reason.slice(0, MAX_EVIDENCE_REASON_CHARS) });
  }

  return {
    status: "ok",
    mainSubject: mainSubject.slice(0, MAX_MAIN_SUBJECT_CHARS),
    centralThesis,
    centralConflict,
    articleType,
    secondaryTopics: capList(
      toStringList(obj.secondaryTopics),
      MAX_TOPIC_ITEM_CHARS,
      MAX_SECONDARY_TOPICS
    ),
    incidentalTopics: capList(
      toStringList(obj.incidentalTopics),
      MAX_TOPIC_ITEM_CHARS,
      MAX_INCIDENTAL_TOPICS
    ),
    entities: capList(toStringList(obj.entities), MAX_TOPIC_ITEM_CHARS, MAX_UNDERSTANDING_ENTITIES),
    confidence,
    evidence: evidence.slice(0, MAX_EVIDENCE),
  };
}

// ─── Recursive reduction (no hard "first N" cap) ───────────────────────────

/**
 * One point carried into the synthesis prompt, tracing back to every ORIGINAL
 * chunk it represents. A leaf point (fresh from `toEvidencePoints`) traces to
 * exactly one chunk; a point produced by `mergeGroup` traces to every chunk in
 * that group. This is what lets `evidence[].chunkIndex` in the final reply
 * still resolve to a real chunk even after reduction folded many chunks'
 * summaries into one line — no chunk's index is ever dropped, only its own
 * exact wording may be folded into its group's merged text once the article
 * is long enough to need more than one reduction pass.
 */
export interface EvidencePoint {
  text: string;
  chunkIndices: number[];
  centrality: ChunkCentrality;
}

/** How many points one reduction pass folds into one merged point. */
const REDUCTION_GROUP_SIZE = 6;

/**
 * Above this many points, the synthesis prompt reduces before it renders —
 * see `reduceForSynthesis`. Sized well under any reasonable prompt budget:
 * even at the per-point cap below, this many points is a small prompt.
 */
export const SAFE_SYNTHESIS_POINT_COUNT = 18;

/** Total character budget for one merged point's text. */
const MAX_REDUCED_POINT_CHARS = 480;

function toEvidencePoints(analyses: readonly ChunkAnalysis[]): EvidencePoint[] {
  return analyses.map((a, i) => ({
    text: a.mainPoint,
    chunkIndices: [i],
    centrality: a.centrality,
  }));
}

/**
 * Merges one group of points into one. `centrality` is "central" if ANY
 * member is — a group is never allowed to launder a real central signal into
 * "merely supporting" just because it shares a reduction bucket with
 * supporting neighbours. Every member's `chunkIndices` survive the merge even
 * once the budget below stops adding more of their raw text, so a chunk is
 * never unreachable from the final evidence — only its own exact wording can
 * be folded out of a very large group.
 */
function mergeGroup(group: readonly EvidencePoint[]): EvidencePoint {
  const centrality: ChunkCentrality = group.some((p) => p.centrality === "central")
    ? "central"
    : "supporting";
  const chunkIndices = group.flatMap((p) => p.chunkIndices);

  const parts: string[] = [];
  let used = 0;
  for (const p of group) {
    const piece = parts.length === 0 ? p.text : `; ${p.text}`;
    if (used + piece.length > MAX_REDUCED_POINT_CHARS) break;
    parts.push(piece);
    used += piece.length;
  }
  return { text: parts.join(""), chunkIndices, centrality };
}

/**
 * Reduces every chunk's analysis down to a synthesis-ready point list —
 * recursively, in groups, rather than a hard "keep the first N" cap. A blind
 * cap silently drops whichever chunks happen to sort last; this instead keeps
 * folding the WHOLE list, group by group, until it fits, so a chunk near the
 * end of a very long article still shapes the final synthesis instead of
 * being the one thing a length cap threw away.
 *
 * Terminates because each pass replaces `n` points with `ceil(n / GROUP_SIZE)`
 * — strictly fewer whenever GROUP_SIZE > 1 and n > 1 — and the explicit
 * no-progress guard stops a degenerate GROUP_SIZE from looping forever.
 */
export function reduceForSynthesis(
  analyses: readonly ChunkAnalysis[],
  safePointCount: number = SAFE_SYNTHESIS_POINT_COUNT
): EvidencePoint[] {
  let points = toEvidencePoints(analyses);
  while (points.length > safePointCount) {
    const next: EvidencePoint[] = [];
    for (let i = 0; i < points.length; i += REDUCTION_GROUP_SIZE) {
      next.push(mergeGroup(points.slice(i, i + REDUCTION_GROUP_SIZE)));
    }
    if (next.length >= points.length) break;
    points = next;
  }
  return points;
}

// ─── Confidence ─────────────────────────────────────────────────────────────

export interface ConfidenceSignals {
  /** Share of all chunks the per-chunk analysis marked "central". */
  centralShare: number;
  /** Average pairwise topic overlap (Jaccard) across central chunks — "do they agree". */
  topicCoherence: number;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * The cross-chunk evidence a chunked article's confidence rests on: how many
 * chunks corroborate a central subject, and whether the central chunks agree
 * on what it is. A single central chunk is one un-corroborated voice (given a
 * NEUTRAL, not full, coherence score); central chunks whose topics barely
 * overlap are chunks pointing at different subjects, which is exactly the
 * "genuinely multi-topic article" case confidence must not paper over.
 */
export function computeConfidenceSignals(analyses: readonly ChunkAnalysis[]): ConfidenceSignals {
  const total = analyses.length;
  const central = analyses.filter((a) => a.centrality === "central");
  const centralShare = total === 0 ? 0 : central.length / total;

  if (central.length === 0) return { centralShare, topicCoherence: 0 };
  if (central.length === 1) return { centralShare, topicCoherence: 0.5 };

  const sets = central.map((a) => new Set(a.topics.map((t) => t.toLowerCase())));
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      pairs++;
      sum += jaccard(sets[i], sets[j]);
    }
  }
  return { centralShare, topicCoherence: pairs === 0 ? 0 : sum / pairs };
}

/**
 * The MAXIMUM confidence the chunked path may report, independent of what the
 * synthesis model claims for itself — `understand-article.service.ts` takes
 * `Math.min(modelConfidence, confidenceCeiling(signals))`. This is what stops
 * a model from confidently naming a subject when the chunks it was built from
 * do not actually agree on one: coherence (agreement) carries the most
 * weight, corroborating chunk count (strength of evidence) the rest.
 *
 * Deliberately NOT applied on the direct (unchunked, short-article) path:
 * there, the model read the whole article itself — the strongest possible
 * evidence already — and there are no other chunks to cross-check it against.
 */
export function confidenceCeiling(signals: ConfidenceSignals): number {
  const strength = Math.min(1, signals.centralShare * 4);
  const ceiling = 0.2 + 0.6 * signals.topicCoherence + 0.2 * strength;
  return Math.max(0, Math.min(1, ceiling));
}

// ─── Prompts ────────────────────────────────────────────────────────────────

export type ArticleUnderstandingMode = "direct" | "synthesis";

/**
 * The system prompt — shared by both paths, since both ask for the exact same
 * `ArticleUnderstanding` shape. Only the closing line differs: "direct" reads
 * one unsplit article and must cite chunk 0; "synthesis" reads a reduced set
 * of per-section points and must cite the section numbers actually shown.
 */
export function buildArticleUnderstandingSystemPrompt(mode: ArticleUnderstandingMode): string {
  const parts: string[] = [
    "You determine what a news article is REALLY about — its true central subject — for a downstream system that will use your answer to extract keywords and judge the article's relevance. Getting the subject right matters more than anything else you are asked here.",
    "",
    "## What you are looking for",
    "",
    '1. "mainSubject" must answer, in ONE precise sentence: what is this article actually about? Not a category ("home improvement"), not a bag of keywords ("tourism, beaches, hotels"), not a paraphrase of the opening paragraph, and not simply the noun mentioned most often. The real subject can be stated anywhere in the article — including only near the end — and a scene-setting opening is not necessarily what the piece is about.',
    "2. Distinguish three tiers, and only three:",
    "   - CENTRAL: the article's own thesis, argument, or central conflict — what a reader would say the piece is fundamentally about.",
    "   - SUPPORTING (secondaryTopics): subjects the article substantively discusses in service of the central subject, but which are not themselves the point.",
    "   - INCIDENTAL (incidentalTopics): things mentioned in passing — scene-setting, colour, an aside — that do not carry the article's own argument, however often they are mentioned.",
    "3. A topic mentioned often is not automatically central, and a topic mentioned once is not automatically incidental. Judge by what the article IS ABOUT, never by frequency or by how much text surrounds a mention.",
    "",
    "## Worked example",
    "",
    'A long article about a coastal region frequently describes its beaches, hotels, and scenery — but its own thesis is that residents are protesting new tourism development in a protected coastal area. The correct mainSubject is the protest over coastal development, NOT tourism; "beaches", "hotels", and "scenery" belong in secondaryTopics or incidentalTopics, never in mainSubject, however many times they are mentioned.',
    "",
    "## articleType",
    "",
    `Classify the article as exactly one of: ${ARTICLE_TYPES.join(", ")}.`,
    "",
    "## confidence",
    "",
    "State your own confidence (0 to 1) that mainSubject is correct. Do NOT default to a high number — if the material points at several unrelated subjects with no single one dominant, say so with a LOW confidence rather than picking one and sounding sure.",
    "",
    "## evidence",
    "",
    mode === "direct"
      ? 'You were shown the whole article as one section, numbered 0. Every "evidence" entry must cite chunkIndex 0.'
      : 'You were shown the article as numbered sections. Every "evidence" entry must cite one of the section numbers actually shown to you, with a short reason that section supports your mainSubject.',
    "",
    "## Answer",
    "",
    "Reply with a single JSON object and nothing else:",
    "",
    "{",
    '  "mainSubject": "<one precise sentence: what the article is actually about>",',
    '  "centralThesis": "<the article\'s own thesis or argument, or null if it is a straightforward report with no argument>",',
    '  "centralConflict": "<the central conflict or tension, or null if there is none>",',
    `  "articleType": ${JSON.stringify(ARTICLE_TYPES[0])} | ...,`,
    '  "secondaryTopics": ["<a subject substantively discussed in service of the main subject>"],',
    '  "incidentalTopics": ["<a subject mentioned in passing, not central to the article>"],',
    '  "entities": ["<a person, place, organization, or named product central or important to the article>"],',
    '  "confidence": 0.0,',
    '  "evidence": [{ "chunkIndex": 0, "reason": "<what this section shows>" }]',
    "}",
    "",
    '"secondaryTopics", "incidentalTopics", and "entities" may be empty arrays. "centralThesis" and "centralConflict" may be null — never invent one to fill it.',
  ];
  return parts.join("\n");
}

export function buildArticleUnderstandingDirectPrompt(input: {
  title: string | null;
  body: string;
}): string {
  return [
    `Article title: ${input.title?.trim() || "(untitled)"}`,
    "This is the WHOLE article, shown as section 0.",
    "",
    "Section 0:",
    "",
    input.body,
  ].join("\n");
}

/**
 * Renders the reduced point list for the synthesis call. Mirrors
 * `renderAggregateArticleSection` in `feed-item-classification.ts`: CENTRAL
 * and SUPPORTING are shown under distinct headings, with an explicit warning
 * that a frequent supporting mention is not the article's subject — the same
 * warning, for the same reason, now feeding a call whose only job is naming
 * the subject rather than one that also has a topic list to match against.
 */
export function buildArticleUnderstandingSynthesisPrompt(input: {
  title: string | null;
  totalChunkCount: number;
  points: readonly EvidencePoint[];
  topics: readonly string[];
  entities: readonly string[];
  importantFacts: readonly string[];
}): string {
  const central = input.points.filter((p) => p.centrality === "central");
  const supporting = input.points.filter((p) => p.centrality === "supporting");

  const renderPoint = (p: EvidencePoint) => `- [section ${p.chunkIndices.join(",")}] ${p.text}`;

  const lines: string[] = [
    `Article title: ${input.title?.trim() || "(untitled)"}`,
    `This article was too long for one read. It was split into ${input.totalChunkCount} section(s) and analyzed section by section; below is that analysis, reduced to fit. Judge the article's REAL central subject from this whole synthesis — never from CENTRAL alone without reading CONTEXT, and never by which point is listed first or mentioned most.`,
    "",
  ];

  if (central.length > 0) {
    lines.push(
      "CENTRAL — what the article's own thesis, argument, or central conflict actually is:",
      ...central.map(renderPoint),
      ""
    );
  } else {
    lines.push(
      "CENTRAL — no single section stood out as clearly central. Judge the overall subject from every section below taken as a whole.",
      ""
    );
  }

  if (supporting.length > 0) {
    lines.push(
      "CONTEXT — background, scene-setting, or incidental mentions. These are NOT the article's subject on their own, however often they appear here:",
      ...supporting.map(renderPoint),
      ""
    );
  }

  if (input.topics.length > 0) {
    lines.push(`Topics touched on anywhere in the article: ${input.topics.join(", ")}`, "");
  }
  if (input.entities.length > 0) {
    lines.push(`Entities named in the article: ${input.entities.join(", ")}`, "");
  }
  if (input.importantFacts.length > 0) {
    lines.push("Key facts from the article:", ...input.importantFacts.map((f) => `- ${f}`), "");
  }

  lines.push(
    `Cite "evidence" using the section numbers shown in brackets above (0 to ${input.totalChunkCount - 1}).`
  );

  return lines.join("\n");
}

/** Mirrors `buildClassificationRepairPrompt` / `buildChunkAnalysisRepairPrompt`. */
export function buildArticleUnderstandingRepairPrompt(
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

/** Re-exported for callers that only need the aggregate's topics/entities/facts. */
export type { AggregatedArticleContext };
