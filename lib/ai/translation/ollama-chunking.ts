import {
  segmentArticle,
  reassembleArticle,
  NO_CONTENT_CAP,
  type SegmentPlan,
} from "./madlad-segmentation";

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
  /** How many sentence-level pieces this chunk folds together — diagnostics only. */
  pieceCount: number;
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

  const { segments, plan, contentChars } = segmentArticle(title, content, {
    mode: "full",
    maxContentChars: NO_CONTENT_CAP,
  });

  const cleanTitle = plan.titleIndex === null ? null : (segments[plan.titleIndex] ?? null);

  const chunks: ArticleChunk[] = [];
  let start = 0;
  let currentLen = 0;

  const flush = (endExclusive: number): void => {
    if (endExclusive <= start) return;
    const slice = plan.body.slice(start, endExclusive);
    const subPlan: SegmentPlan = { titleIndex: null, body: slice };
    // Reused, not reimplemented: the same fold `reassembleArticle` uses to restore a
    // translated article restores a SOURCE one just as well, given the source text as
    // the "translations" array — the fold neither knows nor cares which it is.
    const { translatedContent } = reassembleArticle(subPlan, segments);
    chunks.push({
      text: translatedContent ?? "",
      leadingSeparator: slice[0].separator,
      pieceCount: slice.length,
    });
    start = endExclusive;
    currentLen = 0;
  };

  for (let i = 0; i < plan.body.length; i += 1) {
    const piece = plan.body[i];
    const pieceText = piece.prefix + segments[piece.index];
    const isParagraphBreak = piece.separator.includes("\n\n");

    if (currentLen > 0) {
      const wouldBe = currentLen + piece.separator.length + pieceText.length;
      if (isParagraphBreak && currentLen >= targetMinChars) {
        flush(i);
      } else if (wouldBe > maxChunkChars) {
        flush(i);
      }
    }

    currentLen += (currentLen === 0 ? 0 : piece.separator.length) + pieceText.length;
  }
  flush(plan.body.length);

  return { title: cleanTitle, chunks, contentChars };
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
