import {
  segmentArticle,
  reassembleArticle,
  NO_CONTENT_CAP,
  type SegmentPlan,
} from "./madlad-segmentation";
import { protectTokens } from "./protected-tokens";
import { sanitiseTranslationContent } from "@/lib/ai/feed-item-translation";

/**
 * Cutting a large article into pieces the PROMPT-BASED engine can translate one JSON
 * call at a time, and putting the translated pieces back together afterwards.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * `buildTranslationPrompts` sends the whole body in ONE call and caps it at
 * {@link MAX_TRANSLATION_CONTENT_CHARS} (3000) so that call finishes inside the
 * worker's latency budget — see that constant's own comment. Capping is honest about
 * what the single-call path can do, but its EFFECT on an article longer than that is
 * silent data loss: everything past the cap is simply never sent. `OllamaTranslationProvider`
 * uses the single-call path unchanged for anything that already fits under the cap, and
 * routes anything larger through the chunker in this file instead — same worker, same
 * per-call size the cap already proved safe, just several calls instead of one truncated one.
 *
 * ── Reuse, not a second splitter ─────────────────────────────────────────────
 * The actual "never cut mid-sentence, never cut mid-word" logic already exists and is
 * already tested: {@link segmentArticle} in madlad-segmentation.ts splits an article into
 * SENTENCE-sized pieces (paragraph-and-line-aware, list markers preserved, abbreviations
 * and initials excluded from the sentence boundary) for MADLAD's per-sentence NMT calls.
 * This module does not reimplement any of that. It calls `segmentArticle` with
 * {@link NO_CONTENT_CAP} to get the same fine-grained, boundary-safe pieces, then GROUPS
 * consecutive pieces into larger chunks sized for a chat model's JSON call instead of an
 * NMT model's single sentence — a packing problem layered on top of an already-solved
 * splitting problem. Because every chunk boundary falls exactly on a boundary
 * `segmentArticle` already chose, a chunk can never start or end mid-sentence or mid-word.
 *
 * `reassembleArticle` is reused too, at BUILD time rather than restore time: folding a
 * slice of body pieces back into one string using their own original separators is
 * exactly the source-side text this module needs to hand the model for one chunk, so
 * that fold is reused as-is rather than re-derived.
 *
 * ── Protected-token awareness, not just character count ─────────────────────────
 * A chunk under the character ceiling can still fail: a spec-dense hardware review
 * packs far more `[[n]]` placeholders (see protected-tokens.ts) per character than
 * ordinary prose, and restoration is a CONJUNCTIVE gate — every placeholder sent has to
 * come back exactly once, so the chance of a clean reply falls geometrically with the
 * count. Measured against the running worker: chunks carrying ~12-13 placeholders
 * translated cleanly; a ~2,681-char article carrying 24-30 (short enough to look like an
 * ordinary single-call body, under the OLD char-only routing) failed on `protected_token`
 * on every retry. So the packer below enforces BOTH ceilings on every chunk it produces —
 * a chunk is flushed as soon as adding the next piece would exceed EITHER one — and
 * `shouldChunkForTranslation` routes an article to this module in the first place on
 * EITHER condition, not just size.
 */

/**
 * Hard ceiling on one chunk's character count. Matches the single-call path's own
 * {@link MAX_TRANSLATION_CONTENT_CHARS} budget deliberately: that number is not
 * arbitrary — it is the largest body already measured to translate reliably inside the
 * worker's request-timeout and output-token budget (see that constant's comment), so a
 * chunk built to the same ceiling inherits the same margin rather than needing new
 * measurement of its own.
 */
export const OLLAMA_CHUNK_MAX_CHARS = 3000;

/**
 * Once a chunk has grown to at least this size, a paragraph boundary is taken as the
 * cut point rather than packing more sentences from the next paragraph in — "roughly
 * 2500–3000 characters, split on natural boundaries, paragraph first." Below this size
 * the packer keeps accumulating across paragraph breaks, which is what stops a run of
 * short paragraphs from becoming a run of needlessly small chunks.
 */
export const OLLAMA_CHUNK_TARGET_MIN_CHARS = 2500;

