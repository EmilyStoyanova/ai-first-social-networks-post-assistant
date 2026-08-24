/**
 * EXPERIMENT — not wired into the production pipeline. See the investigation report
 * for the evidence this is built from and the recommendation it produced.
 *
 * Question: can the existing prompt-based engine (qwen3:8b, over the same TEXT_WORKER
 * transport MADLAD and Ollama translation already use) EDIT a validated MADLAD
 * Bulgarian translation into better Bulgarian, without retranslating the article and
 * without damaging the technical identifiers MADLAD's own protected-token machinery
 * already guarantees?
 *
 * Pipeline exercised here, read-only against the DB:
 *
 *   English source
 *     → MadladTranslationProvider (the REAL, already-fixed provider — bypass +
 *       segment repair — imported unchanged, not reimplemented)
 *     → validated Bulgarian ("B", what production would store today)
 *     → THIS SCRIPT: paragraph-chunked polishing through qwen3:8b, each chunk
 *       verified against the SAME protected-token machinery MADLAD itself uses
 *     → polished Bulgarian ("C"), or the untouched MADLAD chunk wherever the
 *       polish could not be trusted
 *
 * No database write happens anywhere in this file. `runExperiment` is the only
 * function that talks to Prisma or the network; everything else is pure and unit
 * tested in the paired .test.ts file.
 *
 * Usage:
 *   npx tsx scripts/experiment-translation-polish.ts --id <feedItemId>
 */
import "dotenv/config";
import { fileURLToPath } from "node:url";
import { prisma } from "@/lib/db/client";
import { OllamaTranslationProvider } from "@/lib/ai/translation/ollama-translation.provider";
import { TextWorkerProvider } from "@/lib/ai/llm/text-worker.provider";
import {
  buildTranslationPrompts,
  TranslationParseError,
  detectRepetition,
  assessBulgarian,
} from "@/lib/ai/feed-item-translation";
import {
  protectTokens,
  restoreTokens,
  type ProtectedText,
  type ProtectedValue,
} from "@/lib/ai/translation/protected-tokens";
import {
  isDataOnlySegment,
  maxRepairsFor,
  unpreservedValues,
} from "@/lib/ai/translation/segment-repair";
import { segmentArticle, reassembleArticle } from "@/lib/ai/translation/madlad-segmentation";
import { GenerationTracer } from "@/lib/generation-trace/tracer";

// ─── Protected-value verification (reuses the SAME machinery MADLAD repair uses) ──

/**
 * Every value in `englishText` that `protectTokens` would freeze behind a placeholder
 * in the real pipeline — "WSE-3", "44GB", "300GB/sec". This is not a new notion of
 * "identifier"; it is the existing one, read for verification instead of substitution.
 */
export function requiredIdentifiers(englishText: string): ProtectedValue[] {
  return protectTokens(englishText).values.filter((v) => v.kind === "identifier");
}

/**
 * Plain-word technical entities the existing protected-token machinery deliberately
 * does NOT freeze — "Cerebras", "TSMC", "NVIDIA", "AMD", "SRAM", "PFLOPS", bare "WSE",
 * "RoCEv2". protectTokens only ever protects a value shaped like DATA (a URL, an
 * e-mail, or an alnum code with a digit or all-caps internal punctuation); a plain
 * brand word is left to the model everywhere else in this pipeline too, on purpose
 * (see protected-tokens.ts's own design note on why freezing every proper noun would
 * be a regression, not a safety net).
 *
 * This is therefore a DELIBERATELY NARROW, experiment-scoped supplement, not a second
 * protection system: an all-caps acronym (2+ letters — TSMC, NVIDIA, AMD, SRAM), a
 * mixed-case alphanumeric with an internal digit and no separator (RoCEv2 — the shape
 * `isIdentifier` explicitly excludes because it has lowercase letters), and the literal
 * word "Cerebras". A production integration would need a real decision about entity
 * protection, not this list — see the report.
 */
export function watchedEntities(englishText: string): string[] {
  const found = new Set<string>();
  for (const m of englishText.matchAll(/\b[A-Z]{2,}\b/g)) found.add(m[0]);
  for (const m of englishText.matchAll(/\b[A-Za-z]*[a-z][A-Za-z]*\d[A-Za-z0-9]*\b/g)) {
    if (/[A-Z]/.test(m[0])) found.add(m[0]); // mixed-case + digit, e.g. "RoCEv2"
  }
  if (/\bCerebras\b/.test(englishText)) found.add("Cerebras");
  return [...found];
}

export interface ChunkVerification {
  ok: boolean;
  lostIdentifiers: string[];
  lostEntities: string[];
  isBulgarian: boolean;
  isDegenerate: boolean;
}

/** Everything that must hold for a polished chunk to be TRUSTED over the MADLAD one. */
export function verifyPolishedChunk(englishChunk: string, polishedBg: string): ChunkVerification {
  const lostIdentifiers = unpreservedValues(requiredIdentifiers(englishChunk), polishedBg);
  const lostEntities = watchedEntities(englishChunk).filter((e) => !polishedBg.includes(e));
  const isBulgarian = assessBulgarian(polishedBg).verdict === "bulgarian";
  const isDegenerate = detectRepetition(polishedBg) !== null;
  return {
    ok: lostIdentifiers.length === 0 && lostEntities.length === 0 && isBulgarian && !isDegenerate,
    lostIdentifiers,
    lostEntities,
    isBulgarian,
    isDegenerate,
  };
}

