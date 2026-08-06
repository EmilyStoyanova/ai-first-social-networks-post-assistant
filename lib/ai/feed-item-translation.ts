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

export type TranslationStatus = "pending" | "translating" | "completed" | "failed" | "skipped";

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

// ─── Ingestion-time translation-work classification ─────────────────────────────

/** The prior translation state of an EXISTING feed item, as ingestion sees it. */
export interface ExistingItemTranslationState {
  translationHash: string | null;
  translationStatus: string | null;
  translationAttemptCount: number;
}

/**
 * Whether a feed item, AFTER an ingestion upsert, still represents REAL translation
 * work that the translation cron/worker would act on — the precise signal ingestion
 * uses to decide whether to kick off translation.
 *
 * This is deliberately narrower than "was created/updated": an RSS feed re-lists the
 * same items every poll, so most upserts are no-op re-writes that change nothing. Work
 * exists only when:
 *   • a NEW eligible item was created (enters the queue as pending), OR
 *   • an existing item's input hash CHANGED, so it was reopened to pending, OR
 *   • an existing item's input is unchanged but it is still pending/failed with attempts
 *     left — i.e. it already owed a translation that hasn't happened yet.
 *
 * It returns false for the cases that need nothing: non-translatable/disabled sources
 * (`cfg` null or disabled), unchanged completed items, skipped items, and failed items
 * that have exhausted their attempt budget (terminal — never retried).
 */
export function requiresTranslationWork(
  cfg: TranslationConfig | null,
  newHash: string,
  wasCreated: boolean,
  existing: ExistingItemTranslationState | undefined
): boolean {
  // Only a translatable source with translation enabled can ever produce work.
  if (!cfg || !cfg.enabled) return false;
  // A newly created eligible item enters the queue as pending (fresh attempt budget).
  if (wasCreated) return true;
  // An existing item whose input changed (or that has no prior hash) is reopened to
  // pending with a fresh budget.
  if (!existing || existing.translationHash !== newHash) return true;
  // Input unchanged: the item is left exactly as-is, so work remains only if it was
  // already owed — pending or failed, and still under the attempt cap. Completed,
  // skipped, null, and attempt-exhausted failures need nothing.
  if (existing.translationStatus === "pending" || existing.translationStatus === "failed") {
    return existing.translationAttemptCount < MAX_TRANSLATION_ATTEMPTS;
  }
  return false;
}

// ─── Prompt + response ────────────────────────────────────────────────────────

/**
 * Max article-body characters sent to the translator. Translation cost (generation
 * time AND output length) scales with the body, and the self-hosted worker (qwen3:8b)
 * is slow: probing the live worker, ~2.5–3.5k chars translated in ~47s, while ≥5k chars
 * ran past the 300s request deadline. Two distinct production failures both trace to an
 * unbounded body:
 *   • the request never returns within 300s → timeout, and
 *   • the model stops at its output limit mid-JSON → the worker still returns HTTP 200,
 *     but the truncated body is invalid JSON that the strict parser (correctly) rejects,
 *     so the item is counted `failed` despite a 200.
 * Capping the body keeps generation well under the deadline and lets the model finish a
 * complete JSON object. The full title is always kept, and a leading slice of the body
 * preserves the lede/key context (the model's output was already effectively capped near
 * ~4.8k chars, so little is lost). Conservative on purpose — raise only with worker headroom.
 */
export const MAX_TRANSLATION_CONTENT_CHARS = 3000;

/**
 * Upper bound on tokens generated for one translation — Ollama's `num_predict` (mapped from
 * `maxTokens`). Ollama's DEFAULT is unlimited (`num_predict = -1`): a reasoning model that
 * fails to emit a stop token keeps generating until the context fills, which is the observed
 * intermittent 300s timeout on specific articles. The input body is already capped at
 * MAX_TRANSLATION_CONTENT_CHARS (~3000 chars); a complete JSON translation of that fits well
 * under this bound (Cyrillic runs ~1.5–2.5 chars/token, so ≤ ~2.5k tokens), leaving generous
 * headroom for a legitimate reply while capping worst-case generation time. Anything that
 * would exceed this is runaway generation, and cutting it is exactly the goal.
 */
export const MAX_TRANSLATION_OUTPUT_TOKENS = 4096;

