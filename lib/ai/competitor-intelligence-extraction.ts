/**
 * Competitive Intelligence — INTRINSIC extraction (Part 3B, §7/§8/§9/§10 of the
 * governing instruction).
 *
 * Turns one piece of competitor content (a competitor RSS `FeedItem` or a
 * `CompetitorManualEntry`) into structured facts about the content ITSELF —
 * never facts about how well it fits THIS company. That second question is
 * `competitor-relevance.ts`'s alone; see the ownership split below and on
 * `CompetitorIntelligence` in schema.prisma.
 *
 * Deliberately NOT a chunked multi-call pipeline like `article-understanding.ts`.
 * Competitor content (an RSS article, a pasted social/ad post) is judged in one
 * bounded excerpt (`MAX_EXTRACTION_CONTENT_CHARS`) with one repair call, mirroring
 * the SHAPE of `feed-item-classification.ts` (structured JSON reply, strict
 * vetting, a repair prompt naming the exact problem) without its chunk-and-
 * synthesize machinery — that machinery exists because a full news article can
 * run to tens of thousands of characters; competitor social/ad/blog content is
 * comfortably smaller, and a lower, honest cap is the appropriately-scoped
 * trade rather than reproducing that complexity for content that does not need
 * it.
 */

import { createHash } from "node:crypto";

// ─── Vocabulary — mirrors the CompetitorXxx enums in schema.prisma exactly ────

export const COMPETITOR_CONTENT_TYPES = [
  "blog_post",
  "product_update",
  "promotion",
  "announcement",
  "guide",
  "video",
  "social_post",
  "ad",
  "other",
] as const;
export type CompetitorContentTypeValue = (typeof COMPETITOR_CONTENT_TYPES)[number];

export const COMPETITOR_COMMERCIAL_INTENTS = [
  "informational",
  "soft_sell",
  "hard_sell",
  "promotional",
] as const;
export type CompetitorCommercialIntentValue = (typeof COMPETITOR_COMMERCIAL_INTENTS)[number];

export const COMPETITOR_CTA_TYPES = [
  "learn_more",
  "sign_up",
  "buy_now",
  "contact_us",
  "download",
  "comment_engage",
  "none",
  "other",
] as const;
export type CompetitorCtaTypeValue = (typeof COMPETITOR_CTA_TYPES)[number];

export const COMPETITOR_ANGLE_CATEGORIES = [
  "problem_solution",
  "comparison",
  "how_to",
  "case_study",
  "announcement",
  "thought_leadership",
  "behind_the_scenes",
  "promotion",
  "other",
] as const;
export type CompetitorAngleCategoryValue = (typeof COMPETITOR_ANGLE_CATEGORIES)[number];

export const COMPETITOR_HOOK_TYPES = [
  "question",
  "problem",
  "bold_claim",
  "statistic",
  "curiosity",
  "story",
  "direct_offer",
  "announcement",
  "none",
  "other",
] as const;
export type CompetitorHookTypeValue = (typeof COMPETITOR_HOOK_TYPES)[number];

export const COMPETITOR_STRUCTURE_PATTERNS = [
  "problem_solution",
  "how_to",
  "list",
  "story",
  "comparison",
  "question_answer",
  "announcement",
  "offer",
  "other",
] as const;
export type CompetitorStructurePatternValue = (typeof COMPETITOR_STRUCTURE_PATTERNS)[number];

// ─── Limits ────────────────────────────────────────────────────────────────

/** Attempts before an item is left alone — same as classification/extraction. */
export const MAX_EXTRACTION_ATTEMPTS = 3;

/** Extra model calls one attempt may spend repairing its own reply. */
export const MAX_EXTRACTION_REPAIR_ATTEMPTS = 1;

/**
 * The bounded excerpt this module judges from — see the module comment for why
 * this is a fixed cap rather than a chunk-and-synthesize pipeline. Generous
 * enough for a long blog-style competitor article; content beyond this is
 * truncated at a sentence-ish boundary rather than mid-word.
 */
export const MAX_EXTRACTION_CONTENT_CHARS = 6000;

export const MAX_EXTRACTION_OUTPUT_TOKENS = 900;
export const EXTRACTION_ATTEMPT_TIMEOUT_MS = 60_000;
export const EXTRACTION_ITEM_TIMEOUT_MS = 90_000;
export const EXTRACTION_LEASE_MS = 10 * 60_000;
export const EXTRACTION_BATCH_SIZE = 10;