// ─── Paragraph-preserving chunking ─────────────────────────────────────────────

export interface ParagraphChunk {
  /** Index of the first / last paragraph this chunk covers, 0-based, inclusive. */
  firstParagraph: number;
  lastParagraph: number;
  en: string;
  bg: string;
}

/**
 * Splits English source and MADLAD Bulgarian on the SAME paragraph boundaries, then
 * groups consecutive paragraph pairs into chunks under `maxCharsPerChunk` (measured
 * on the English half — Bulgarian tokenises longer, so this is the conservative side).
 *
 * Never splits a paragraph, and never reorders — `reassembleArticle` preserves the
 * source's own paragraph structure byte for byte (see madlad-segmentation.ts), so
 * splitting both texts on "\n\n" is expected to yield the SAME paragraph count. That
 * expectation is asserted, not assumed: a mismatch means something upstream changed
 * the article's shape, and chunking must not silently pair the wrong paragraphs.
 */
export function chunkParagraphs(
  englishContent: string,
  madladContent: string,
  maxCharsPerChunk: number
): ParagraphChunk[] {
  const en = englishContent.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  const bg = madladContent.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  if (en.length !== bg.length) {
    throw new Error(
      `Paragraph count mismatch: ${en.length} English vs ${bg.length} Bulgarian — refusing to ` +
        `guess which paragraph pairs with which.`
    );
  }

  const chunks: ParagraphChunk[] = [];
  let start = 0;
  while (start < en.length) {
    let end = start;
    let chars = en[start].length;
    while (end + 1 < en.length && chars + en[end + 1].length <= maxCharsPerChunk) {
      end += 1;
      chars += en[end].length;
    }
    chunks.push({
      firstParagraph: start,
      lastParagraph: end,
      en: en.slice(start, end + 1).join("\n\n"),
      bg: bg.slice(start, end + 1).join("\n\n"),
    });
    start = end + 1;
  }
  return chunks;
}

// ─── The polishing prompt ──────────────────────────────────────────────────────

const JSON_DISCIPLINE = [
  "Output nothing before or after the JSON — no reasoning, no <think> block, no commentary.",
  "Make sure the JSON is complete and ends with its closing brace.",
  'Inside the JSON strings, escape every double quote as \\" and every line break as \\n.',
];

/**
 * The rules every polish call sends, English-only (the instructions ARE English; the
 * content being edited is Bulgarian) so the model is never confused about which
 * language governs the task versus which language the answer must be in.
 */
function polishRules(
  protectedIdentifiers: readonly string[],
  entities: readonly string[]
): string[] {
  return [
    "You are EDITING an existing Bulgarian translation of a technical article — you are NOT",
    "translating the English source from scratch, and you are NOT summarising it.",
    "",
    "The Bulgarian draft was produced by a different, faster translator and is mostly correct,",
    "but may contain: unnatural or literal Bulgarian phrasing, incorrect technical terminology,",
    "inconsistent terms for the same concept, sentences left untranslated in English, or",
    "invented details that are not in the English source.",
    "",
    "Rules, in order of importance:",
    "1. Preserve ALL factual information from the English source. Do not add facts. Do not",
    "   remove facts. Do not shorten the article or summarise any part of it.",
    "2. If any sentence or phrase was left in English, translate it into Bulgarian.",
    "3. Fix unnatural Bulgarian grammar and sentence structure so it reads as normal,",
    "   professional Bulgarian technical writing.",
    "4. Fix obviously incorrect literal translations and use natural Bulgarian technical",
    "   terminology instead (for example: a mistranslated or invented Bulgarian rendering of",
    "   a technical term should become the term Bulgarian technical writing actually uses).",
    "5. Use ONE consistent Bulgarian term for the same English concept throughout — do not use",
    "   several different Bulgarian words for the same thing in different sentences.",
    "6. Do not invent units, currencies, quantities, companies, or technical terms that are not",
    "   in the English source. If you are not sure how to render a technical term in Bulgarian,",
    "   leave it in English rather than guessing — an uncertain English term is safer than an",
    "   invented Bulgarian one.",
    "",
    "The following values MUST appear in your output EXACTLY as written below — same letters,",
    "same digits, same case, same punctuation. NEVER translate, transliterate, or alter them:",
    protectedIdentifiers.length > 0 ? protectedIdentifiers.join(", ") : "(none in this section)",
    "",
    "The following company/product/technology names MUST also be kept exactly as written below,",
    "in Latin letters — never transliterated into Cyrillic, never translated:",
    entities.length > 0 ? entities.join(", ") : "(none in this section)",
  ];
}

export function buildContentPolishPrompt(
  englishChunk: string,
  madladChunk: string,
  protectedIdentifiers: readonly string[],
  entities: readonly string[]
): { systemPrompt: string; userPrompt: string; format: unknown } {
  const systemPrompt = [
    ...polishRules(protectedIdentifiers, entities),
    "",
    'Respond with ONLY a single, complete JSON object of exactly this shape: {"content": "..."}',
    ...JSON_DISCIPLINE,
  ].join("\n");
  const userPrompt = [
    "ENGLISH SOURCE (for facts and correct terminology only — do not translate this fresh):",
    englishChunk,
    "",
    "BULGARIAN DRAFT TO EDIT (this is what you must improve and return):",
    madladChunk,
  ].join("\n");
  return {
    systemPrompt,
    userPrompt,
    format: {
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
      additionalProperties: false,
    },
  };
}