/**
 * Wall-clock cap for ONE model call, and for one feed item across all of its in-request
 * retries.
 *
 * These exist because the transport cap alone is not a per-item bound: TEXT_WORKER_TIMEOUT_MS
 * is 300s, so a single slow article could consume an entire cron run on its own and starve
 * every other queued item. The per-attempt cap is set well under that — a healthy capped-body
 * translation lands in ~45–60s, so 90s is generous for a real reply while cutting a hung one
 * loose early. The item cap then bounds the retry loop as a whole, so the worst case for one
 * article is ~3½ minutes rather than three back-to-back 300s hangs.
 *
 * Timeouts are NOT retried in-request: the deadline was already spent, and re-issuing the same
 * slow request would blow the item budget. The item is recorded failed and picked up on the
 * next run with its normal backoff.
 */
export const TRANSLATION_ATTEMPT_TIMEOUT_MS = 90_000;
export const TRANSLATION_ITEM_TIMEOUT_MS = 210_000;

/**
 * Rough token estimate for DIAGNOSTICS ONLY (~4 chars/token). Cyrillic tokenises higher than
 * Latin, so treat this as a lower bound. It exists to correlate slow or timed-out
 * translations with input/output size when the worker does not forward Ollama's exact token
 * counts; when it does, prefer the real `eval_count` / `prompt_eval_count`.
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── In-request regeneration budget ───────────────────────────────────────────

/**
 * Regenerations allowed WITHIN a single attempt, on top of the first call — so at most
 * 1 + MAX_TRANSLATION_RETRIES model calls before the attempt is recorded as failed.
 *
 * This is a different mechanism from {@link MAX_TRANSLATION_ATTEMPTS}, and the two compose:
 * these retries are immediate (same request, seconds apart) and exist because the local model
 * intermittently emits a bad reply that a straight regeneration fixes; MAX_TRANSLATION_ATTEMPTS
 * is the cross-run budget with hours of backoff, for outages and genuinely un-translatable items.
 * Kept at 2 deliberately: a third regeneration mostly buys latency, and the batch has a deadline.
 */
export const MAX_TRANSLATION_RETRIES = 2;

/**
 * Sampling settings for try `n` (0-based) within one attempt.
 *
 * The first try is deterministic (temperature 0) because that produces the most faithful
 * translation. That determinism is exactly why a retry MUST change the sampling: re-issuing an
 * identical prompt at temperature 0 to the same model reproduces the same bad reply, so a
 * "retry" that varies nothing is guaranteed to fail the same way and only wastes the deadline.
 *
 * `repeatPenalty` climbs alongside it because the failure being retried is often a degeneration
 * loop ("със със със …"), which is precisely what Ollama's `repeat_penalty` suppresses. Values
 * stay modest: too high a penalty starts blocking legitimately repeated words and degrades the
 * translation.
 */
export function samplingForTry(tryIndex: number): { temperature: number; repeatPenalty: number } {
  const TEMPERATURES = [0, 0.3, 0.6];
  const PENALTIES = [1.1, 1.2, 1.3];
  const i = Math.min(Math.max(tryIndex, 0), TEMPERATURES.length - 1);
  return { temperature: TEMPERATURES[i], repeatPenalty: PENALTIES[i] };
}

// ─── Degenerate-output (repetition) detection ─────────────────────────────────

/** Which degeneration pattern was found — reported in logs so loops are diagnosable. */
export type RepetitionKind = "repeated_word" | "repeated_phrase" | "repeated_char";

export interface RepetitionFinding {
  kind: RepetitionKind;
  /** The looping unit, truncated for logging — never the whole body. */
  sample: string;
  /** How many consecutive times it repeated. */
  count: number;
}

/** A word repeated this many times BACK-TO-BACK is a decoding loop, not prose. */
const REPEATED_WORD_LIMIT = 5;
/** A 2–6 word phrase cycling this many times back-to-back is a loop. */
const REPEATED_PHRASE_LIMIT = 4;
const MAX_PHRASE_CYCLE = 6;
/** One character repeated this many times is never real text (not even "…" or "———"). */
const REPEATED_CHAR_LIMIT = 30;
/** A non-space character followed by ≥ REPEATED_CHAR_LIMIT-1 copies of itself. */
const REPEATED_CHAR_RE = new RegExp(`(\\S)\\1{${REPEATED_CHAR_LIMIT - 1},}`, "u");

