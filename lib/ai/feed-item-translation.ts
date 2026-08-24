/**
 * Feed-item translation (v2-4) — pure logic: no DB, no network.
 *
 * The original `title`/`content` of a FeedItem are immutable source data.
 * Translation writes to a parallel set of columns and generation only prefers
 * them once translationStatus reaches "completed"; every other state falls back
 * to the original article.
 */

import { createHash } from "node:crypto";
import { protectTokens, type ProtectedValue } from "./translation/protected-tokens";

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
 *
 * The title-only case is the mirror image and is why the second branch exists: an
 * item whose article body could not be extracted is translated as a TITLE ONLY
 * (see {@link classifyTranslationInput}), so it completes with a translated title
 * and no translated body. Falling through to the original there would throw the
 * one piece of translated text away; taking the translation whole would replace
 * the original body with an empty string. So the translated title is used and the
 * body falls back to the original — which stays the factual source either way.
 */
export function resolveFeedItemContent(item: TranslatableFeedItem): {
  title: string | null;
  content: string | null;
  usedTranslation: boolean;
} {
  if (item.translationStatus === "completed") {
    const translatedContent = item.translatedContent;
    if (translatedContent !== null && translatedContent !== undefined && translatedContent !== "") {
      return {
        title: item.translatedTitle ?? null,
        content: translatedContent,
        usedTranslation: true,
      };
    }
    // Title-only translation: keep the translated title, keep the original body.
    if (item.translatedTitle !== null && item.translatedTitle !== undefined) {
      return { title: item.translatedTitle, content: item.content, usedTranslation: true };
    }
  }
  return { title: item.title, content: item.content, usedTranslation: false };
}

// ─── Source-text classification ───────────────────────────────────────────────

/**
 * What a stored feed item's text can actually support:
 *
 *   • full       — there is an article body to translate;
 *   • title_only — the body is missing or blank, but the item has a title;
 *   • empty      — neither, so there is nothing to translate at all.
 *
 * This exists because RSS ingestion legitimately produces bodyless items: article
 * extraction returns null for a paywall stub, a non-HTML page, a fetch failure, or
 * a feed entry with no summary, and the row is still stored (its title and URL are
 * real). Sending such an item to a translator asked for `{title, content}` is a
 * request the model cannot satisfy honestly — it either returns an empty `content`
 * (rejected, retried, rejected again) or invents an article. Both were observed in
 * production; classifying the input up front is what removes the question.
 */
export type TranslationInputKind = "full" | "title_only" | "empty";

function isBlank(text: string | null | undefined): boolean {
  return text === null || text === undefined || text.trim() === "";
}

export function classifyTranslationInput(
  title: string | null,
  content: string | null
): TranslationInputKind {
  if (!isBlank(content)) return "full";
  if (!isBlank(title)) return "title_only";
  return "empty";
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
 * Least time worth starting an item with.
 *
 * The per-item cap above is a bound on ONE article; it is not a bound on the RUN. The
 * translation cron's own budget is 240s, so an item begun with 5s left could still run for
 * 210s and push the run to ~450s — past the 300s route cap the budget exists to respect. The
 * batch therefore squeezes each item's budget down to whatever the run has left (see
 * translate-feed-items.service.ts) and stops entirely below this floor: less than ~20s cannot
 * finish a real translation, so starting one only guarantees a timeout, a counted attempt and
 * a backoff for an article that was never given a chance. It waits for the continuation job.
 */
export const MIN_TRANSLATION_ITEM_BUDGET_MS = 20_000;

/**
 * What ONE MADLAD HTTP batch costs, for the admission estimate below.
 *
 * 25s, measured against the production worker rather than guessed. Real articles,
 * whole-article wall clock divided by batch count:
 *
 *   Intel Xeon 658X   99 segments   4 batches   82.8s   →  20.7s / batch
 *   MSI E15 360       59 segments   2 batches   28.2s   →  14.1s / batch
 *   AVerMedia         56 segments   2 batches   28.2s   →  14.1s / batch
 *   Cerebras         140 segments   5 batches            (same 20-30s band)
 *
 * The observed band is 14-21s, so 25s sits above every measurement: this number is
 * used to decide whether to START an article, and erring high defers an article to
 * the next run (costless — it stays pending) while erring low starts one that can
 * only time out and burn an attempt. Deliberately NOT an environment knob: it
 * describes what the hardware does, and a deployment that changes hardware should
 * re-measure rather than tune a guess.
 */
export const ESTIMATED_MADLAD_BATCH_MS = 25_000;

/**
 * The run budget an article of `segmentCount` segments needs before it is worth
 * starting, given the MADLAD batch size in force.
 *
 * ── Why a flat floor was not enough ──────────────────────────────────────────
 * {@link MIN_TRANSLATION_ITEM_BUDGET_MS} is a single number for every article, but
 * MADLAD's own per-batch budget is a fair SHARE of the item budget — the item
 * deadline divided by the batch count. So the bigger the article, the less time each
 * batch gets from the same remaining budget, and a flat floor cannot see that.
 *
 * Feed item 5bdc0e48-827e-4b73-9990-e5d3b0446b87 is the exact failure: 99 segments,
 * 4 batches, admitted because the run had 33,340ms left and 33,340 > 20,000. MADLAD
 * then correctly computed floor(33,340 / 4) = 8,335ms per batch and batch 1/4 aborted
 * at ~8,335ms. The article genuinely needs ~82.8s. It was doomed at admission, and it
 * spent one of its five cross-run attempts proving it — which is precisely what the
 * floor's own comment says the floor exists to prevent.
 *
 * The estimate deliberately ignores the data-only bypass (see `isDataOnlySegment`),
 * which can only REMOVE batches: counting every segment can therefore overestimate
 * the batch count but never underestimate it, so the gate errs toward deferring.
 */
export function estimatedTranslationBudgetMs(segmentCount: number, httpBatchSize: number): number {
  const batches = Math.max(1, Math.ceil(segmentCount / Math.max(1, httpBatchSize)));
  return batches * ESTIMATED_MADLAD_BATCH_MS;
}

/**
 * How many MADLAD HTTP batches can safely be STARTED with `availableMs` left,
 * using the same conservative per-batch estimate as {@link estimatedTranslationBudgetMs}.
 *
 * Floors at 1 rather than 0: this is only ever called once the caller has already
 * decided an item is worth claiming this tick (see `translate-feed-items.service.ts`'s
 * oversized-article branch), and claiming an item to attempt zero batches would burn
 * one of its five cross-run attempts for no progress at all — exactly the outcome the
 * whole mechanism exists to prevent. Attempting one batch on a tight remainder can
 * still time out, but a timeout is a normal, bounded, explicitly-logged failure with
 * its own backoff; it is not a loop.
 */
export function maxBatchesFittingBudget(availableMs: number): number {
  return Math.max(1, Math.floor(availableMs / ESTIMATED_MADLAD_BATCH_MS));
}

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

// ─── Translation-input sanitising ─────────────────────────────────────────────