export function buildTitlePolishPrompt(
  englishTitle: string,
  madladTitle: string,
  protectedIdentifiers: readonly string[],
  entities: readonly string[]
): { systemPrompt: string; userPrompt: string; format: unknown } {
  const systemPrompt = [
    ...polishRules(protectedIdentifiers, entities),
    "",
    "This is a TITLE, one line. Do not expand it into a sentence if it was not one.",
    'Respond with ONLY a single, complete JSON object of exactly this shape: {"title": "..."}',
    ...JSON_DISCIPLINE,
  ].join("\n");
  const userPrompt = [
    `ENGLISH SOURCE TITLE: ${englishTitle}`,
    `BULGARIAN DRAFT TITLE TO EDIT: ${madladTitle}`,
  ].join("\n");
  return {
    systemPrompt,
    userPrompt,
    format: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    },
  };
}

/** Extracts `field` from a `{"field": "..."}` JSON reply, tolerating light drift. */
export function parsePolishReply(raw: string, field: "title" | "content"): string | null {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const value = parsed[field];
    return typeof value === "string" && value.trim().length > 0 ? value : null;
  } catch {
    return null;
  }
}

// ─── Orchestration (network + DB — not exercised by unit tests) ───────────────

const MAX_CHARS_PER_CHUNK = 1_500;
const POLISH_MAX_OUTPUT_TOKENS = 3_000;

export interface PolishChunkOutcome {
  firstParagraph: number;
  lastParagraph: number;
  used: "polished" | "madlad";
  reason: string | null;
  callMs: number;
  enChars: number;
  madladBgChars: number;
  polishedBgChars: number | null;
}

export interface PolishResult {
  title: { used: "polished" | "madlad"; reason: string | null; value: string; callMs: number };
  content: string;
  chunks: PolishChunkOutcome[];
  totalCalls: number;
  totalMs: number;
}

async function callQwen(
  worker: TextWorkerProvider,
  systemPrompt: string,
  userPrompt: string,
  format: unknown
): Promise<{ text: string; ms: number }> {
  const started = Date.now();
  const res = await worker.generate({
    systemPrompt,
    userPrompt,
    temperature: 0,
    maxTokens: POLISH_MAX_OUTPUT_TOKENS,
    format,
  });
  return { text: res.text, ms: Date.now() - started };
}