/**
 * Hard ceiling on protected-token (`[[n]]`) placeholders in one final chunk.
 *
 * Measured live against the running worker on real TechPowerUp-style hardware reviews:
 * chunks carrying ~12-13 placeholders translated cleanly; chunks carrying ~24-30 — an
 * entire spec-dense article sent as one unchunked call, because it was short enough to
 * stay under the OLD char-only routing threshold — repeatedly came back with a dropped,
 * duplicated, or invented placeholder and failed with `protected_token` on every retry
 * (see restoreTokens in protected-tokens.ts: restoration is a conjunctive gate, so the
 * chance of a clean reply falls geometrically with the count). 10 sits below the
 * smallest count ever observed to succeed, leaving margin rather than sitting on the
 * edge of what has merely been seen to work so far.
 */
export const OLLAMA_CHUNK_MAX_PROTECTED_TOKENS = 10;

/**
 * Why a chunk ended where it did — diagnostics only, logged alongside its size and
 * protected-token count so an operator can tell a size-bound split from a token-bound
 * one at a glance:
 *   • "size"             — the character ceiling (or the preferred-paragraph-boundary
 *                           policy, itself a size heuristic) ended the chunk;
 *   • "protected_tokens" — the placeholder ceiling ended it, at a paragraph/sentence
 *                           boundary or, in the rare case a single sentence alone
 *                           carried too many placeholders, at a word boundary within it
 *                           (see splitTextByProtectedTokenBudget);
 *   • "both"             — the next piece would have exceeded BOTH ceilings at once;
 *   • "end"              — nothing forced this split; it is simply the end of the
 *                           article (or the whole article fit in one chunk).
 */
export type ChunkSplitReason = "size" | "protected_tokens" | "both" | "end";

/** One chunk of article body, ready to hand a translation call. */
export interface ArticleChunk {
  /** The exact source text to translate — already folded from its body pieces. */
  text: string;
  /**
   * The literal separator that belongs between the PREVIOUS chunk and this one in the
   * reassembled article — `""` for the first chunk. Carried separately from `text`
   * because it is article-level structure, not part of what gets translated.
   */
  leadingSeparator: string;
  /**
   * How many sentence-level pieces this chunk folds together — diagnostics only. `0`
   * when this chunk is a WORD-LEVEL FRAGMENT of a single piece that alone exceeded the
   * protected-token budget (see splitTextByProtectedTokenBudget) — a fragment is not a
   * whole piece, so it cannot honestly claim to be one.
   */
  pieceCount: number;
  /**
   * Protected-token placeholders THIS chunk's own text carries — always
   * `<= maxProtectedTokens`, the hard invariant this module guarantees. Diagnostics,
   * and the concrete proof that the invariant held for a given chunk.
   */
  protectedTokenCount: number;
  /** Why this chunk ended where it did — diagnostics only. */
  splitReason: ChunkSplitReason;
}

export interface ChunkedArticle {
  /** Trimmed article title, or null when the article has none. Never chunked — always small. */
  title: string | null;
  /** Body chunks, in article order. */
  chunks: ArticleChunk[];
  /** Sanitised body characters found before chunking — the TRUE original size, uncapped. */
  contentChars: number;
}

export interface ChunkArticleOptions {
  /** Hard per-chunk ceiling. Defaults to {@link OLLAMA_CHUNK_MAX_CHARS}. */
  maxChunkChars?: number;
  /** Preferred minimum before a paragraph boundary is taken. Defaults to {@link OLLAMA_CHUNK_TARGET_MIN_CHARS}. */
  targetMinChars?: number;
  /** Hard per-chunk ceiling on protected-token placeholders. Defaults to {@link OLLAMA_CHUNK_MAX_PROTECTED_TOKENS}. */
  maxProtectedTokens?: number;
}

/** One text fragment plus the protected-token count `protectTokens` measured for it. */
interface TextPiece {
  text: string;
  protectedTokenCount: number;
}

/**
 * Splits a single piece of text that alone carries more protected-token placeholders
 * than one chunk may hold, at WORD boundaries only, so a placeholder — always one
 * whitespace-delimited token, by construction of `protectTokens` — can never be cut in
 * half.
 *
 * This is the LAST-RESORT fallback beneath `chunkArticleForTranslation`'s own packer,
 * which already splits at paragraph and sentence boundaries first (see that function's
 * comment): it only ever runs on a SINGLE sentence-level piece that alone already
 * exceeds `maxProtectedTokens`, which ordinary prose essentially never does — a
 * flattened spec line ("SPEC0001 SPEC0002 SPEC0003 …") with no sentence punctuation is
 * the realistic case. Greedy and linear, mirroring the outer packer's own technique one
 * level down: a word is added to the fragment in progress unless doing so would exceed
 * the budget, in which case the fragment is flushed first.
 *
 * Returns the input as a single, unsplit piece when it is already within budget — the
 * common case — so callers can invoke this unconditionally without a separate check.
 */