/** Strips punctuation so "със," and "със" count as the same looping token. */
function normaliseToken(token: string): string {
  return token.replace(/[.,!?;:()[\]{}"'«»„“”—–-]/gu, "").toLowerCase();
}

/**
 * Detects the runaway-decoding output the self-hosted model (qwen3:8b) intermittently
 * produces: it stops translating and emits the same token or phrase until it hits the
 * generation ceiling — the observed "със със със със …" body. Such a reply is valid JSON
 * of the right shape, so neither the schema nor the language guard rejects it; without this
 * check a garbage translation would be stored as `completed` and later written into a post.
 *
 * Three patterns, all requiring CONSECUTIVE repeats so ordinary prose is never flagged:
 *   • repeated_word   — one word ≥5× back-to-back;
 *   • repeated_phrase — a 2–6 word cycle ≥4× back-to-back;
 *   • repeated_char   — one character ≥30× in a row.
 *
 * Thresholds are deliberately far above natural language (real Bulgarian does not repeat a
 * word five times running), so this fails closed on loops without rejecting valid translations.
 * Returns null for healthy text.
 */
export function detectRepetition(text: string): RepetitionFinding | null {
  const charRun = text.match(REPEATED_CHAR_RE);
  if (charRun) {
    return { kind: "repeated_char", sample: charRun[1], count: charRun[0].length };
  }

  const tokens = text
    .split(/\s+/u)
    .map(normaliseToken)
    .filter((t) => t !== "");
  if (tokens.length < REPEATED_WORD_LIMIT) return null;

  // Single word repeated back-to-back.
  let run = 1;
  for (let i = 1; i < tokens.length; i += 1) {
    if (tokens[i] !== tokens[i - 1]) {
      run = 1;
      continue;
    }
    run += 1;
    if (run >= REPEATED_WORD_LIMIT) {
      // Walk to the end of the run so the reported count is the real severity of the loop
      // ("×5" and "×300" are very different signals in the logs), not just the threshold.
      let j = i + 1;
      while (j < tokens.length && tokens[j] === tokens[i]) {
        run += 1;
        j += 1;
      }
      return { kind: "repeated_word", sample: tokens[i], count: run };
    }
  }

  // Multi-word phrase cycling back-to-back (e.g. "на държавата на държавата …").
  for (let cycle = 2; cycle <= MAX_PHRASE_CYCLE; cycle += 1) {
    for (let start = 0; start + cycle * REPEATED_PHRASE_LIMIT <= tokens.length; start += 1) {
      let repeats = 1;
      while (
        start + cycle * (repeats + 1) <= tokens.length &&
        tokens
          .slice(start + cycle * repeats, start + cycle * (repeats + 1))
          .every((t, k) => t === tokens[start + k])
      ) {
        repeats += 1;
      }
      if (repeats >= REPEATED_PHRASE_LIMIT) {
        return {
          kind: "repeated_phrase",
          sample: tokens.slice(start, start + cycle).join(" "),
          count: repeats,
        };
      }
    }
  }

  return null;
}

/**
 * Caps the article body for translation, preserving a coherent leading slice. Bodies at
 * or under the cap are returned unchanged; longer bodies are cut at the cap (backed up to
 * the last whitespace to avoid splitting a word) with a neutral "[…]" marker so the
 * translation reads as an intentional excerpt. Title is never capped by this function.
 */
export function capTranslationContent(
  content: string | null,
  max: number = MAX_TRANSLATION_CONTENT_CHARS
): string | null {
  if (content === null || content.length <= max) return content;
  const slice = content.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  const body = lastSpace > max * 0.8 ? slice.slice(0, lastSpace) : slice;
  return `${body.trimEnd()} […]`;
}

/**
 * JSON schema handed to Ollama's `format` field so the model is CONSTRAINED to emit a
 * strict {title, content} object — structured output, not just a prompt request. This is
 * the primary defence against qwen3:8b returning prose or unclosed JSON; the prompt text
 * and the defensive parser are reinforcement/fallback, not the main mechanism.
 */
export const TRANSLATION_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    content: { type: "string" },
  },
  required: ["title", "content"],
  additionalProperties: false,
} as const;

/** True when the target is Bulgarian in any of the forms the config/company can supply. */
export function isBulgarianTarget(targetLang: string): boolean {
  const t = targetLang.trim().toLowerCase();
  return t === "bg" || t.startsWith("bg-") || t === "bulgarian" || t === "български";
}

/** Human-readable language name for the prompt; falls back to the raw code. */
function languageName(code: string): string {
  const t = code.trim().toLowerCase();
  if (isBulgarianTarget(code)) return "Bulgarian";
  if (t === "en" || t.startsWith("en-") || t === "english") return "English";
  return code;
}