export async function polishArticle(
  worker: TextWorkerProvider,
  englishTitle: string | null,
  englishContent: string,
  madladTitle: string | null,
  madladContent: string
): Promise<PolishResult> {
  const overallStart = Date.now();
  let totalCalls = 0;

  // Title — one small call, verified the same way as a content chunk.
  let title: PolishResult["title"] = {
    used: "madlad",
    reason: "no english title",
    value: madladTitle ?? "",
    callMs: 0,
  };
  if (englishTitle && madladTitle) {
    const ids = requiredIdentifiers(englishTitle).map((v) => v.value);
    const ents = watchedEntities(englishTitle);
    const prompt = buildTitlePolishPrompt(englishTitle, madladTitle, ids, ents);
    const { text, ms } = await callQwen(
      worker,
      prompt.systemPrompt,
      prompt.userPrompt,
      prompt.format
    );
    totalCalls += 1;
    const polished = parsePolishReply(text, "title");
    if (polished === null) {
      title = { used: "madlad", reason: "unparseable reply", value: madladTitle, callMs: ms };
    } else {
      const v = verifyPolishedChunk(englishTitle, polished);
      title = v.ok
        ? { used: "polished", reason: null, value: polished, callMs: ms }
        : {
            used: "madlad",
            reason: `lost ${[...v.lostIdentifiers, ...v.lostEntities].join(", ") || "language/degeneracy check"}`,
            value: madladTitle,
            callMs: ms,
          };
    }
  }

  const paragraphChunks = chunkParagraphs(englishContent, madladContent, MAX_CHARS_PER_CHUNK);
  const outcomes: PolishChunkOutcome[] = [];
  const finalParagraphs: string[] = [];

  for (const chunk of paragraphChunks) {
    const ids = requiredIdentifiers(chunk.en).map((v) => v.value);
    const ents = watchedEntities(chunk.en);
    const prompt = buildContentPolishPrompt(chunk.en, chunk.bg, ids, ents);
    const { text, ms } = await callQwen(
      worker,
      prompt.systemPrompt,
      prompt.userPrompt,
      prompt.format
    );
    totalCalls += 1;
    const polished = parsePolishReply(text, "content");

    if (polished === null) {
      outcomes.push({
        firstParagraph: chunk.firstParagraph,
        lastParagraph: chunk.lastParagraph,
        used: "madlad",
        reason: "unparseable reply",
        callMs: ms,
        enChars: chunk.en.length,
        madladBgChars: chunk.bg.length,
        polishedBgChars: null,
      });
      finalParagraphs.push(chunk.bg);
      continue;
    }

    const v = verifyPolishedChunk(chunk.en, polished);
    if (v.ok) {
      outcomes.push({
        firstParagraph: chunk.firstParagraph,
        lastParagraph: chunk.lastParagraph,
        used: "polished",
        reason: null,
        callMs: ms,
        enChars: chunk.en.length,
        madladBgChars: chunk.bg.length,
        polishedBgChars: polished.length,
      });
      finalParagraphs.push(polished);
    } else {
      const reason = `lost ${[...v.lostIdentifiers, ...v.lostEntities].join(", ") || "language/degeneracy check"}`;
      outcomes.push({
        firstParagraph: chunk.firstParagraph,
        lastParagraph: chunk.lastParagraph,
        used: "madlad",
        reason,
        callMs: ms,
        enChars: chunk.en.length,
        madladBgChars: chunk.bg.length,
        polishedBgChars: polished.length,
      });
      finalParagraphs.push(chunk.bg);
    }
  }

  return {
    title,
    content: finalParagraphs.join("\n\n"),
    chunks: outcomes,
    totalCalls,
    totalMs: Date.now() - overallStart,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SELECTIVE SEGMENT-LEVEL ARCHITECTURE
//
// The paragraph-chunk approach above works but is too expensive to run on every
// article (~200s of Qwen time for Cerebras) and polishes many segments that were
// already fine. This section identifies the FEW individual MADLAD segments worth
// polishing — the ones MADLAD itself already flagged as repaired/fallback, or the
// ones whose validated Bulgarian still contains untranslated English prose — and
// polishes ONLY those, each independently verified before being trusted.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── English-prose detector (conservative — discounts identifiers/entities) ────

/**
 * Common English function words. A genuine leftover ENGLISH SENTENCE always
 * contains at least one of these ("By the numbers, we are once again looking at…"
 * — "by", "we", "are", "at"), while a scattered technical Latin token never does:
 * no identifier, acronym, or brand name IS a function word. This is the same
 * stopword-ratio signal already validated earlier in this investigation (the
 * sifted.eu source-corruption analysis) for telling genuine English prose apart
 * from isolated Latin fragments — reused here for the mirror-image problem.
 */
const ENGLISH_STOPWORDS = new Set([
  "the",
  "and",
  "of",
  "to",
  "in",
  "is",
  "that",
  "for",
  "on",
  "with",
  "as",
  "at",
  "by",
  "from",
  "this",
  "are",
  "was",
  "were",
  "has",
  "have",
  "will",
  "which",
  "their",
  "its",
  "it",
  "be",
  "not",
  "but",
  "or",
  "an",
  "a",
  "we",
  "you",
  "if",
  "than",
  "into",
  "can",
  "also",
  "about",
  "more",
  "such",
  "each",
  "these",
  "those",
]);

export interface ProseCheck {
  suspicious: boolean;
  foundStopwords: string[];
}

/**
 * Whether the FINAL VALIDATED Bulgarian segment still contains a genuine
 * untranslated English sentence — conservative by construction: every value
 * `protectTokens` would freeze and every {@link watchedEntities} match is stripped
 * out FIRST, so "WSE-3", "44GB", "NVIDIA", "TSMC", "PCIe", "NVMe" and the like can
 * never trigger this on their own, however many appear together. Only a genuine
 * English function word surviving that strip counts as evidence.
 */
export function checkUntranslatedEnglish(englishSegment: string, bgSegment: string): ProseCheck {
  let stripped = bgSegment;
  for (const v of requiredIdentifiers(englishSegment)) {
    stripped = stripped.split(v.value).join(" ");
  }
  for (const e of watchedEntities(englishSegment)) {
    stripped = stripped.split(e).join(" ");
  }
  const words = stripped.match(/[A-Za-z']+/g) ?? [];
  const found = [
    ...new Set(words.map((w) => w.toLowerCase()).filter((w) => ENGLISH_STOPWORDS.has(w))),
  ];
  return { suspicious: found.length > 0, foundStopwords: found };
}

// ─── Numeric and currency guards ────────────────────────────────────────────────

/**
 * Normalises one numeric token so ordinary Bulgarian formatting cannot look like a
 * changed value. Bulgarian groups thousands with either a comma OR A SPACE
 * ("900,000" and "900 000" both occur), and writes decimals with a comma instead of
 * a period ("43,2" for 43.2). Splitting on comma-or-space and inspecting the LAST
 * group resolves the ambiguity: a final group of exactly 1-2 digits is a decimal
 * fraction (join the rest, add "."); any other shape is pure thousands-grouping
 * (join every group with nothing between). Both English and Bulgarian numbers are
 * run through this before comparison, so "900,000" and "900 000", or "43.2" and
 * "43,2", compare equal.
 */
function normaliseNumber(raw: string): string {
  const groups = raw.trim().split(/[,\s]+/);
  if (groups.length === 1) return groups[0];
  const last = groups[groups.length - 1];
  if (last.length <= 2) return groups.slice(0, -1).join("") + "." + last;
  return groups.join("");
}

/**
 * Numbers worth enforcing byte-for-byte: 10 or greater, or carrying a decimal point.
 * Deliberately EXEMPT single digits (0-9): measured against the real Cerebras
 * output, MADLAD itself renders small counts as Bulgarian WORDS, not digits —
 * "three iterations" → "три итерации" — and requiring a literal "3" there would
 * reject a perfectly correct translation on a false positive the task explicitly
 * warned against. Every real regression this guards against (44GB, 2.6 trillion,
 * 42.2, 300GB/sec, 900,000) is two-or-more digits or has a decimal point.
 *
 * The token itself matches digit groups separated by a comma OR space (thousands)
 * with an optional trailing comma/period decimal — "900,000", "900 000", "43.2",
 * "43,2" all match as ONE token, never as fragments.
 */
function significantNumbers(text: string): Set<string> {
  const found = new Set<string>();
  for (const m of text.matchAll(/\d{1,3}(?:[,\s]\d{3})*(?:[.,]\d+)?|\d+(?:[.,]\d+)?/g)) {
    const normalised = normaliseNumber(m[0]);
    const bare = normalised.replace(".", "");
    if (bare.length >= 2 || normalised.includes(".")) found.add(normalised);
  }
  return found;
}

/** Bulgarian currency words. None of these may appear unless the ENGLISH did. */
const CURRENCY_WORDS = ["долар", "долара", "долари", "евро", "лев", "лева", "паунд", "паунда"];
const ENGLISH_CURRENCY_CUE = /\$|dollar|euro|€|pound|£|\blev(a|s)?\b/i;

export interface NumericCheck {
  ok: boolean;
  missingNumbers: string[];
  inventedNumbers: string[];
  inventedCurrency: boolean;
}

/**
 * The check calibrated directly against the real regression: a large fragment
 * describing "2.6 trillion transistors" polished into text carrying an invented
 * "долара" (dollars) — the number survived, only the currency was fabricated, so a
 * pure number-preservation check would have missed it. Two independent checks:
 * every significant number in the English segment must survive (missing = a
 * dropped or altered value, e.g. 42.2 → 43.2 shows up as BOTH missing 42.2 and
 * invented 43.2), and no Bulgarian currency word may appear unless the English
 * segment itself mentioned money.
 */
export function verifyNumbers(englishSegment: string, polishedBg: string): NumericCheck {
  const required = significantNumbers(englishSegment);
  const present = significantNumbers(polishedBg);
  const missingNumbers = [...required].filter((n) => !present.has(n));
  const inventedNumbers = [...present].filter((n) => !required.has(n));
  const inventedCurrency =
    !ENGLISH_CURRENCY_CUE.test(englishSegment) &&
    CURRENCY_WORDS.some((w) => polishedBg.toLowerCase().includes(w));
  return {
    ok: missingNumbers.length === 0 && inventedNumbers.length === 0 && !inventedCurrency,
    missingNumbers,
    inventedNumbers,
    inventedCurrency,
  };
}

// ─── Content-collapse guard ─────────────────────────────────────────────────────

/**
 * Char/word ratio floor, calibrated against BOTH real outcomes from the prior
 * chunk-level experiment rather than picked blind:
 *   - the good, accepted P1-9 edit: 1560 → 1564 chars, ratio ≈ 1.003
 *   - the real SRAM collapse (P10-12): a table-row fragment collapsed to the single
 *     word "SRAM", ratio ≈ 0.03-0.09 depending on which fragment is measured
 * 0.5 sits far below every genuine edit measured and far above the collapse,
 * leaving room for legitimate tightening (Bulgarian dropping redundant words) while
 * catching wholesale content replacement.
 */
export const MIN_RETENTION_RATIO = 0.5;

export interface RetentionCheck {
  ok: boolean;
  charRatio: number;
  wordRatio: number;
}

export function verifyRetention(madladBg: string, polishedBg: string): RetentionCheck {
  const charRatio = madladBg.length === 0 ? 1 : polishedBg.length / madladBg.length;
  const madladWords = (madladBg.match(/\S+/g) ?? []).length;
  const polishedWords = (polishedBg.match(/\S+/g) ?? []).length;
  const wordRatio = madladWords === 0 ? 1 : polishedWords / madladWords;
  return {
    ok: charRatio >= MIN_RETENTION_RATIO && wordRatio >= MIN_RETENTION_RATIO,
    charRatio,
    wordRatio,
  };
}

// ─── Combined segment verification ──────────────────────────────────────────────

export interface SegmentVerification {
  ok: boolean;
  identifiers: ChunkVerification;
  numbers: NumericCheck;
  retention: RetentionCheck;
  reason: string | null;
}

export function verifySegmentPolish(
  englishSegment: string,
  madladBg: string,
  polishedBg: string
): SegmentVerification {
  const identifiers = verifyPolishedChunk(englishSegment, polishedBg);
  const numbers = verifyNumbers(englishSegment, polishedBg);
  const retention = verifyRetention(madladBg, polishedBg);
  const ok = identifiers.ok && numbers.ok && retention.ok;

  const reasons: string[] = [];
  if (identifiers.lostIdentifiers.length > 0)
    reasons.push(`lost identifiers: ${identifiers.lostIdentifiers.join(", ")}`);
  if (identifiers.lostEntities.length > 0)
    reasons.push(`lost entities: ${identifiers.lostEntities.join(", ")}`);
  if (!identifiers.isBulgarian) reasons.push("not Bulgarian");
  if (identifiers.isDegenerate) reasons.push("degenerate repetition");
  if (numbers.missingNumbers.length > 0)
    reasons.push(`missing numbers: ${numbers.missingNumbers.join(", ")}`);
  if (numbers.inventedNumbers.length > 0)
    reasons.push(`invented numbers: ${numbers.inventedNumbers.join(", ")}`);
  if (numbers.inventedCurrency) reasons.push("invented currency");
  if (!retention.ok)
    reasons.push(
      `content collapse (char ratio ${retention.charRatio.toFixed(2)}, word ratio ${retention.wordRatio.toFixed(2)})`
    );

  return { ok, identifiers, numbers, retention, reason: ok ? null : reasons.join("; ") };
}

// ─── Segment selection ───────────────────────────────────────────────────────

export type SelectionReason = "madlad_repaired" | "madlad_fallback" | "untranslated_english";

export interface ReconstructedSegment {
  index: number; // 0-based, article order
  en: string;
  bg: string; // the FINAL VALIDATED MADLAD segment — never sent to Qwen unverified
  provenance: "native" | "repaired" | "fallback" | "bypassed";
}

/**
 * Least alphabetic content (English source, minus every identifier/entity) worth
 * spending a polish call on. "WSE-3 Turbo" is two words but ALL of it is either a
 * protected identifier or a watched entity — stripping both leaves nothing, so it
 * is excluded as a short identifier-only fragment per the task's own instruction,
 * independent of whether it happens to be `isDataOnlySegment` (that predicate only
 * catches segments with NO prose at all around the identifier; this catches "prose"
 * that is itself just brand words).
 */
const MIN_MEANINGFUL_PROSE_CHARS = 15;

function isShortIdentifierFragment(englishSegment: string): boolean {
  let stripped = englishSegment;
  for (const v of requiredIdentifiers(englishSegment)) stripped = stripped.split(v.value).join(" ");
  for (const e of watchedEntities(englishSegment)) stripped = stripped.split(e).join(" ");
  return stripped.replace(/[^A-Za-z]/g, "").length < MIN_MEANINGFUL_PROSE_CHARS;
}

export interface SelectedSegment {
  segment: ReconstructedSegment;
  reasons: SelectionReason[];
}

/**
 * Selects the FEW segments worth polishing, per the task's two criteria: (A)
 * segments MADLAD's own repair mechanism already had to intervene on (it already
 * told us something was wrong), or (B) a segment whose final validated Bulgarian
 * still reads as untranslated English prose. Never selects a bypassed data-only
 * segment (a table cell — nothing to polish, see `isDataOnlySegment`) or a short
 * identifier-only fragment (nothing but brand words — no prose to improve).
 */
export function selectSuspiciousSegments(
  segments: readonly ReconstructedSegment[]
): SelectedSegment[] {
  const selected: SelectedSegment[] = [];
  for (const seg of segments) {
    if (seg.provenance === "bypassed") continue;
    if (isShortIdentifierFragment(seg.en)) continue;

    const reasons: SelectionReason[] = [];
    if (seg.provenance === "repaired") reasons.push("madlad_repaired");
    if (seg.provenance === "fallback") reasons.push("madlad_fallback");
    // A fallback segment IS the English source by construction — the prose check
    // would trivially fire on every one, so it adds no new information there.
    if (seg.provenance !== "fallback" && checkUntranslatedEnglish(seg.en, seg.bg).suspicious) {
      reasons.push("untranslated_english");
    }
    if (reasons.length > 0) selected.push({ segment: seg, reasons });
  }
  return selected;
}

// ─── Single-segment polish prompt + call ────────────────────────────────────────

export function buildSegmentPolishPrompt(
  englishSegment: string,
  madladBg: string,
  protectedIdentifiers: readonly string[],
  entities: readonly string[]
): { systemPrompt: string; userPrompt: string; format: unknown } {
  return buildContentPolishPrompt(englishSegment, madladBg, protectedIdentifiers, entities);
}

export interface SegmentPolishOutcome {
  index: number;
  selectionReasons: SelectionReason[];
  used: "polished" | "madlad";
  verification: SegmentVerification | null; // null only when the reply was unparseable
  callMs: number;
  en: string;
  madladBg: string;
  polishedBg: string | null;
}

async function polishOneSegment(
  worker: TextWorkerProvider,
  selected: SelectedSegment
): Promise<SegmentPolishOutcome> {
  const { segment } = selected;
  const ids = requiredIdentifiers(segment.en).map((v) => v.value);
  const ents = watchedEntities(segment.en);
  const prompt = buildSegmentPolishPrompt(segment.en, segment.bg, ids, ents);
  const { text, ms } = await callQwen(
    worker,
    prompt.systemPrompt,
    prompt.userPrompt,
    prompt.format
  );
  const polished = parsePolishReply(text, "content");

  if (polished === null) {
    return {
      index: segment.index,
      selectionReasons: selected.reasons,
      used: "madlad",
      verification: null,
      callMs: ms,
      en: segment.en,
      madladBg: segment.bg,
      polishedBg: null,
    };
  }

  const verification = verifySegmentPolish(segment.en, segment.bg, polished);
  return {
    index: segment.index,
    selectionReasons: selected.reasons,
    used: verification.ok ? "polished" : "madlad",
    verification,
    callMs: ms,
    en: segment.en,
    madladBg: segment.bg,
    polishedBg: polished,
  };
}

export interface SelectivePolishResult {
  totalSegments: number;
  selected: SelectedSegment[];
  outcomes: SegmentPolishOutcome[];
  finalTitle: string | null;
  finalContent: string | null;
  totalMs: number;
}

/** Runs selective polishing over an already-reconstructed, fully validated article. */
export async function polishSelectively(
  worker: TextWorkerProvider,
  segments: readonly ReconstructedSegment[],
  plan: Parameters<typeof reassembleArticle>[0]
): Promise<SelectivePolishResult> {
  const started = Date.now();
  const selected = selectSuspiciousSegments(segments);

  const outcomes: SegmentPolishOutcome[] = [];
  for (const s of selected) {
    outcomes.push(await polishOneSegment(worker, s));
  }

  const finalTexts = segments.map((s) => s.bg);
  for (const o of outcomes) {
    if (o.used === "polished" && o.polishedBg !== null) finalTexts[o.index] = o.polishedBg;
  }
  const reassembled = reassembleArticle(plan, finalTexts);

  return {
    totalSegments: segments.length,
    selected,
    outcomes,
    finalTitle: reassembled.translatedTitle,
    finalContent: reassembled.translatedContent,
    totalMs: Date.now() - started,
  };
}

// ─── Reconstructing MADLAD's own segment-level result, for introspection ──────
//
// `MadladTranslationProvider.translate()` only returns the REASSEMBLED article, not
// the per-segment array — by design, nothing downstream needs it. Getting individual
// segments to select and polish requires that array, so this mirrors the provider's
// own restore-then-repair algorithm using the SAME exported pure functions
// (`segmentArticle`, `protectTokens`, `restoreTokens`, `isDataOnlySegment`,
// `unpreservedValues`, `maxRepairsFor`) and the SAME repair engine class
// (`OllamaTranslationProvider`) it uses internally. This is NOT a second
// implementation of MADLAD's logic — it is the identical algorithm, re-run here
// only because production intentionally does not expose this level of detail.
// Simplification versus production, stated explicitly: this never aborts the whole
// article when the repair cap is exceeded — every over-cap segment is simply
// recorded as a fallback, so the experiment can still run end-to-end on an article
// that would fail in production. That is a deliberate loosening for EXPERIMENT
// purposes only and must not be read as a proposed change to the real cap behaviour.

async function translateBatch(
  workerUrl: string,
  apiKey: string,
  texts: string[]
): Promise<string[]> {
  const res = await fetch(`${workerUrl.replace(/\/+$/, "")}/translate`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-worker-api-key": apiKey },
    body: JSON.stringify({ texts, sourceLanguage: "en", targetLanguage: "bg" }),
  });
  const data = (await res.json()) as { texts?: string[] };
  if (!Array.isArray(data.texts)) throw new Error("MADLAD worker did not return texts[]");
  return data.texts;
}

export interface MadladReconstruction {
  segments: ReconstructedSegment[];
  plan: ReturnType<typeof segmentArticle>["plan"];
  translatedTitle: string | null;
  translatedContent: string | null;
}

export async function reconstructMadladArticle(
  workerUrl: string,
  apiKey: string,
  repairEngine: OllamaTranslationProvider,
  title: string | null,
  content: string | null,
  mode: "full" | "title_only"
): Promise<MadladReconstruction> {
  const { segments: sourceSegments, plan } = segmentArticle(title, content, { mode });
  const protectedSegments: ProtectedText[] = sourceSegments.map((s) => protectTokens(s));
  const dataOnly = protectedSegments.map((p) => isDataOnlySegment(p));
  const sendIndices = sourceSegments.map((_, i) => i).filter((i) => !dataOnly[i]);

  const sentTexts: string[] = [];
  for (let i = 0; i < sendIndices.length; i += 30) {
    const batchIndices = sendIndices.slice(i, i + 30);
    sentTexts.push(
      ...(await translateBatch(
        workerUrl,
        apiKey,
        batchIndices.map((idx) => protectedSegments[idx].text)
      ))
    );
  }
  const translations: string[] = sourceSegments.slice();
  sendIndices.forEach((idx, pos) => (translations[idx] = sentTexts[pos]));

  const limit = maxRepairsFor(sourceSegments.length);
  let repairsUsed = 0;
  const result: ReconstructedSegment[] = [];

  for (let i = 0; i < sourceSegments.length; i += 1) {
    if (dataOnly[i]) {
      result.push({
        index: i,
        en: sourceSegments[i],
        bg: sourceSegments[i],
        provenance: "bypassed",
      });
      continue;
    }
    try {
      const restored = restoreTokens(
        translations[i],
        protectedSegments[i].values,
        `segment ${i + 1}/${sourceSegments.length}`
      );
      result.push({ index: i, en: sourceSegments[i], bg: restored, provenance: "native" });
      continue;
    } catch (err) {
      const repairable =
        err instanceof TranslationParseError &&
        err.reason === "protected_token" &&
        protectedSegments[i].values.length > 0;
      if (!repairable) throw err;
    }

    // Deliberate experiment-only simplification — see the section comment above.
    if (repairsUsed >= limit) {
      result.push({
        index: i,
        en: sourceSegments[i],
        bg: sourceSegments[i],
        provenance: "fallback",
      });
      continue;
    }
    repairsUsed += 1;

    const prompts = buildTranslationPrompts(sourceSegments[i], null, "bg");
    let repairedText: string | null = null;
    try {
      const r = await repairEngine.translate(
        {
          feedItemId: "reconstruct",
          url: "https://example.com",
          title: sourceSegments[i],
          content: null,
          targetLang: "bg",
          mode: prompts.mode,
          prompts,
        },
        {
          tracer: GenerationTracer.disabled(),
          now: () => new Date(),
          diag: {},
          attemptTimeoutMs: 30_000,
          itemDeadlineMs: Date.now() + 30_000,
          itemTimeoutMs: 30_000,
        }
      );
      repairedText = r.translatedTitle;
    } catch {
      repairedText = null;
    }

    const lost =
      repairedText === null
        ? protectedSegments[i].values.map((v) => v.value)
        : unpreservedValues(protectedSegments[i].values, repairedText);
    if (repairedText !== null && lost.length === 0) {
      result.push({
        index: i,
        en: sourceSegments[i],
        bg: repairedText.trim(),
        provenance: "repaired",
      });
    } else {
      result.push({
        index: i,
        en: sourceSegments[i],
        bg: sourceSegments[i],
        provenance: "fallback",
      });
    }
  }

  const reassembled = reassembleArticle(
    plan,
    result.map((r) => r.bg)
  );
  return {
    segments: result,
    plan,
    translatedTitle: reassembled.translatedTitle,
    translatedContent: reassembled.translatedContent,
  };
}

// ─── CLI entry point — DB-free except one read, never writes ───────────────────

async function main() {
  const idFlagIndex = process.argv.indexOf("--id");
  const id = idFlagIndex >= 0 ? process.argv[idFlagIndex + 1] : null;
  if (!id) {
    console.error("Usage: npx tsx scripts/experiment-translation-polish.ts --id <feedItemId>");
    process.exit(1);
  }

  const item = await prisma.feedItem.findUniqueOrThrow({
    where: { id },
    select: { id: true, title: true, content: true, url: true },
  });

  const workerUrl = process.env.TEXT_WORKER_URL!;
  const apiKey = process.env.TEXT_WORKER_API_KEY!;
  const repairEngine = new OllamaTranslationProvider(
    new TextWorkerProvider(workerUrl, apiKey, "qwen3:8b"),
    "TEXT_WORKER",
    "qwen3:8b"
  );

  const prompts = buildTranslationPrompts(item.title, item.content, "bg");

  console.log(
    `[1/3] Reconstructing MADLAD's validated per-segment article (bypass + repair, mirroring production).`
  );
  const madlad = await reconstructMadladArticle(
    workerUrl,
    apiKey,
    repairEngine,
    item.title,
    item.content,
    prompts.mode
  );
  const provenanceCounts = madlad.segments.reduce<Record<string, number>>((acc, s) => {
    acc[s.provenance] = (acc[s.provenance] ?? 0) + 1;
    return acc;
  }, {});
  console.log("  segments:", madlad.segments.length, JSON.stringify(provenanceCounts));

  console.log(
    `[2/3] Selecting suspicious segments (madlad_repaired / madlad_fallback / untranslated_english).`
  );
  const worker = new TextWorkerProvider(workerUrl, apiKey, "qwen3:8b");
  const started = Date.now();
  const result = await polishSelectively(worker, madlad.segments, madlad.plan);
  const totalMs = Date.now() - started;

  console.log(`[3/3] Done.\n`);
  console.log("================ SUMMARY ================");
  console.log("total segments      :", result.totalSegments);
  console.log("selected segments   :", result.selected.length);
  console.log("Qwen calls          :", result.outcomes.length);
  console.log("total Qwen ms       :", totalMs);
  const callTimes = result.outcomes.map((o) => o.callMs).sort((a, b) => a - b);
  if (callTimes.length > 0) {
    console.log(
      "  min/median/max ms  :",
      callTimes[0],
      callTimes[Math.floor(callTimes.length / 2)],
      callTimes[callTimes.length - 1]
    );
  }
  console.log("accepted (polished) :", result.outcomes.filter((o) => o.used === "polished").length);
  console.log("rejected (kept madlad):", result.outcomes.filter((o) => o.used === "madlad").length);

  console.log("\n=== per-segment detail ===");
  for (const o of result.outcomes) {
    console.log(`\n[seg ${o.index + 1}] reasons=${o.selectionReasons.join(",")} -> ${o.used}`);
    console.log(`  EN      : ${o.en.slice(0, 200)}`);
    console.log(`  MADLAD  : ${o.madladBg.slice(0, 200)}`);
    console.log(`  QWEN    : ${(o.polishedBg ?? "(unparseable)").slice(0, 200)}`);
    if (o.verification)
      console.log(`  verify  : ${o.verification.ok ? "OK" : o.verification.reason}`);
  }

  console.log("\nmadlad content chars :", madlad.translatedContent?.length);
  console.log("final content chars  :", result.finalContent?.length);
  console.log("\nfinal title          :", result.finalTitle);

  console.log("\nNO DB WRITE PERFORMED.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