function splitTextByProtectedTokenBudget(text: string, maxProtectedTokens: number): TextPiece[] {
  const whole = protectTokens(text).values.length;
  if (whole <= maxProtectedTokens) return [{ text, protectedTokenCount: whole }];

  // Alternating word / separator / word / separator / … — odd indices are the literal
  // whitespace runs between words, preserved so a rejoin needs no reconstruction.
  const words = text.split(/(\s+)/u);
  const out: TextPiece[] = [];
  let current = "";
  let currentCount = 0;

  const flushCurrent = (): void => {
    const trimmed = current.trim();
    if (trimmed.length > 0) out.push({ text: trimmed, protectedTokenCount: currentCount });
    current = "";
    currentCount = 0;
  };

  for (let i = 0; i < words.length; i += 2) {
    const word = words[i];
    if (word.length === 0) continue;
    const sep = words[i + 1] ?? "";
    const wordCount = protectTokens(word).values.length;
    if (current.length > 0 && currentCount + wordCount > maxProtectedTokens) {
      flushCurrent();
    }
    current += word + sep;
    currentCount += wordCount;
  }
  flushCurrent();

  // Defence in depth: a single word alone over budget (never observed — a word is at
  // most one placeholder) would otherwise vanish entirely rather than being lost loudly.
  return out.length > 0 ? out : [{ text, protectedTokenCount: whole }];
}

/**
 * Splits an article into title + ordered body chunks, ready for the chunked
 * translation path.
 *
 * Packing is a single greedy pass over `segmentArticle`'s sentence pieces: a piece is
 * always added to the chunk in progress UNLESS doing so would exceed `maxChunkChars`
 * (in which case the chunk in progress is flushed first) OR the chunk in progress has
 * already reached `targetMinChars` AND the piece about to be added starts a new
 * paragraph (in which case it is flushed too, preferring the natural break over
 * packing tighter). A single piece can never itself exceed `maxChunkChars` — MADLAD's
 * own per-sentence ceiling ({@link MAX_SEGMENT_CHARS}, 700) sits far below it — so the
 * "would exceed" flush always has something already banked to flush, and progress is
 * guaranteed on every iteration.
 */
export function chunkArticleForTranslation(
  title: string | null,
  content: string | null,
  options: ChunkArticleOptions = {}
): ChunkedArticle {
  const maxChunkChars = options.maxChunkChars ?? OLLAMA_CHUNK_MAX_CHARS;
  const targetMinChars = options.targetMinChars ?? OLLAMA_CHUNK_TARGET_MIN_CHARS;
  const maxProtectedTokens = options.maxProtectedTokens ?? OLLAMA_CHUNK_MAX_PROTECTED_TOKENS;

  const { segments, plan, contentChars } = segmentArticle(title, content, {
    mode: "full",
    maxContentChars: NO_CONTENT_CAP,
  });

  const cleanTitle = plan.titleIndex === null ? null : (segments[plan.titleIndex] ?? null);

  const chunks: ArticleChunk[] = [];
  let start = 0;
  let currentLen = 0;
  let currentProtectedCount = 0;

  const flush = (endExclusive: number, reason: ChunkSplitReason): void => {
    if (endExclusive <= start) return;
    const slice = plan.body.slice(start, endExclusive);
    const subPlan: SegmentPlan = { titleIndex: null, body: slice };
    // Reused, not reimplemented: the same fold `reassembleArticle` uses to restore a
    // translated article restores a SOURCE one just as well, given the source text as
    // the "translations" array — the fold neither knows nor cares which it is.
    const { translatedContent } = reassembleArticle(subPlan, segments);
    const text = translatedContent ?? "";

    // The packer's own flush conditions below already keep a MULTI-piece slice within
    // budget; this only ever has real work to do when the slice is a SINGLE piece that
    // alone exceeds maxProtectedTokens (there was nothing smaller to flush earlier at).
    // It is the hard invariant's proof, not merely its common case: every produced
    // chunk satisfies both ceilings, unconditionally, not just on ordinary prose.
    const pieces = splitTextByProtectedTokenBudget(text, maxProtectedTokens);
    const wasSplitFurther = pieces.length > 1;
    pieces.forEach((piece, i) => {
      chunks.push({
        text: piece.text,
        leadingSeparator: i === 0 ? slice[0].separator : " ",
        pieceCount: i === 0 ? slice.length : 0,
        protectedTokenCount: piece.protectedTokenCount,
        // A further word-level split is ALWAYS protected-token pressure — that is the
        // only reason splitTextByProtectedTokenBudget ever divides its input.
        splitReason: wasSplitFurther ? "protected_tokens" : reason,
      });
    });

    start = endExclusive;
    currentLen = 0;
    currentProtectedCount = 0;
  };

  for (let i = 0; i < plan.body.length; i += 1) {
    const piece = plan.body[i];
    const pieceText = piece.prefix + segments[piece.index];
    const pieceProtectedCount = protectTokens(pieceText).values.length;
    const isParagraphBreak = piece.separator.includes("\n\n");

    if (currentLen > 0) {
      const wouldBeLen = currentLen + piece.separator.length + pieceText.length;
      const wouldBeProtected = currentProtectedCount + pieceProtectedCount;
      const overSize = wouldBeLen > maxChunkChars;
      const overProtected = wouldBeProtected > maxProtectedTokens;

      if (isParagraphBreak && currentLen >= targetMinChars) {
        // The preferred natural break — a size heuristic — wins even when neither
        // ceiling was actually about to be exceeded; noted as "both" only when
        // protected-token pressure was ALSO real, for honest diagnostics.
        flush(i, overProtected ? "both" : "size");
      } else if (overSize || overProtected) {
        flush(i, overSize && overProtected ? "both" : overSize ? "size" : "protected_tokens");
      }
    }

    currentLen += (currentLen === 0 ? 0 : piece.separator.length) + pieceText.length;
    currentProtectedCount += pieceProtectedCount;
  }
  flush(plan.body.length, "end");

  return { title: cleanTitle, chunks, contentChars };
}