/**
 * Letters that exist in Serbian / Macedonian / Russian Cyrillic but NOT in the Bulgarian
 * alphabet. Their presence in a reply meant to be Bulgarian means the model drifted into a
 * neighbouring language. Bulgarian's own ъ, ь, ю, я are deliberately excluded — they are
 * native and must never trigger a false rejection.
 */
const NON_BULGARIAN_CYRILLIC = /[ђјљњћџѓѕќыэёЂЈЉЊЋЏЃЅЌЫЭЁ]/u;

/** The first non-Bulgarian Cyrillic letter in `text`, or null when the text is clean. */
function firstNonBulgarianCyrillic(text: string): string | null {
  const m = text.match(NON_BULGARIAN_CYRILLIC);
  return m ? m[0] : null;
}

export function buildTranslationPrompts(
  title: string | null,
  content: string | null,
  targetLang: string
): { systemPrompt: string; userPrompt: string } {
  const lines = [
    `You are a professional translator. Translate the article title and body into ${languageName(targetLang)}.`,
    "Preserve meaning exactly. Keep proper names, URLs, brand names, and facts unchanged.",
  ];
  if (isBulgarianTarget(targetLang)) {
    lines.push(
      "Translate ONLY into natural, fluent Bulgarian, written in Bulgarian Cyrillic.",
      "Do NOT use Serbian, Macedonian, Russian, or any mixed-language words, letters, or spelling."
    );
  }
  lines.push(
    'Respond with ONLY a single, complete JSON object of exactly this shape: {"title": "...", "content": "..."}',
    "Output nothing before or after the JSON — no reasoning, no commentary, no summaries, no code fences.",
    "Make sure the JSON is complete and ends with its closing brace.",
    'If the article has no title, use an empty string "" for "title".'
  );
  const systemPrompt = lines.join("\n");

  const cappedContent = capTranslationContent(content);
  const userPrompt = [`Title: ${title ?? ""}`, `Content: ${cappedContent ?? ""}`].join("\n");

  return { systemPrompt, userPrompt };
}

/**
 * Why a model reply could not be accepted — surfaced in diagnostics so the failure
 * modes are distinguishable at a glance:
 *   • invalid_json      — not parseable as JSON even after the fallback repair;
 *   • schema_validation — valid JSON but the wrong shape (missing/!string title|content);
 *   • wrong_language    — right shape, but the text is not Bulgarian (drifted language);
 *   • repetition        — right shape and language, but the body is a decoding loop.
 */
export type TranslationParseFailure =
  "invalid_json" | "schema_validation" | "wrong_language" | "repetition";

export class TranslationParseError extends Error {
  readonly code = "TRANSLATION_PARSE_ERROR" as const;
  readonly reason: TranslationParseFailure;
  /** Present only for `repetition`: the looping unit and its repeat count, for logging. */
  readonly repetition?: RepetitionFinding;
  constructor(
    message: string,
    reason: TranslationParseFailure = "invalid_json",
    repetition?: RepetitionFinding
  ) {
    super(message);
    this.name = "TranslationParseError";
    this.reason = reason;
    this.repetition = repetition;
  }
}

/**
 * Whether regenerating is worth a retry slot. Every parse failure here is a MODEL-output
 * defect — a different sample of the same prompt can come out clean — so all of them are
 * retriable, which is the point of {@link samplingForTry} varying the sampling per try.
 * Kept as an explicit predicate (rather than "always true") so a future non-retriable
 * reason has one obvious place to be excluded.
 */
export function isRetriableParseFailure(reason: TranslationParseFailure): boolean {
  return (
    reason === "invalid_json" ||
    reason === "schema_validation" ||
    reason === "wrong_language" ||
    reason === "repetition"
  );
}

/**
 * Repairs the ONE truncation the self-hosted model actually produces: a complete
 * object whose trailing "}" it forgot to emit before stopping (observed live —
 * qwen3:8b returns HTTP 200 with `{"title":"…","content":"…"` and no closing brace).
 * Both string values are fully terminated; only structural close braces are missing.
 *
 * The scan tracks JSON string state so braces inside translated text are ignored, and
 * it repairs ONLY when generation stopped cleanly OUTSIDE any string with unclosed
 * objects. A cut mid-string (an unterminated value) is left exactly as-is so JSON.parse
 * still rejects it — this salvages a whole object, never a partial string value.
 */
function completeTruncatedJson(candidate: string): string {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const ch of candidate) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
  }
  // Only a clean truncation (not inside a string, with objects still open) is repairable.
  if (!inString && depth > 0) return candidate + "}".repeat(depth);
  return candidate;
}

