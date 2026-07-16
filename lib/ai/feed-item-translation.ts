/**
 * Feed-item translation (v2-4) — pure logic: no DB, no network.
 *
 * The original `title`/`content` of a FeedItem are immutable source data.
 * Translation writes to a parallel set of columns and generation only prefers
 * them once translationStatus reaches "completed"; every other state falls back
 * to the original article.
 */

import { createHash } from "node:crypto";

/** Attempts beyond this are never retried; the item stays "failed". */
export const MAX_TRANSLATION_ATTEMPTS = 5;

/** Items translated per cron run — keeps one run inside the function timeout. */
export const TRANSLATION_BATCH_SIZE = 10;

export type TranslationStatus = "pending" | "completed" | "failed" | "skipped";

/** Only article sources are translated; prompt/calendar_event content is authored in-app. */
const TRANSLATABLE_SOURCE_TYPES = ["rss"] as const;

export function isTranslatableSourceType(type: string): boolean {
  return (TRANSLATABLE_SOURCE_TYPES as readonly string[]).includes(type);
}

/**
 * Backoff after a failed attempt, in milliseconds, indexed by the attempt number
 * that just failed (1-based). Attempt 5 is the cap: the schedule stops there
 * because MAX_TRANSLATION_ATTEMPTS excludes the item from further batches.
 */
const BACKOFF_MS: readonly number[] = [
  5 * 60 * 1000, // 1 → 5 min
  30 * 60 * 1000, // 2 → 30 min
  2 * 60 * 60 * 1000, // 3 → 2 h
  8 * 60 * 60 * 1000, // 4 → 8 h
  24 * 60 * 60 * 1000, // 5 → 24 h (max)
];

/** Next retry time after `attempt` failed. Capped at 24h; never returns a past time. */
export function computeTranslationBackoff(attempt: number, now: Date = new Date()): Date {
  const index = Math.min(Math.max(attempt, 1), BACKOFF_MS.length) - 1;
  return new Date(now.getTime() + BACKOFF_MS[index]);
}

/**
 * Identity of the translated input. A change to the article text OR to the
 * target language produces a different hash, which is what re-triggers work;
 * an unchanged hash on a completed item skips the LLM call entirely.
 */
export function computeTranslationHash(
  title: string | null,
  content: string | null,
  targetLang: string
): string {
  return createHash("sha256")
    .update(`${title ?? ""}${content ?? ""}${targetLang}`)
    .digest("hex");
}

// ─── Source configuration ─────────────────────────────────────────────────────

export interface TranslationConfig {
  enabled: boolean;
  /** ISO 639-1 target; defaults to the company's content language. */
  targetLanguage: string;
}

/**
 * Reads translation settings from ContentSource.config, defaulting the target to
 * the company's content language. Non-translatable source types always resolve
 * to disabled, so a stray translateEnabled on a prompt source is ignored.
 */
export function resolveTranslationConfig(
  sourceType: string,
  config: unknown,
  companyDefaultLang: string
): TranslationConfig {
  const fallback: TranslationConfig = { enabled: false, targetLanguage: companyDefaultLang };
  if (!isTranslatableSourceType(sourceType)) return fallback;
  if (config === null || typeof config !== "object") return fallback;

  const record = config as Record<string, unknown>;
  if (record.translateEnabled !== true) return fallback;

  const target = record.translateToLanguage;
  return {
    enabled: true,
    targetLanguage:
      typeof target === "string" && target.trim() !== "" ? target.trim() : companyDefaultLang,
  };
}

// ─── Generation-time resolution ───────────────────────────────────────────────

export interface TranslatableFeedItem {
  title: string | null;
  content: string | null;
  translatedTitle?: string | null;
  translatedContent?: string | null;
  translationStatus?: string | null;
}

/**
 * The text generation should write from. Translated text is used ONLY on a
 * completed translation that actually produced content; pending, failed,
 * skipped, and null all fall back to the original article.
 *
 * A completed translation with a null translatedTitle is legitimate (the article
 * had no title), so the title alone never disqualifies the translation.
 */
export function resolveFeedItemContent(item: TranslatableFeedItem): {
  title: string | null;
  content: string | null;
  usedTranslation: boolean;
} {
  if (
    item.translationStatus === "completed" &&
    item.translatedContent !== null &&
    item.translatedContent !== undefined
  ) {
    return {
      title: item.translatedTitle ?? null,
      content: item.translatedContent,
      usedTranslation: true,
    };
  }
  return { title: item.title, content: item.content, usedTranslation: false };
}

// ─── Prompt + response ────────────────────────────────────────────────────────

export function buildTranslationPrompts(
  title: string | null,
  content: string | null,
  targetLang: string
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = [
    `You are a professional translator. Translate the following article title and body into ${targetLang}.`,
    'Preserve meaning exactly. Return JSON: {"title": "...", "content": "..."}',
    "Do not add commentary, summaries, or any additional text.",
    'If the title is empty, return null for "title".',
  ].join("\n");

  const userPrompt = [`Title: ${title ?? ""}`, `Content: ${content ?? ""}`].join("\n");

  return { systemPrompt, userPrompt };
}

export class TranslationParseError extends Error {
  readonly code = "TRANSLATION_PARSE_ERROR" as const;
  constructor(message: string) {
    super(message);
    this.name = "TranslationParseError";
  }
}

/** Strips ``` fences some models wrap JSON in, then isolates the JSON object. */
function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new TranslationParseError("Translation response contained no JSON object.");
  }
  return body.slice(start, end + 1);
}

/**
 * Parses the model's JSON reply. Malformed output throws, which the caller
 * treats as a normal failure (attempt counted, backoff scheduled).
 */
export function parseTranslationResponse(raw: string): {
  translatedTitle: string | null;
  translatedContent: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (err) {
    if (err instanceof TranslationParseError) throw err;
    throw new TranslationParseError("Translation response was not valid JSON.");
  }

  if (parsed === null || typeof parsed !== "object") {
    throw new TranslationParseError("Translation response was not a JSON object.");
  }

  const record = parsed as Record<string, unknown>;
  const title = record.title;
  const content = record.content;

  if (typeof content !== "string" || content.trim() === "") {
    throw new TranslationParseError('Translation response is missing a non-empty "content".');
  }
  if (title !== null && title !== undefined && typeof title !== "string") {
    throw new TranslationParseError('Translation response has a non-string "title".');
  }

  const normalisedTitle = typeof title === "string" && title.trim() !== "" ? title : null;
  return { translatedTitle: normalisedTitle, translatedContent: content };
}