/**
 * Whether an article's body should be routed to the chunked translation path — decided
 * BEFORE any chunking happens, using the SAME two ceilings the packer above enforces per
 * chunk, applied once to the whole sanitised body (exactly what an unchunked single call
 * would otherwise send as ONE request).
 *
 * Two independent triggers:
 *   • the body alone exceeds the per-call character ceiling (the original reason this
 *     module exists), or
 *   • the body carries more protected-token placeholders than one call has been measured
 *     to round-trip reliably, however short it is in characters — see
 *     {@link OLLAMA_CHUNK_MAX_PROTECTED_TOKENS} for the measurement behind the number. A
 *     ~2,681-char hardware review carrying 24-30 placeholders is exactly this case: short
 *     enough to look like an ordinary single-call body, dense enough to fail on
 *     `protected_token` on every retry regardless.
 */
export function shouldChunkForTranslation(
  content: string | null,
  options: { maxChunkChars?: number; maxProtectedTokens?: number } = {}
): boolean {
  const clean = sanitiseTranslationContent(content);
  if (clean === null || clean.length === 0) return false;

  const maxChunkChars = options.maxChunkChars ?? OLLAMA_CHUNK_MAX_CHARS;
  if (clean.length > maxChunkChars) return true;

  const maxProtectedTokens = options.maxProtectedTokens ?? OLLAMA_CHUNK_MAX_PROTECTED_TOKENS;
  return protectTokens(clean).values.length > maxProtectedTokens;
}

/**
 * Puts translated chunks back into one article body.
 *
 * A simple ordered join, deliberately simpler than `reassembleArticle`'s per-piece
 * fold: each chunk was translated as ONE opaque block by the model, so there are no
 * individual piece boundaries left to fold on the translated side — only chunk
 * boundaries, each carrying the separator that belonged there in the source.
 */
export function reassembleChunkedTranslation(
  chunked: ChunkedArticle,
  translatedTitle: string | null,
  translatedChunks: readonly string[]
): { translatedTitle: string | null; translatedContent: string | null } {
  let out = "";
  chunked.chunks.forEach((chunk, i) => {
    const text = (translatedChunks[i] ?? "").trim();
    // Defence in depth, mirroring reassembleArticle: a chunk that somehow produced no
    // text must not silently swallow the separator that belonged to its neighbours.
    if (text.length === 0) return;
    out += (out.length === 0 ? "" : chunk.leadingSeparator) + text;
  });
  return { translatedTitle, translatedContent: out.length > 0 ? out : null };
}