/**
 * Markers that begin a page's TRAILER — everything a publisher appends after the article
 * itself. Matching one cuts the body from that point on, which is both safer and far more
 * effective than filtering trailer lines individually: the trailer is a contiguous block,
 * and it arrives as one run-on line as often as it arrives as many.
 *
 * Taken from the real extracted text of the ArchDaily articles in the logs, whose Readability
 * output ends:
 *
 *     … most famously the city of Chandigarh.
 *     Image gallerySee allShow lessAbout this authorAuthor
 *     Cite: Moises Carrasco.  "Modernism on the Watch: …"  17 Aug 2026. ArchDaily.  Accessed .
 *     <https://www.archdaily.com/1183078/…> ISSN 0719-8884想阅读文章的中文版本吗?守望现代主义：…
 *     Did you know?You'll now receive updates based on what you follow! …
 *
 * That block is ~45 % of the extracted text, carries a raw double quote and a bare URL (both
 * of which the model then has to escape inside its JSON), and ends in the Chinese
 * language-switcher string that is the actual origin of the "Chinese instead of Bulgarian"
 * replies. None of it is the article.
 */
const TRAILER_MARKERS: readonly RegExp[] = [
  /\bImage gallery(?:See all)?/i,
  /\bAbout this (?:author|office)\b/i,
  /\bCite:\s/i,
  /\bISSN\s+\d/i,
  /\bDid you know\?/i,
  // NOT a trailer when it is the lead photo's OWN caption, immediately ahead of the real
  // body ("Save this picture!© Weiqi JinText description provided by the architects. …") —
  // ArchDaily renders that caption a second time, right before the article, distinct from
  // the earlier gallery-counter caption near the top. Cutting there discarded the entire
  // article; the lookahead tells the two apart by what follows within the same line.
  /\bSave this (?:picture|article)\b(?![^\n]{0,80}Text description provided by the architects)/i,
  // The "read this in Chinese/Portuguese/Spanish?" switcher, in the languages ArchDaily emits.
  /想阅读文章的中文版本吗/,
  /\bTradução\b|\b¿Quieres leer/i,
];

/**
 * Inline boilerplate that appears WITHIN the article text rather than after it, so it cannot
 * be handled by the trailer cut. Each is anchored tightly enough that ordinary prose cannot
 * match it — a bare "Share" or "Author" is deliberately absent, being far too common.
 */
const INLINE_NOISE: readonly RegExp[] = [
  // No trailing \b: Readability glues these labels straight onto the next word, exactly as in
  // "Subscriber AccessSardar Patel Stadium", where a word boundary never occurs.
  /Subscriber Access/gi,
  // Also boundary-free, and for the same reason: the credit line before it ends in a digit
  // ("… CC BY-SA 3.0Published on August 17, 2026"), so \b never matches ahead of the "P".
  /Published on \w+ \d{1,2}, \d{4}/g,
  // "Image © Carlo Fumarola via Wikipedia under license CC BY-SA 3.0" — a photo credit. The
  // licence code runs to the next real word rather than to the next lower-case letter: without
  // that lookahead the run of capitals swallowed the "P" of the "Published on …" that follows
  // it, leaving "ublished on August 17, 2026" behind and defeating the pattern below.
  /\bImage\s+©[^\n]{0,200}?under licen[cs]e\s+[A-Z][A-Z0-9\-.\s]*?(?=[A-Z][a-z]|\n|$)/g,
  /\b(?:Photograph|Image|Photo)\s+(?:©|courtesy of)\s+[^\n]{0,120}?(?=\.\s|\n|$)/g,
  /\bText description provided by the architects\.?/gi,
  /\b(?:See all|Show less)\b/g,
  // A media player's timestamp ("5:40"), which Readability lifts out of the video widget.
  /(?:^|\s)\d{1,2}:\d{2}(?=\s|$)/g,
  // The gallery counter Readability leaves behind after the lede image ("+ 2").
  /(?:^|\s)\+\s?\d{1,3}(?=\s|$)/g,
];

/** CJK (Han, Hiragana, Katakana, Hangul) — the scripts a language switcher drops into a page. */
const CJK_LETTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CJK_LETTER_GLOBAL = new RegExp(CJK_LETTER.source, "gu");

/**
 * A trailer cut may not take more than this share of the body. The markers are strong, but a
 * false positive near the top of an article would otherwise silently reduce it to a sentence;
 * requiring most of the text to survive means a bad match is ignored rather than destructive.
 */
const MIN_TRAILER_CUT_KEEP_RATIO = 0.35;
/** Below this the survivors are not an article, so the cut is abandoned and the body kept. */
const MIN_SANITISED_CHARS = 200;
/**
 * Above this share of CJK the page IS an East-Asian article, not an English one carrying a
 * language-switcher string. Dropping its CJK would delete the article, so sanitising leaves
 * CJK alone at that density and lets the normal pipeline handle it.
 */
const MAX_INCIDENTAL_CJK_RATIO = 0.2;

/** Strips HTML tags — a feed `<description>` is routinely an HTML excerpt (see parser.ts). */
function stripMarkup(text: string): string {
  return text.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ");
}

/** Removes the language-switcher sentences a publisher renders in another script. */
function dropCjkSegments(text: string): string {
  const cjkCount = (text.match(CJK_LETTER_GLOBAL) ?? []).length;
  if (cjkCount === 0) return text;
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  if (letters > 0 && cjkCount / letters > MAX_INCIDENTAL_CJK_RATIO) return text;

  // Split on line breaks AND sentence-ish boundaries, because the switcher is usually glued
  // to the end of a line ("… ISSN 0719-8884想阅读文章的中文版本吗?…") rather than on its own.
  return text
    .split(/(\n+)/u)
    .map((segment) =>
      CJK_LETTER.test(segment)
        ? segment
            .split(/(?<=[.!?。？！])/u)
            .filter((sentence) => !CJK_LETTER.test(sentence))
            .join("")
        : segment
    )
    .join("");
}