/**
 * The semantics of the extractor, as a number participating in the analysis
 * hash — identical role to `CLASSIFICATION_SEMANTIC_VERSION`: bump it when the
 * system prompt's rules, the vetting in `parseExtractionResponse`, or the reply
 * contract change in a way that could move an answer, so a reopened row is
 * genuinely re-asked rather than settling back to `completed` for free.
 */
export const EXTRACTION_SEMANTIC_VERSION = 1;

// ─── What gets extracted ──────────────────────────────────────────────────

export interface ExtractableContent {
  /** Article title (RSS) or a short label; null for a manual entry with none. */
  title: string | null;
  /** The article body (RSS) or the pasted content (manual entry). */
  body: string;
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max).trim();
}

/** The exact excerpt sent to the model — capped, never the raw unbounded text. */
export function extractionExcerpt(content: ExtractableContent): string {
  return truncate(content.body, MAX_EXTRACTION_CONTENT_CHARS);
}

/**
 * A stable fingerprint of the exact input an extraction was derived from:
 * title + the (uncapped) body + the semantic version. The FULL body, not the
 * capped excerpt — a change beyond the cap can never move the answer since the
 * model never sees it, but hashing the full text costs nothing and keeps this
 * function honest about what "the input" means, matching
 * `computeClassificationHash`'s own reasoning for hashing the uncapped body.
 */
export function computeExtractionHash(content: ExtractableContent): string {
  return createHash("sha256")
    .update(
      [(content.title ?? "").trim(), content.body.trim(), String(EXTRACTION_SEMANTIC_VERSION)].join(
        ""
      )
    )
    .digest("hex");
}

// ─── The reply contract ───────────────────────────────────────────────────

export const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    topic: { type: ["string", "null"] },
    subtopic: { type: ["string", "null"] },
    summary: { type: ["string", "null"] },
    angle: { type: ["string", "null"] },
    hookType: { type: ["string", "null"], enum: [...COMPETITOR_HOOK_TYPES, null] },
    structurePattern: { type: ["string", "null"], enum: [...COMPETITOR_STRUCTURE_PATTERNS, null] },
    targetAudience: { type: ["string", "null"] },
    problemAddressed: { type: ["string", "null"] },
    keyMessage: { type: ["string", "null"] },
    tone: { type: ["string", "null"] },
    ctaText: { type: ["string", "null"] },
    contentType: { type: ["string", "null"], enum: [...COMPETITOR_CONTENT_TYPES, null] },
    commercialIntent: { type: ["string", "null"], enum: [...COMPETITOR_COMMERCIAL_INTENTS, null] },
    ctaType: { type: ["string", "null"], enum: [...COMPETITOR_CTA_TYPES, null] },
    angleCategory: { type: ["string", "null"], enum: [...COMPETITOR_ANGLE_CATEGORIES, null] },
    productsServicesMentioned: { type: "array", items: { type: "string" } },
    originalLanguage: { type: ["string", "null"] },
  },
  required: [
    "topic",
    "subtopic",
    "summary",
    "angle",
    "hookType",
    "structurePattern",
    "targetAudience",
    "problemAddressed",
    "keyMessage",
    "tone",
    "ctaText",
    "contentType",
    "commercialIntent",
    "ctaType",
    "angleCategory",
    "productsServicesMentioned",
    "originalLanguage",
  ],
  additionalProperties: false,
} as const;

export interface ExtractionVerdict {
  topic: string | null;
  subtopic: string | null;
  summary: string | null;
  angle: string | null;
  hookType: CompetitorHookTypeValue | null;
  structurePattern: CompetitorStructurePatternValue | null;
  targetAudience: string | null;
  problemAddressed: string | null;
  keyMessage: string | null;
  tone: string | null;
  ctaText: string | null;
  contentType: CompetitorContentTypeValue | null;
  commercialIntent: CompetitorCommercialIntentValue | null;
  ctaType: CompetitorCtaTypeValue | null;
  angleCategory: CompetitorAngleCategoryValue | null;
  /** Products AND services — never fabricated; empty array when none are named. */
  productsServicesMentioned: string[];
  originalLanguage: string | null;
}

export type ExtractionOutcome =
  ({ status: "ok" } & ExtractionVerdict) | { status: "invalid"; problem: string; feedback: string };

export class ExtractionParseError extends Error {
  readonly code = "EXTRACTION_EMPTY_RESPONSE" as const;
  constructor(message: string) {
    super(message);
    this.name = "ExtractionParseError";
  }
}

/** First balanced JSON object in a reply — identical scan to
 *  `findJsonObject` in feed-item-classification.ts, duplicated locally so this
 *  module has no runtime dependency on the unrelated classification pipeline
 *  (Part 3B's isolation requirement applies to imports too, not just data). */
function findJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .map((v) => v.trim());
}

function invalid(problem: string, feedback: string): ExtractionOutcome {
  return { status: "invalid", problem, feedback };
}

function enumOrNull<T extends string>(value: unknown, allowed: readonly T[]): T | null | "INVALID" {
  if (value === null || value === undefined) return null;
  const str = asString(value);
  if (str === null) return null;
  return (allowed as readonly string[]).includes(str) ? (str as T) : "INVALID";
}

/**
 * Parses and vets a reply. Every enum field must be one of the schema's own
 * values or null — never fabricated. `additionalProperties: false` is a
 * request to a provider that honours JSON-schema constraints; providers that
 * don't are still caught here, exactly as `parseClassificationResponse` is the
 * backstop for `CLASSIFICATION_JSON_SCHEMA`.
 */
export function parseExtractionResponse(raw: string | null | undefined): ExtractionOutcome {
  const text = (raw ?? "").trim();
  if (text === "") {
    throw new ExtractionParseError("The extraction model returned an empty response.");
  }

  const json = findJsonObject(text);
  if (json === null) {
    return invalid(
      "The extraction model replied with prose instead of the required JSON object.",
      "Your reply was not JSON. Answer with a SINGLE JSON object and nothing else — no prose before or after it, no markdown fences."
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return invalid(
      "The extraction model's JSON could not be parsed.",
      "Your JSON was malformed. Answer again with a single valid JSON object, and check that every string is quoted and every list closed."
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalid(
      "The extraction model's reply was not a JSON object.",
      "Answer with a single JSON object with the keys described, not an array or a bare value."
    );
  }

  const obj = parsed as Record<string, unknown>;

  const enumFields: Array<{
    key: keyof ExtractionVerdict;
    allowed: readonly string[];
    label: string;
  }> = [
    { key: "hookType", allowed: COMPETITOR_HOOK_TYPES, label: "hookType" },
    { key: "structurePattern", allowed: COMPETITOR_STRUCTURE_PATTERNS, label: "structurePattern" },
    { key: "contentType", allowed: COMPETITOR_CONTENT_TYPES, label: "contentType" },
    { key: "commercialIntent", allowed: COMPETITOR_COMMERCIAL_INTENTS, label: "commercialIntent" },
    { key: "ctaType", allowed: COMPETITOR_CTA_TYPES, label: "ctaType" },
    { key: "angleCategory", allowed: COMPETITOR_ANGLE_CATEGORIES, label: "angleCategory" },
  ];

  const resolved: Record<string, string | null> = {};
  for (const field of enumFields) {
    const result = enumOrNull(obj[field.key], field.allowed);
    if (result === "INVALID") {
      return invalid(
        `"${field.label}" was ${JSON.stringify(obj[field.key])}, which is not one of the allowed values.`,
        `"${field.label}" must be exactly one of: ${field.allowed.join(", ")}, or null when it genuinely does not apply.`
      );
    }
    resolved[field.key] = result;
  }

  return {
    status: "ok",
    topic: asString(obj.topic),
    subtopic: asString(obj.subtopic),
    summary: asString(obj.summary),
    angle: asString(obj.angle),
    hookType: resolved.hookType as CompetitorHookTypeValue | null,
    structurePattern: resolved.structurePattern as CompetitorStructurePatternValue | null,
    targetAudience: asString(obj.targetAudience),
    problemAddressed: asString(obj.problemAddressed),
    keyMessage: asString(obj.keyMessage),
    tone: asString(obj.tone),
    ctaText: asString(obj.ctaText),
    contentType: resolved.contentType as CompetitorContentTypeValue | null,
    commercialIntent: resolved.commercialIntent as CompetitorCommercialIntentValue | null,
    ctaType: resolved.ctaType as CompetitorCtaTypeValue | null,
    angleCategory: resolved.angleCategory as CompetitorAngleCategoryValue | null,
    productsServicesMentioned: asStringArray(obj.productsServicesMentioned),
    originalLanguage: asString(obj.originalLanguage),
  };
}

// ─── Prompts ───────────────────────────────────────────────────────────────

/**
 * The system prompt. Deliberately says nothing about THIS company, its brand,
 * or its research interests — extraction is intrinsic-only (§8 of the
 * governing instruction) and must not be able to lean on relevance-shaped
 * reasoning ("this matters to the company because…"). That is
 * `competitor-relevance.ts`'s call, made later from this output.
 */
export function buildExtractionSystemPrompt(): string {
  return [
    "You analyze ONE piece of competitor content — a blog/news article, or a pasted social media or ad post — and extract structured facts about it.",
    "",
    "This is INTRINSIC analysis only. Describe what the content IS and DOES, exactly as a reader outside any particular company would. Do NOT compare it to any other company, do NOT judge whether it is relevant to anyone's business, and do NOT invent a company you are writing for. You are given no other company's information, and none of your answer should imply one exists.",
    "",
    "## Fields",
    "",
    "- topic / subtopic — what the content is about, at a general level and then more specifically. null if truly unclear.",
    "- summary — one or two neutral sentences describing the content.",
    '- angle — the specific take or framing, in your own words (e.g. "positions the product as a time-saver for busy parents"). null if there isn\'t a clear one.',
    "- hookType — the OPENING device: question | problem | bold_claim | statistic | curiosity | story | direct_offer | announcement | none | other. \"none\" means it simply states its point with no device; use it, don't guess a device that isn't there.",
    "- structurePattern — the overall SHAPE the content is organized in: problem_solution | how_to | list | story | comparison | question_answer | announcement | offer | other.",
    "- targetAudience — who this seems written for, in a short phrase. null if not evident.",
    "- problemAddressed — the problem or need the content speaks to, if any.",
    "- keyMessage — the single most important point the content is making.",
    '- tone — a short description (e.g. "casual and playful", "formal and technical").',
    "- ctaText — the exact or closely-paraphrased call to action text, if the content has one. null if there is none.",
    "- contentType — blog_post | product_update | promotion | announcement | guide | video | social_post | ad | other.",
    "- commercialIntent — informational | soft_sell | hard_sell | promotional.",
    "- ctaType — the CATEGORY of the call to action: learn_more | sign_up | buy_now | contact_us | download | comment_engage | none | other.",
    "- angleCategory — the STRATEGY category: problem_solution | comparison | how_to | case_study | announcement | thought_leadership | behind_the_scenes | promotion | other.",
    "- productsServicesMentioned — specific products or services named in the content, verbatim as named. Empty array if none are named — do not guess a generic category.",
    '- originalLanguage — the ISO 639-1 code of the language the content is written in (e.g. "en", "bg"), or null if you cannot tell.',
    "",
    "## Rules",
    "",
    "1. Every enum field (hookType, structurePattern, contentType, commercialIntent, ctaType, angleCategory) MUST be exactly one of its listed values, or null.",
    "2. Never fabricate a value you cannot support from the content. Use null (or an empty array for productsServicesMentioned) when the content genuinely does not say.",
    "3. Base every answer only on the content given below — never on outside knowledge about the source, the company that wrote it, or anyone else.",
    "",
    "Reply with a single JSON object with exactly these keys and nothing else — no prose before or after it, no markdown fences:",
    "",
    "{",
    '  "topic": string | null,',
    '  "subtopic": string | null,',
    '  "summary": string | null,',
    '  "angle": string | null,',
    '  "hookType": "question" | "problem" | "bold_claim" | "statistic" | "curiosity" | "story" | "direct_offer" | "announcement" | "none" | "other" | null,',
    '  "structurePattern": "problem_solution" | "how_to" | "list" | "story" | "comparison" | "question_answer" | "announcement" | "offer" | "other" | null,',
    '  "targetAudience": string | null,',
    '  "problemAddressed": string | null,',
    '  "keyMessage": string | null,',
    '  "tone": string | null,',
    '  "ctaText": string | null,',
    '  "contentType": "blog_post" | "product_update" | "promotion" | "announcement" | "guide" | "video" | "social_post" | "ad" | "other" | null,',
    '  "commercialIntent": "informational" | "soft_sell" | "hard_sell" | "promotional" | null,',
    '  "ctaType": "learn_more" | "sign_up" | "buy_now" | "contact_us" | "download" | "comment_engage" | "none" | "other" | null,',
    '  "angleCategory": "problem_solution" | "comparison" | "how_to" | "case_study" | "announcement" | "thought_leadership" | "behind_the_scenes" | "promotion" | "other" | null,',
    '  "productsServicesMentioned": string[],',
    '  "originalLanguage": string | null',
    "}",
  ].join("\n");
}

export function buildExtractionUserPrompt(content: ExtractableContent): string {
  const excerpt = extractionExcerpt(content);
  return [content.title ? `TITLE:\n${content.title.trim()}\n` : "", "CONTENT:", excerpt]
    .filter(Boolean)
    .join("\n");
}

export function buildExtractionRepairPrompt(
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