/**
 * Isolates the JSON object from a model reply. Tolerates ``` fences and leading/trailing
 * prose (the model is told not to add them, but occasionally does), and repairs a reply
 * truncated just before its closing brace. It never loosens validation: the result is
 * still handed to JSON.parse and the strict field checks below, so anything that is not a
 * well-formed object — genuinely brace-less prose, or a value cut off mid-string — is rejected.
 */
function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  const start = body.indexOf("{");
  if (start === -1) {
    throw new TranslationParseError("Translation response contained no JSON object.");
  }
  // A closing brace after the opening one → complete object; slice it out, dropping any
  // trailing prose. No closing brace → a truncated reply; take everything from the opening
  // brace and let completeTruncatedJson add the missing close (or leave a bad cut to fail).
  const end = body.lastIndexOf("}");
  const candidate = end > start ? body.slice(start, end + 1) : body.slice(start);
  return completeTruncatedJson(candidate);
}

/**
 * Parses and validates the model's reply against {@link TRANSLATION_JSON_SCHEMA}.
 *
 * Primary path: with Ollama structured output the reply is already a clean JSON object, so
 * we `JSON.parse` it directly. Fallback path: only if that throws do we run the defensive
 * repair ({@link extractJson}: fences, surrounding prose, a missing closing brace) — the
 * repair is a salvage net, never the first mechanism. `usedRepair` reports which path won,
 * so operators can tell whether structured output is actually being honoured.
 *
 * After parsing, the object is schema-validated (title + content present and correctly
 * typed), language-checked for Bulgarian targets, and finally screened for decoding loops
 * ({@link detectRepetition}) — a loop is valid JSON in the right language, so it has to be
 * caught here or it ships. Every rejection throws a {@link TranslationParseError} carrying a
 * `reason`; the caller regenerates while retries remain, then records a failure with backoff.
 */
export function parseTranslationResponse(
  raw: string,
  targetLang?: string
): {
  translatedTitle: string | null;
  translatedContent: string;
  /** True when the primary JSON.parse failed and the defensive repair salvaged the reply. */
  usedRepair: boolean;
} {
  let parsed: unknown;
  let usedRepair = false;
  try {
    // Primary: structured output should be a clean, complete JSON object.
    parsed = JSON.parse(raw.trim());
  } catch {
    // Fallback: strip fences/prose and repair a missing closing brace, then re-parse.
    usedRepair = true;
    try {
      parsed = JSON.parse(extractJson(raw));
    } catch (err) {
      if (err instanceof TranslationParseError) throw err;
      throw new TranslationParseError("Translation response was not valid JSON.", "invalid_json");
    }
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TranslationParseError(
      "Translation response was not a JSON object.",
      "schema_validation"
    );
  }

  const record = parsed as Record<string, unknown>;

  if (
    !("content" in record) ||
    typeof record.content !== "string" ||
    record.content.trim() === ""
  ) {
    throw new TranslationParseError(
      'Translation response is missing a non-empty "content".',
      "schema_validation"
    );
  }
  if (!("title" in record)) {
    throw new TranslationParseError(
      'Translation response is missing "title".',
      "schema_validation"
    );
  }
  const title = record.title;
  if (title !== null && typeof title !== "string") {
    throw new TranslationParseError(
      'Translation response has a non-string "title".',
      "schema_validation"
    );
  }
  const content = record.content;

  // Wrong-language guard (Bulgarian targets only): reject text that carries letters exclusive
  // to Serbian/Macedonian/Russian, so a mislanguaged translation fails rather than shipping.
  if (targetLang && isBulgarianTarget(targetLang)) {
    const offending =
      firstNonBulgarianCyrillic(content) ??
      firstNonBulgarianCyrillic(typeof title === "string" ? title : "");
    if (offending) {
      throw new TranslationParseError(
        `Translation is not Bulgarian — contains "${offending}" (Serbian/Macedonian/Russian).`,
        "wrong_language"
      );
    }
  }

  // Degeneration guard: a decoding loop is well-formed JSON in the right language, so it
  // passes every check above and would otherwise be stored as a completed translation.
  const loop = detectRepetition(content);
  if (loop) {
    throw new TranslationParseError(
      `Translation degenerated into a ${loop.kind} loop ("${loop.sample}" ×${loop.count}).`,
      "repetition",
      loop
    );
  }

  const normalisedTitle = typeof title === "string" && title.trim() !== "" ? title : null;
  return { translatedTitle: normalisedTitle, translatedContent: content, usedRepair };
}