/** Collapses control characters and runaway whitespace into plain, JSON-safe prose. */
function normaliseWhitespace(text: string): string {
  return (
    text
      // Control characters other than newline/tab — invisible in the prompt, illegal raw in JSON.
      .replace(/[ --]/gu, " ")
      .replace(/\t/g, " ")
      .replace(/\r\n?/g, "\n")
      .replace(/[^\S\n]{2,}/gu, " ")
      .split("\n")
      .map((line) => line.trim())
      // A line of pure punctuation is a widget's leftovers, never a sentence — but a line of
      // pure digits is kept: structured pages (ArchDaily's spec table) render a fact's label
      // and its value on separate lines ("Year:" / "2025"), and dropping the bare number here
      // silently deleted the fact before it ever reached segmentation.
      .filter((line) => line === "" || /[\p{L}\p{N}]/u.test(line))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/**
 * Removes the parts of an extracted article that are the PAGE rather than the article, before
 * any of it is sent to the translator.
 *
 * Three production failures share this single cause, which is why the fix is here rather than
 * in the model contract:
 *
 *   • wrong_language — the trailer ends in a Chinese language-switcher string, so Chinese was
 *     in the INPUT; the model echoing it back was never a model defect. Credits and cite blocks
 *     are also almost entirely Latin proper nouns and URLs, which drag a faithful translation's
 *     Cyrillic share toward the {@link MIN_CYRILLIC_SHARE} floor.
 *   • truncated JSON — noise was ~45 % of the observed ArchDaily bodies, so it consumed ~45 %
 *     of both the input cap and the output budget. Removing it shortens the reply the model has
 *     to fit, which is the only lever that helps while the attempt timeout is the binding
 *     constraint.
 *   • invalid_json — the cite block carries a raw `"` and a bare `<URL>`, exactly the characters
 *     a model most often fails to escape inside a JSON string.
 *
 * Every pass is conservative and reversible in effect: the trailer cut is abandoned unless most
 * of the body survives it, CJK removal is skipped when the article genuinely is East-Asian, and
 * a sanitised body that comes out too short is discarded in favour of the original. Sanitising
 * never touches the STORED article — `content` remains immutable source data; this shapes only
 * what the prompt carries.
 */
export function sanitiseTranslationContent(content: string | null): string | null {
  if (content === null) return null;

  const original = content;
  let text = normaliseWhitespace(stripMarkup(content));

  let earliest = -1;
  for (const marker of TRAILER_MARKERS) {
    const at = text.search(marker);
    if (at !== -1 && (earliest === -1 || at < earliest)) earliest = at;
  }
  if (earliest !== -1) {
    const kept = text.slice(0, earliest);
    // Ignore a marker that would take most of the article — see MIN_TRAILER_CUT_KEEP_RATIO.
    if (
      kept.trim().length >= Math.max(MIN_SANITISED_CHARS, text.length * MIN_TRAILER_CUT_KEEP_RATIO)
    ) {
      text = kept;
    }
  }

  text = dropCjkSegments(text);
  for (const noise of INLINE_NOISE) text = text.replace(noise, " ");
  text = normaliseWhitespace(text);

  // Sanitising is an improvement, never a loss: if the passes leave too little to translate,
  // the untouched body is the better input and the model can cope with the noise.
  if (text.length < MIN_SANITISED_CHARS) return original;
  return text;
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
 * Floor for the shrinking retry below — a body cut smaller than this is no longer an
 * article worth translating, so the retry stops shrinking and simply re-rolls.
 */
export const MIN_TRANSLATION_CONTENT_CHARS = 800;

/**
 * The body budget for the NEXT try after a reply was cut off mid-JSON.
 *
 * A truncation means the model was asked for more output than it could finish inside its
 * generation ceiling. Retrying with the SAME body therefore asks for the same oversized reply
 * a second and third time, which is precisely the "retries happen correctly, but some items
 * still fail after all attempts" pattern in the logs: three calls, three truncations, one
 * failed item. Halving the body halves the reply the model has to complete, so a later try is
 * a materially easier request rather than another roll of the same dice.
 *
 * This changes only the SIZE of a retry, never how many there are: the in-request budget is
 * still 1 + {@link MAX_TRANSLATION_RETRIES} calls and the cross-run schedule
 * ({@link MAX_TRANSLATION_ATTEMPTS}, {@link computeTranslationBackoff}) is untouched.
 */
export function shrinkTranslationContentBudget(current: number): number {
  return Math.max(MIN_TRANSLATION_CONTENT_CHARS, Math.floor(current / 2));
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

/**
 * The schema for a title-only translation — no `content` key at all.
 *
 * That absence is the whole point. Handing the {title, content} schema to an item
 * with no article body CONSTRAINS the model to emit a `content` string, which it
 * can only fill by inventing one or by leaving it empty; the reply is then either
 * a fabrication or a rejection. Asking only for what exists removes both.
 */
export const TRANSLATION_TITLE_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
  },
  required: ["title"],
  additionalProperties: false,
} as const;

/** Which reply contract a translation is working to — set by the input, not the caller. */
export type TranslationReplyMode = "full" | "title_only";

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

// ─── Bulgarian-language assessment ────────────────────────────────────────────

/**
 * Letters that exist in Serbian / Macedonian / Russian Cyrillic but NOT in the Bulgarian
 * alphabet. Bulgarian's own ъ, ь, ю, я are deliberately excluded — they are native and must
 * never count against a translation.
 */
const NON_BULGARIAN_CYRILLIC = /[ђјљњћџѓѕќыэёЂЈЉЊЋЏЃЅЌЫЭЁ]/gu;
const CYRILLIC_LETTER = /\p{Script=Cyrillic}/gu;
const LATIN_LETTER = /\p{Script=Latin}/gu;
/**
 * EVERY letter, in any script — the denominator of the script share.
 *
 * Previously the denominator was Latin + Cyrillic only, which left a hole the logs walked
 * straight into: a reply written in Chinese has almost no Latin AND almost no Cyrillic, so it
 * scored `totalLetters ≈ 0`, fell under {@link MIN_LETTERS_FOR_SCRIPT_CHECK}, skipped the
 * script test entirely and was accepted as Bulgarian. Counting all letters means any script
 * the model drifts into — Han, Greek, Arabic — dilutes the Cyrillic share exactly as Latin
 * always did, so no such reply can pass. This only ever makes the check stricter.
 */
const ANY_LETTER = /\p{L}/gu;

/**
 * Share of Cyrillic letters (of all letters) below which a reply is not a Bulgarian
 * translation at all — in practice the model echoing the English source back. Deliberately
 * permissive: a real Bulgarian article runs 85–95 % Cyrillic even when it is thick with
 * Latin brand names and model numbers, so 40 % separates "translated" from "not translated"
 * without ever arguing about a tech article's vocabulary.
 */
export const MIN_CYRILLIC_SHARE = 0.4;
/** Below this many letters the script share is noise (a headline, a one-line body). */
export const MIN_LETTERS_FOR_SCRIPT_CHECK = 40;
/**
 * Letters above which a reply carrying NO Cyrillic at all is untranslated, however short.
 *
 * The share test needs {@link MIN_LETTERS_FOR_SCRIPT_CHECK} letters before it will judge
 * anything, and a title is almost never that long — so a title-only translation that came back
 * as the untouched English headline ("Modernism on the Watch") measured 21 letters, skipped the
 * test, and was stored as a completed Bulgarian translation. That is the one case where the
 * evidence is unambiguous at any length: a genuine Bulgarian title always contains Cyrillic, so
 * zero Cyrillic beside a dozen foreign letters is not a short translation, it is no translation.
 * Kept at 12 so a title that is legitimately nothing but a Latin brand name or model number is
 * still too short to condemn.
 */
export const MIN_LETTERS_FOR_ZERO_CYRILLIC = 12;
/**
 * Distinct WORDS carrying a foreign letter that mark the text as written in another language.
 *
 * The load-bearing metric, and distinct words rather than occurrences for a specific reason:
 * a Bulgarian article about Skopje writes "Скопје" five times and that is ONE borrowed word,
 * however often it appears, while a Macedonian article spreads its ј across "Компанијата",
 * "објави", "бидејќи", "апликација", "земјата" — dozens of different words, because the letter
 * belongs to the grammar rather than to a name. Counting occurrences cannot tell those apart;
 * counting distinct words separates them cleanly at any article length.
 */
export const MAX_FOREIGN_BEARING_WORDS = 4;
/**
 * Share of Cyrillic letters that may be non-Bulgarian in a text too short for the word count
 * to mean anything — a one-line reply in Serbian, where two words are already the whole text.
 * Deliberately high (5 %): at this length only unmistakable density should decide.
 */
export const MAX_FOREIGN_CYRILLIC_RATIO = 0.05;
/** A ratio computed from one or two letters is noise, so the density rule has a floor. */
export const MIN_FOREIGN_CYRILLIC_OCCURRENCES = 3;
/**
 * Distinct foreign letters that condemn a text on their own, however short it is. One stray
 * ј is a copied proper noun; ј AND љ AND њ together is the Macedonian alphabet, and no amount
 * of Bulgarian context explains all three.
 */
export const MIN_DISTINCT_FOREIGN_CYRILLIC = 3;

export interface BulgarianAssessment {
  /** "bulgarian" | "foreign_cyrillic" (drifted language) | "not_cyrillic" (untranslated). */
  verdict: "bulgarian" | "foreign_cyrillic" | "not_cyrillic";
  cyrillicLetters: number;
  latinLetters: number;
  /**
   * Letters in neither script — Han, Kana, Hangul, Greek, Arabic. Non-zero means the reply
   * drifted into a third script entirely, the all-Chinese case; reported so that shows in logs
   * rather than hiding inside the share.
   */
  otherLetters: number;
  /** Occurrences of letters absent from the Bulgarian alphabet. */
  foreignCyrillic: number;
  /** Distinct words carrying at least one of them — see MAX_FOREIGN_BEARING_WORDS. */
  foreignWords: number;
  /** The distinct offending letters, lower-cased — the sample shown in logs. */
  distinctForeign: string[];
  /** foreignCyrillic / cyrillicLetters, rounded for logging. 0 when there is no Cyrillic. */
  foreignRatio: number;
}

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

/** Distinct lower-cased words containing at least one non-Bulgarian Cyrillic letter. */
function countForeignBearingWords(text: string): number {
  const words = text.toLowerCase().split(/[^\p{L}]+/u);
  const bearing = new Set<string>();
  for (const word of words) {
    if (word !== "" && NON_BULGARIAN_CYRILLIC.test(word)) bearing.add(word);
    // A /g/ regex carries lastIndex between .test() calls; reset so each word is independent.
    NON_BULGARIAN_CYRILLIC.lastIndex = 0;
  }
  return bearing.size;
}

/**
 * Measures how Bulgarian a translation is, instead of asking whether it is perfect.
 *
 * The previous check rejected the whole reply on the FIRST non-Bulgarian Cyrillic letter,
 * which in production meant a fully Bulgarian article was thrown away — and retried three
 * times — because it carried one "ј" inside a copied Macedonian place name or one "ы" in a
 * quoted Russian title. That is a proofreading nit being treated as a language failure.
 *
 * So two independent, measured signals replace it, and both have to clear a floor before
 * they can reject anything:
 *
 *   • script    — a reply that is not predominantly Cyrillic was never translated at all
 *                 (the model echoing the English source), which the old check could not see;
 *   • alphabet  — how WIDELY foreign letters are spread through the vocabulary, which is what
 *                 separates a language (the letters are in its grammar, so they appear in
 *                 many different words) from a borrowing (one name, however often repeated).
 *
 * Three conditions condemn a text, each covering a length the others cannot: many distinct
 * foreign-bearing words (a real article in another language), three distinct foreign letters
 * (a whole neighbouring alphabet, however short the sample), and sheer density (a one-line
 * reply, where there is no vocabulary to count). One stray letter satisfies none of them.
 *
 * Text is assessed as a whole (title and body together): a title is far too short to judge
 * on its own, and judging it separately is how a two-word headline gets condemned.
 */
export function assessBulgarian(text: string): BulgarianAssessment {
  const cyrillicLetters = countMatches(text, CYRILLIC_LETTER);
  const latinLetters = countMatches(text, LATIN_LETTER);
  const foreignMatches = text.match(NON_BULGARIAN_CYRILLIC) ?? [];
  const foreignCyrillic = foreignMatches.length;
  const distinctForeign = [...new Set(foreignMatches.map((c) => c.toLowerCase()))].sort();
  const foreignWords = countForeignBearingWords(text);
  const foreignRatio =
    cyrillicLetters === 0 ? 0 : Math.round((foreignCyrillic / cyrillicLetters) * 10_000) / 10_000;

  // Every script counts toward the denominator — see ANY_LETTER. A reply in Han or Greek
  // dilutes the Cyrillic share exactly as Latin does, instead of vanishing from the census.
  const totalLetters = countMatches(text, ANY_LETTER);
  const otherLetters = Math.max(totalLetters - cyrillicLetters - latinLetters, 0);
  const base = {
    cyrillicLetters,
    latinLetters,
    otherLetters,
    foreignCyrillic,
    foreignWords,
    distinctForeign,
    foreignRatio,
  };

  if (
    totalLetters >= MIN_LETTERS_FOR_SCRIPT_CHECK &&
    cyrillicLetters / totalLetters < MIN_CYRILLIC_SHARE
  ) {
    return { verdict: "not_cyrillic", ...base };
  }

  // Too short for the share test, but carrying no Cyrillic whatsoever — an untranslated
  // headline. See MIN_LETTERS_FOR_ZERO_CYRILLIC for why this is safe at that length.
  if (cyrillicLetters === 0 && totalLetters >= MIN_LETTERS_FOR_ZERO_CYRILLIC) {
    return { verdict: "not_cyrillic", ...base };
  }

  const drifted =
    foreignWords >= MAX_FOREIGN_BEARING_WORDS ||
    distinctForeign.length >= MIN_DISTINCT_FOREIGN_CYRILLIC ||
    (foreignCyrillic >= MIN_FOREIGN_CYRILLIC_OCCURRENCES &&
      foreignRatio > MAX_FOREIGN_CYRILLIC_RATIO);

  return { verdict: drifted ? "foreign_cyrillic" : "bulgarian", ...base };
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

export interface TranslationPrompts {
  systemPrompt: string;
  userPrompt: string;
  /** Derived from the input text — a bodyless item is never asked for a body. */
  mode: TranslationReplyMode;
  /** The Ollama `format` schema matching `mode`. */
  schema: typeof TRANSLATION_JSON_SCHEMA | typeof TRANSLATION_TITLE_JSON_SCHEMA;
  /** Body characters actually sent, after sanitising and capping — logged for diagnostics. */
  contentChars: number;
  /** True when the source had no title and the model was asked to derive one from the body. */
  derivedTitle: boolean;
  /**
   * Values held out of the title/content before this prompt was built — URLs, e-mail
   * addresses, and identifiers (model names, SKUs, version strings) — each replaced by
   * a `[[n]]` placeholder in `userPrompt`. Empty when that field carried none. The
   * engine restores them after parsing and rejects the reply if one did not survive
   * intact; see `restoreTokens` in protected-tokens.ts.
   */
  titleProtectedValues: ProtectedValue[];
  contentProtectedValues: ProtectedValue[];
}

export interface BuildTranslationPromptsOptions {
  /**
   * Body-character budget for THIS build. Defaults to {@link MAX_TRANSLATION_CONTENT_CHARS};
   * a retry that follows a truncation passes a smaller one (see
   * {@link shrinkTranslationContentBudget}) so the same oversized reply is not requested again.
   */
  maxContentChars?: number;
}

/** The JSON-discipline lines, shared by both modes so they cannot drift apart. */
const JSON_DISCIPLINE = [
  "Output nothing before or after the JSON — no reasoning, no <think> block, no commentary, no summaries, no code fences.",
  "Make sure the JSON is complete and ends with its closing brace.",
  // The observed invalid_json replies broke on characters lifted straight out of the article's
  // own cite block — a raw double quote and a bare <URL>. Naming the escape rule is cheaper
  // than salvaging the result.
  'Inside the JSON strings, escape every double quote as \\" and every line break as \\n. Never put a raw newline or an unescaped quote inside a string.',
];

export function buildTranslationPrompts(
  title: string | null,
  content: string | null,
  targetLang: string,
  options: BuildTranslationPromptsOptions = {}
): TranslationPrompts {
  // Sanitising happens BEFORE classification and capping, so a body that is nothing but
  // navigation and credits is judged on what would actually be translated, and the cap spends
  // its budget on article text rather than on a cite block. See sanitiseTranslationContent.
  const cleanContent = sanitiseTranslationContent(content);
  const mode: TranslationReplyMode =
    classifyTranslationInput(title, cleanContent) === "full" ? "full" : "title_only";
  const language = languageName(targetLang);
  // A "full" item whose article has no title of its own — the `(untitled)` rows in the logs.
  const derivedTitle = mode === "full" && isBlank(title);

  // Values that are DATA rather than language — URLs, e-mail addresses, model codes,
  // SKUs, version strings — are swapped for `[[n]]` placeholders before the call and
  // swapped back after it, exactly as MADLAD's segment translation already does (see
  // protected-tokens.ts). Unprotected, a prompt-based model can still silently drop,
  // mistranslate, or "helpfully" reformat one of these even when told in prose to leave
  // it alone; the placeholder plus a programmatic restore-or-reject check afterwards
  // (see OllamaTranslationProvider) does not rely on the model's cooperation for
  // correctness, only for convenience.
  const cappedContent = capTranslationContent(
    cleanContent,
    options.maxContentChars ?? MAX_TRANSLATION_CONTENT_CHARS
  );
  const titleProtection = title ? protectTokens(title) : null;
  const contentProtection = cappedContent ? protectTokens(cappedContent) : null;
  const hasProtectedValues =
    (titleProtection?.values.length ?? 0) > 0 || (contentProtection?.values.length ?? 0) > 0;

  const lines =
    mode === "full"
      ? [
          `You are a professional translator. Translate the article title and body into ${language}.`,
          "Preserve meaning exactly. Keep proper names, URLs, brand names, model names, identifiers, SKUs, version numbers, code, and commands unchanged, exactly as written.",
          "Do not summarize, condense, expand, explain, or omit any information, and do not add anything that is not in the source. Translate only.",
        ]
      : [
          `You are a professional translator. Translate the article title into ${language}.`,
          "Preserve meaning exactly. Keep proper names, URLs, brand names, model names, identifiers, SKUs, version numbers, code, and commands unchanged, exactly as written.",
          "Do not summarize, condense, expand, explain, or omit any information, and do not add anything that is not in the source. Translate only.",
        ];

  if (isBulgarianTarget(targetLang)) {
    lines.push(
      "Translate ONLY into natural, fluent Bulgarian, written in Bulgarian Cyrillic.",
      "Do NOT use Serbian, Macedonian, Russian, or any mixed-language words, letters, or spelling.",
      // The extracted page can still carry a stray language-switcher phrase past sanitising.
      // Saying so explicitly stops it being copied through as if it were article text.
      "If the text contains words in Chinese, Japanese, Korean or any other language, do NOT copy them — translate their meaning into Bulgarian or leave them out."
    );
  }

  if (hasProtectedValues) {
    lines.push(
      "The text below contains placeholders of the exact form [[0]], [[1]], [[2]], etc., marking values that must not be touched — URLs, identifiers, model names, SKUs, version numbers, and similar.",
      "Copy every such placeholder through EXACTLY as written, including both square brackets and the number inside, once each, in the same position relative to the surrounding words. Never translate, alter, remove, duplicate, reorder, or explain a placeholder — translate only the ordinary words around it."
    );
  }

  if (mode === "full") {
    lines.push(
      'Respond with ONLY a single, complete JSON object of exactly this shape: {"title": "...", "content": "..."}',
      ...JSON_DISCIPLINE,
      derivedTitle
        ? // Previously this said to return an empty string, which is why every bodyless-titled
          // ArchDaily article completed with no translated title at all. The article body is
          // right there and is the honest source of a headline, so one is asked for — bounded,
          // and explicitly forbidden from adding anything the body does not say.
          `This article has no title of its own. Write a short ${language} title (at most 90 characters) taken from the article's opening — state only what the body already says, and invent nothing.`
        : 'If the article has no title, use an empty string "" for "title".'
    );
  } else {
    lines.push(
      'Respond with ONLY a single, complete JSON object of exactly this shape: {"title": "..."}',
      ...JSON_DISCIPLINE,
      // Stated as a prohibition rather than left unsaid: an unqualified "translate this
      // article" against a title alone is an invitation to write the article.
      "The article body is not available. Translate the title and NOTHING else — do not write, summarise, expand, or invent an article body, and do not add any other key to the JSON."
    );
  }

  const systemPrompt = lines.join("\n");
  const protectedTitleText = titleProtection?.text ?? title ?? "";
  const protectedContentText = contentProtection?.text ?? cappedContent ?? "";
  const userPrompt =
    mode === "full"
      ? [`Title: ${protectedTitleText}`, `Content: ${protectedContentText}`].join("\n")
      : `Title: ${protectedTitleText}`;

  return {
    systemPrompt,
    userPrompt,
    mode,
    schema: mode === "full" ? TRANSLATION_JSON_SCHEMA : TRANSLATION_TITLE_JSON_SCHEMA,
    contentChars: cappedContent?.length ?? 0,
    derivedTitle,
    titleProtectedValues: titleProtection?.values ?? [],
    contentProtectedValues: contentProtection?.values ?? [],
  };
}

/**
 * The prompt for a regeneration, carrying the ORIGINAL request plus what was wrong with the
 * last reply.
 *
 * Varying the sampling (see {@link samplingForTry}) is what stops a retry being a rerun; this
 * is what makes it a CORRECTION. A model told only "try again" reproduces the same class of
 * mistake — it emitted prose because it thought prose was wanted, and it drifted into
 * Macedonian because it did not notice. Naming the defect is the cheapest thing that changes
 * either. Mirrors `buildExtractionRepairPrompt` in product-page-extraction.ts.
 */
export function buildTranslationRetryPrompt(
  originalUserPrompt: string,
  failure: { reason: TranslationParseFailure; feedback: string }
): string {
  return [
    originalUserPrompt,
    "",
    "---",
    "YOUR PREVIOUS ANSWER WAS REJECTED.",
    failure.feedback,
    "Answer again in full. Return ONLY the corrected JSON object — no apology, no explanation, no reasoning.",
  ].join("\n");
}

/**
 * Why a model reply could not be accepted — surfaced in diagnostics so the failure
 * modes are distinguishable at a glance:
 *   • invalid_json      — not parseable as JSON even after the fallback repair;
 *   • schema_validation — valid JSON but the wrong shape (missing/!string title|content);
 *   • empty_translation — the right shape, but the model returned no text to store;
 *   • wrong_language    — right shape, but the text is not Bulgarian (drifted language);
 *   • repetition        — right shape and language, but the body is a decoding loop.
 */
export type TranslationParseFailure =
  | "invalid_json"
  | "schema_validation"
  | "empty_translation"
  | "wrong_language"
  | "repetition"
  /**
   * A value that was held OUT of the decoder — a URL, an e-mail address, a model
   * code — did not come back intact, so the translation cannot be reassembled without
   * guessing. Raised by the NMT engine's per-segment restoration, and by the
   * prompt-based engine's own restoration of the whole title/content (see
   * lib/ai/translation/protected-tokens.ts and OllamaTranslationProvider) — both send
   * `[[n]]` placeholders and both reject a reply that did not carry them through intact.
   */
  | "protected_token";

/** The correction sent back to the model, per failure reason. */
const DEFAULT_FEEDBACK: Record<TranslationParseFailure, string> = {
  invalid_json:
    "Your reply was not a single valid JSON object. Answer with ONE complete JSON object and nothing else: no reasoning, no <think> block, no markdown fences, no text before or after it. Every string must be closed with a quote and the object must end with }.",
  schema_validation:
    "Your JSON did not have the required shape. Return exactly the keys described above, each holding a plain string, and nothing else.",
  empty_translation:
    "You returned an empty translation. Translate the text you were given and put the result in the JSON — do not return an empty string.",
  wrong_language:
    "Your translation was not Bulgarian. Write it again in standard Bulgarian Cyrillic only, using the Bulgarian alphabet (а б в г д е ж з и й к л м н о п р с т у ф х ц ч ш щ ъ ь ю я). Do not use Russian, Macedonian or Serbian letters or spelling.",
  repetition:
    "Your translation broke down and repeated the same word or phrase over and over. Translate the text once, from the beginning, as normal continuous prose.",
  protected_token:
    "Your translation did not reproduce the placeholders exactly. Copy every [[n]] placeholder through unchanged, once each, and translate only the words around them.",
};

export class TranslationParseError extends Error {
  readonly code = "TRANSLATION_PARSE_ERROR" as const;
  readonly reason: TranslationParseFailure;
  /**
   * What to tell the MODEL on the retry — distinct from `message`, which is for the
   * operator and lands in `translationError`. See {@link buildTranslationRetryPrompt}.
   */
  readonly feedback: string;
  /** Present only for `repetition`: the looping unit and its repeat count, for logging. */
  readonly repetition?: RepetitionFinding;
  /**
   * True when the reply was CUT OFF rather than malformed — the model ran out of generation
   * budget mid-object. The retry reads this to rebuild the prompt with a smaller body (see
   * {@link shrinkTranslationContentBudget}); every other defect keeps the body it had, because
   * shortening the article does not make a model stop answering in Macedonian.
   */
  readonly truncated: boolean;
  constructor(
    message: string,
    reason: TranslationParseFailure = "invalid_json",
    options: { feedback?: string; repetition?: RepetitionFinding; truncated?: boolean } = {}
  ) {
    super(message);
    this.name = "TranslationParseError";
    this.reason = reason;
    this.feedback = options.feedback ?? DEFAULT_FEEDBACK[reason];
    this.repetition = options.repetition;
    this.truncated = options.truncated ?? false;
  }
}

/**
 * Whether regenerating is worth a retry slot. Every parse failure listed here is a
 * MODEL-output defect of the prompt-based engine — a different sample of the same prompt,
 * with the defect named back to it, can come out clean.
 *
 * `protected_token` IS on this list for this engine, unlike MADLAD's own use of the same
 * reason: this function is consulted only by the prompt-based engine (MADLAD's segment
 * repair has its own, separate accept/keep-original logic and never calls it — see
 * segment-repair.ts), whose sampling is NOT deterministic — `samplingForTry` raises the
 * temperature on every retry, so a fresh sample naming the dropped placeholder back to the
 * model is a real chance at a clean reply, not a guaranteed repeat of the same defect.
 *
 * Note what is NOT on this list, because that is the point: a source article with no body is
 * not a parse failure at all. It never reaches the model (see
 * {@link classifyTranslationInput}), so it can never spend a retry on a defect no sample can
 * fix.
 */
export function isRetriableParseFailure(reason: TranslationParseFailure): boolean {
  return (
    reason === "invalid_json" ||
    reason === "schema_validation" ||
    reason === "empty_translation" ||
    reason === "wrong_language" ||
    reason === "repetition" ||
    reason === "protected_token"
  );
}

// ─── JSON salvage ─────────────────────────────────────────────────────────────

/**
 * What had to be done to a reply before it could be parsed. Reported so an operator can see
 * whether structured output is being honoured at all, and which defect is recurring.
 */
export type JsonRepair =
  | "stripped_reasoning"
  | "stripped_fence"
  | "trimmed_prose"
  | "escaped_control_chars"
  | "closed_string"
  | "closed_object"
  /** A cut landed inside a KEY, so the half-written member was dropped rather than closed. */
  | "dropped_partial_key"
  /** A cut landed after a comma or a `"key":` with no value — the dangling tail was removed. */
  | "dropped_partial_member";

/**
 * The repairs that mean the reply was CUT OFF rather than merely untidy.
 *
 * Stripping a `<think>` block or a code fence says the model packaged its answer badly;
 * these say it never finished it, which is a different problem with a different remedy —
 * the retry shrinks the body instead of only re-rolling. See {@link TranslationParseError}.
 */
const CUT_REPAIRS: readonly JsonRepair[] = [
  "closed_string",
  "closed_object",
  "dropped_partial_key",
  "dropped_partial_member",
];

function indicatesTruncation(repairs: readonly JsonRepair[]): boolean {
  return repairs.some((r) => CUT_REPAIRS.includes(r));
}

/**
 * Salvaged content shorter than this is not a translation, it is a fragment.
 *
 * The gate applies only to a reply cut off mid-string. Closing an unterminated string always
 * "works" — it just may produce two words — so length is what separates a translation the
 * model had all but finished from one it barely started. Rejecting the fragment sends the
 * item back for a regeneration, which is the right answer; rejecting the near-complete one
 * would spend an attempt re-doing work that is already usable.
 */
export const MIN_REPAIRED_CONTENT_CHARS = 200;

/**
 * Removes a reasoning model's `<think>` block. qwen3 emits one before its answer even when
 * told not to; an unclosed block means the reasoning ran to the generation limit and the
 * answer never came, so everything from the opening tag is dropped and the reply is then
 * (correctly) found to hold no JSON. Mirrors `findJsonObject` in product-page-extraction.ts.
 */
function stripReasoning(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, " ").replace(/<think>[\s\S]*$/i, " ");
}

/** The content of a ``` fence, or null when the reply is not fenced. */
function unfence(raw: string): string | null {
  const closed = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (closed) return closed[1];
  // A fence opened and never closed — the same truncation, one level out.
  const open = raw.match(/```(?:json)?\s*([\s\S]*)$/i);
  return open ? open[1] : null;
}

/** The first COMPLETE, balanced JSON object in `text` at or after `start`, or null. */
function firstBalancedObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Drops a dangling tail that cannot become a complete member, so the object can be closed.
 *
 * Two shapes, both of them a cut landing in the gap BETWEEN values rather than inside one:
 *
 *   • `{"title":"Заглавие",`          — a comma promising a member that never arrived;
 *   • `{"title":"Заглавие","content":` — a key and colon with no value behind them.
 *
 * Both were previously left as-is, producing `{"title":"Заглавие",}` — still invalid, so the
 * whole reply was rejected as `invalid_json` and a title the model had finished perfectly well
 * was thrown away with it. Removing the promise instead keeps everything the model DID
 * complete, and the field checks downstream still decide whether that is enough: a `full`
 * translation missing its body is rejected exactly as before, just as `schema_validation`
 * (accurate) rather than `invalid_json` (misleading). Nothing is invented — this only ever
 * deletes an unfulfilled promise.
 */
function trimDanglingMember(text: string): { text: string; dropped: boolean } {
  let out = text;
  let dropped = false;

  for (;;) {
    const trimmed = out.replace(/\s+$/u, "");
    if (trimmed.endsWith(",")) {
      out = trimmed.slice(0, -1);
      dropped = true;
      continue;
    }
    if (trimmed.endsWith(":")) {
      // Walk back over the key string this colon belongs to, honouring escapes.
      const beforeColon = trimmed.slice(0, -1).replace(/\s+$/u, "");
      if (!beforeColon.endsWith('"')) return { text: out, dropped };
      let i = beforeColon.length - 2;
      while (i >= 0) {
        if (beforeColon[i] === '"') {
          let backslashes = 0;
          let j = i - 1;
          while (j >= 0 && beforeColon[j] === "\\") {
            backslashes += 1;
            j -= 1;
          }
          if (backslashes % 2 === 0) break;
        }
        i -= 1;
      }
      if (i < 0) return { text: out, dropped };
      out = beforeColon.slice(0, i);
      dropped = true;
      continue;
    }
    return { text: out, dropped };
  }
}

/**
 * Repairs an object the model stopped emitting part-way through.
 *
 * The defects, all observed on the self-hosted worker, all of them the model running out of
 * output budget rather than misunderstanding the contract:
 *
 *   • a raw newline/tab inside a string value — legal prose, illegal JSON;
 *   • a value cut off mid-string, so the string never closes;
 *   • a KEY cut off mid-string, where closing it would fabricate a member;
 *   • a cut between members (`…",` or `…"content":`) — see {@link trimDanglingMember};
 *   • one or more closing braces missing at the very end.
 *
 * The key case is why the string-close tracks POSITION. Closing `{"title":"X","cont` as though
 * `"cont` were a value produces `{"title":"X","cont […]"}`, which parses but invents a member
 * the model never wrote; dropping it keeps the object honest and leaves the field checks to
 * reject what is genuinely missing.
 */
function repairTruncatedJson(candidate: string): { text: string; repairs: JsonRepair[] } {
  const repairs: JsonRepair[] = [];
  let out = "";
  let inString = false;
  let escaped = false;
  let depth = 0;
  let escapedControl = false;
  /** Index in `out` of the quote that opened the string currently being read. */
  let stringStart = -1;
  /** Whether that string is a KEY (it followed `{` or `,`) rather than a value (followed `:`). */
  let stringIsKey = false;
  /** Last structural character seen outside a string — what decides key vs. value. */
  let lastStructural = "";

  for (const ch of candidate) {
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        out += ch;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20) {
        escapedControl = true;
        out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : " ";
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = true;
      stringStart = out.length;
      stringIsKey = lastStructural === "{" || lastStructural === ",";
    } else if (ch === "{") {
      depth += 1;
      lastStructural = ch;
    } else if (ch === "}") {
      depth -= 1;
      lastStructural = ch;
    } else if (ch === "," || ch === ":") {
      lastStructural = ch;
    }
    out += ch;
  }

  if (escapedControl) repairs.push("escaped_control_chars");

  if (inString) {
    if (stringIsKey) {
      // A half-written key names nothing — drop it rather than inventing a member for it.
      out = out.slice(0, stringStart);
      repairs.push("dropped_partial_key");
    } else {
      // A dangling backslash would become an invalid escape once the quote is added.
      if (escaped) out = out.slice(0, -1);
      // Drop the final, almost certainly half-written word and mark the cut with the same
      // marker capTranslationContent uses, so a shortened translation reads as an excerpt.
      out = `${out.replace(/\s+\S*$/u, "")} […]"`;
      repairs.push("closed_string");
    }
  }

  const trimmed = trimDanglingMember(out);
  out = trimmed.text;
  if (trimmed.dropped) repairs.push("dropped_partial_member");

  if (depth > 0) {
    out += "}".repeat(depth);
    repairs.push("closed_object");
  }
  return { text: out, repairs };
}

/**
 * Isolates a parseable JSON object from a model reply.
 *
 * Tolerant about packaging, strict about substance. `<think>` blocks, ``` fences and prose
 * around the object are all stripped, and a truncated object is repaired — none of which
 * loosens validation, because the result is still handed to JSON.parse and to the field
 * checks below. A reply with no object at all is prose, and prose is rejected.
 */
function extractJson(raw: string): { text: string; repairs: JsonRepair[] } {
  const repairs: JsonRepair[] = [];

  const withoutReasoning = stripReasoning(raw);
  if (withoutReasoning !== raw) repairs.push("stripped_reasoning");

  const fenced = unfence(withoutReasoning);
  if (fenced !== null) repairs.push("stripped_fence");
  const body = (fenced ?? withoutReasoning).trim();

  const start = body.indexOf("{");
  if (start === -1) {
    throw new TranslationParseError("Translation response contained no JSON object.");
  }

  // A complete object wins outright, and taking the FIRST balanced one (rather than slicing
  // to the last "}" anywhere in the reply) is what keeps trailing commentary — which may
  // itself contain braces — out of the candidate.
  // A complete object still goes through the repair pass: its braces balance, but a raw
  // newline the model left inside a string value is legal prose and illegal JSON, and that
  // is a whole-item failure for a reply that is otherwise perfect. The pass is a no-op on
  // clean JSON, so nothing else changes.
  const balanced = firstBalancedObject(body, start);
  const candidate = balanced ?? body.slice(start);
  if (balanced !== null && balanced.length !== body.length) repairs.push("trimmed_prose");

  const repaired = repairTruncatedJson(candidate);
  return { text: repaired.text, repairs: [...repairs, ...repaired.repairs] };
}

// ─── Reply validation ─────────────────────────────────────────────────────────

export interface ParseTranslationOptions {
  /** "full" expects a translated body; "title_only" must never store one. */
  mode?: TranslationReplyMode;
}

export interface ParsedTranslation {
  translatedTitle: string | null;
  /** Null in title-only mode — the article had no body, so the translation has none. */
  translatedContent: string | null;
  /** True when the primary JSON.parse failed and the defensive salvage rescued the reply. */
  usedRepair: boolean;
  /** Exactly which repairs the salvage applied; empty on the clean path. */
  repairs: JsonRepair[];
  /** Present for Bulgarian targets — the measured basis of the language verdict. */
  language?: BulgarianAssessment;
}

/**
 * Parses and validates the model's reply against the schema for its {@link TranslationReplyMode}.
 *
 * Primary path: with Ollama structured output the reply is already a clean JSON object, so we
 * `JSON.parse` it directly. Fallback path: only if that throws do we run {@link extractJson} —
 * a salvage net, never the first mechanism. `usedRepair`/`repairs` report which path won and
 * what it cost, so operators can tell whether structured output is being honoured.
 *
 * After parsing, the object is schema-validated, language-checked for Bulgarian targets
 * ({@link assessBulgarian}), and finally screened for decoding loops ({@link detectRepetition})
 * — a loop is valid JSON in the right language, so it has to be caught here or it ships. Every
 * rejection throws a {@link TranslationParseError} carrying a `reason` and the `feedback` the
 * retry sends back to the model; the caller regenerates while retries remain, then records a
 * failure with backoff.
 */
export function parseTranslationResponse(
  raw: string,
  targetLang?: string,
  options: ParseTranslationOptions = {}
): ParsedTranslation {
  const mode: TranslationReplyMode = options.mode ?? "full";

  let parsed: unknown;
  let usedRepair = false;
  let repairs: JsonRepair[] = [];
  try {
    // Primary: structured output should be a clean, complete JSON object.
    parsed = JSON.parse(raw.trim());
  } catch {
    usedRepair = true;
    let salvaged: { text: string; repairs: JsonRepair[] };
    try {
      salvaged = extractJson(raw);
    } catch (err) {
      if (err instanceof TranslationParseError) throw err;
      throw new TranslationParseError("Translation response was not valid JSON.", "invalid_json");
    }
    repairs = salvaged.repairs;
    try {
      parsed = JSON.parse(salvaged.text);
    } catch {
      throw new TranslationParseError("Translation response was not valid JSON.", "invalid_json", {
        // Salvage saw a cut but still could not make it parse — the reply was truncated
        // somewhere the repair passes do not reach, so the retry should ask for less.
        truncated: indicatesTruncation(repairs),
      });
    }
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TranslationParseError(
      "Translation response was not a JSON object.",
      "schema_validation"
    );
  }

  const record = parsed as Record<string, unknown>;

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
  const normalisedTitle = typeof title === "string" && title.trim() !== "" ? title : null;

  // Title-only: the model was never given a body, so whatever it may have put in a `content`
  // key is invented and is dropped here rather than stored.
  if (mode === "title_only") {
    if (normalisedTitle === null) {
      throw new TranslationParseError(
        'Translation response is missing a non-empty "title".',
        "empty_translation"
      );
    }
    if (repairs.includes("closed_string")) {
      // A title is a line long; one cut mid-way is a fragment, never an excerpt worth keeping.
      throw new TranslationParseError(
        "Translation response was cut off inside the title.",
        "invalid_json",
        { truncated: true }
      );
    }
    assertBulgarianEnough(normalisedTitle, targetLang);
    return {
      translatedTitle: normalisedTitle,
      translatedContent: null,
      usedRepair,
      repairs,
      ...languageOf(normalisedTitle, targetLang),
    };
  }

  if (!("content" in record) || typeof record.content !== "string") {
    throw new TranslationParseError(
      'Translation response is missing "content".',
      "schema_validation",
      // Salvage dropped a half-written `"content"` key or a dangling comma, so the body was
      // not missing by choice — the model was cut off before it wrote one.
      { truncated: indicatesTruncation(repairs) }
    );
  }
  const content = record.content;
  if (content.trim() === "") {
    throw new TranslationParseError(
      'Translation response is missing a non-empty "content".',
      "empty_translation"
    );
  }
  if (repairs.includes("closed_string") && content.trim().length < MIN_REPAIRED_CONTENT_CHARS) {
    // Salvage produced a fragment rather than a translation — reject it as the malformed
    // reply it is, instead of storing two words as a completed translation. This is the
    // "cut off after very short content" line in the logs: the reply stopped almost as soon
    // as it started, so the next try asks for a smaller article rather than the same one.
    throw new TranslationParseError(
      `Translation response was cut off after ${content.trim().length} characters.`,
      "invalid_json",
      { truncated: true }
    );
  }

  const languageText = `${normalisedTitle ?? ""}\n${content}`;
  assertBulgarianEnough(languageText, targetLang);

  // Degeneration guard: a decoding loop is well-formed JSON in the right language, so it
  // passes every check above and would otherwise be stored as a completed translation.
  const loop = detectRepetition(content);
  if (loop) {
    throw new TranslationParseError(
      `Translation degenerated into a ${loop.kind} loop ("${loop.sample}" ×${loop.count}).`,
      "repetition",
      { repetition: loop }
    );
  }

  return {
    translatedTitle: normalisedTitle,
    translatedContent: content,
    usedRepair,
    repairs,
    ...languageOf(languageText, targetLang),
  };
}

/** The measured assessment, when the target is Bulgarian; nothing otherwise. */
function languageOf(text: string, targetLang?: string): { language?: BulgarianAssessment } {
  if (!targetLang || !isBulgarianTarget(targetLang)) return {};
  return { language: assessBulgarian(text) };
}

/** Throws `wrong_language` when a Bulgarian target got something that is measurably not it. */
function assertBulgarianEnough(text: string, targetLang?: string): void {
  if (!targetLang || !isBulgarianTarget(targetLang)) return;
  const a = assessBulgarian(text);
  if (a.verdict === "bulgarian") return;

  if (a.verdict === "not_cyrillic") {
    const totalLetters = a.cyrillicLetters + a.latinLetters + a.otherLetters;
    // `otherLetters` is called out separately: "0 of 120 letters are Cyrillic" reads the same
    // for an untranslated English reply and an all-Chinese one, and those are different bugs.
    const drift = a.otherLetters > 0 ? `, ${a.otherLetters} in another script entirely` : "";
    throw new TranslationParseError(
      `Translation is not Bulgarian — only ${a.cyrillicLetters} of ${totalLetters} letters are Cyrillic${drift} (the source appears untranslated).`,
      "wrong_language"
    );
  }
  throw new TranslationParseError(
    `Translation is not Bulgarian — ${a.foreignWords} distinct word(s) and ${a.foreignCyrillic} of ${a.cyrillicLetters} Cyrillic letters (${(a.foreignRatio * 100).toFixed(1)}%) carry Serbian/Macedonian/Russian letters: ${a.distinctForeign.join(", ")}.`,
    "wrong_language"
  );
}
