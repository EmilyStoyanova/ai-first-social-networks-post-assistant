import { capTranslationContent, sanitiseTranslationContent } from "@/lib/ai/feed-item-translation";

/**
 * Cutting an article into pieces MADLAD can actually translate, and putting the
 * pieces back together afterwards.
 *
 * ── One sentence per segment ─────────────────────────────────────────────────
 * MADLAD-400 is a SENTENCE-level NMT model. Given two sentences in one request it
 * translates both and runs them together, dropping the space between them:
 *
 *   "…how it has been stored. The manufacturing date is stamped…"
 *     → "…начина на съхранение.Датата на производство е отпечатана…"
 *
 * That is not a reassembly bug — the joined text comes back from the model that way,
 * inside a single segment — and no amount of care on the join could fix it, because by
 * then the boundary no longer exists. So the split is at SENTENCE granularity: one
 * sentence in, one sentence out, which is also the shape the model was trained on and
 * the shape that produced the good single-sentence results.
 *
 * ── Separators are data, not convention ──────────────────────────────────────
 * The plan therefore records, for every piece, the EXACT source text that separated it
 * from the piece before — " ", "\n", "\n\n", or "" for a mid-token cut. Reassembly is a
 * fold that re-emits those literals, so it never has to assume what a boundary was, and
 * a space can be neither invented nor lost. `prefix` carries a list or heading marker
 * ("- ", "1. ", "## ") which is likewise re-emitted verbatim and never translated, so
 * the model can neither drop a bullet nor renumber a list.
 *
 * Everything here is pure and deterministic, which is why it can be unit-tested — the
 * same logic buried in the Mac worker could not be.
 */

/**
 * Characters per segment. Only a single sentence longer than this is ever divided, so
 * in practice this is a guard against a wall of unpunctuated text rather than a routine
 * limit. Chosen well under the model's 512-token ceiling so a Bulgarian rendering —
 * reliably longer than its English source — still fits with room to spare.
 */
export const MAX_SEGMENT_CHARS = 700;

/**
 * No article-level content budget, by default.
 *
 * `MAX_TRANSLATION_CONTENT_CHARS` (3000, in feed-item-translation.ts) exists for the
 * PROMPT-BASED engine: it sends the whole body in ONE call and must get back ONE
 * complete JSON reply inside a wall-clock budget, so an oversized body risks a 300s
 * timeout or a reply truncated mid-JSON (see that constant's own comment). MADLAD does
 * not have that failure mode — this module already cuts the body into independent,
 * sentence-sized calls bounded by {@link MAX_SEGMENT_CHARS} each — so applying the same
 * 3000-char article cap here was inherited, not needed, and its actual effect in
 * production was silent data loss: feed item 825c8475 (23,416 raw chars) was capped to
 * 3,003 before segmentation ever ran, translated only its opening ~13%, and was stored
 * as `completed` with no signal that ~87% of the article was simply never sent.
 *
 * Going uncapped is safe here specifically BECAUSE the per-item wall-clock ceiling
 * (`TRANSLATION_ITEM_TIMEOUT_MS`) already guards the total cost: `translate()` below
 * checks the remaining item budget before every segment call and throws a clean
 * {@link TranslationTimeoutError} rather than ever returning a partial article — so an
 * article too long to finish fails visibly and retries with the normal backoff, exactly
 * like any other over-budget item, instead of silently completing with most of its text
 * missing. That per-item ceiling is shared with the cron's own run budget and is left
 * untouched here.
 */
export const NO_CONTENT_CAP = Number.POSITIVE_INFINITY;

/**
 * A leading list/heading marker, held out of the translated text.
 *
 * Anchored and deliberately narrow: bullet glyphs, markdown headings, and a short
 * ordinal ("1." / "1)" / "iv."). A dash must be followed by whitespace, so an
 * em-dash opening a sentence is not mistaken for a bullet.
 */
const LINE_MARKER = /^((?:[-–—*•·‣▪◦]|#{1,6}|\d{1,3}[.)]|[ivxIVX]{1,4}[.)])\s+)/;

/** Abbreviations whose full stop ends a word, not a sentence. */
const ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "st",
  "no",
  "nos",
  "vs",
  "etc",
  "fig",
  "figs",
  "approx",
  "inc",
  "ltd",
  "co",
  "corp",
  "dept",
  "est",
  "min",
  "max",
  "e.g",
  "i.e",
  "u.s",
  "u.k",
  "a.m",
  "p.m",
  "г",
  "др",
  "напр",
  "прибл",
  "т.н",
  "проф",
  "инж",
]);

/** One translatable piece, and the literal text that precedes it. */
export interface BodyPiece {
  /**
   * The EXACT source text between the previous piece and this one:
   * `""` for the first piece (and for a mid-token cut), `" "` between sentences of a
   * line, `"\n"` between lines, `"\n\n"` between paragraphs.
   */
  separator: string;
  /** List or heading marker, re-emitted verbatim. `""` for ordinary prose. */
  prefix: string;
  /** Index into {@link SegmentedArticle.segments}. */
  index: number;
}

export interface SegmentPlan {
  /** Index of the title segment, or null when the article has no title. */
  titleIndex: number | null;
  /** The body in document order. Reassembly folds this into a string. */
  body: BodyPiece[];
}

export interface SegmentedArticle {
  /** The texts to translate, in order. This is exactly what goes on the wire. */
  segments: string[];
  plan: SegmentPlan;
  /** Body characters actually sent, after sanitising and capping. Logged for diagnostics. */
  contentChars: number;
}

export interface SegmentArticleOptions {
  /**
   * Body-character budget. Unbounded (`Infinity`) by default — see
   * {@link NO_CONTENT_CAP} for why this must NOT default to the prompt-based engine's
   * {@link MAX_TRANSLATION_CONTENT_CHARS}. Tests pass an explicit value to exercise
   * capping deliberately (see the "caps the body…" test in madlad-segmentation.test.ts).
   */
  maxContentChars?: number;
  /** Per-segment character cap. Defaults to {@link MAX_SEGMENT_CHARS}. */
  maxSegmentChars?: number;
  /** "title_only" ignores the body entirely — a bodyless article has none to send. */
  mode?: "full" | "title_only";
}

/**
 * Whether the full stop at the end of `head` really ends a sentence.
 *
 * Three things masquerade as a sentence end and would, if split on, hand the model
 * a fragment and hand the reader a mangled number:
 *   • an abbreviation      — "approx. 5 years", "e.g. the drill";
 *   • an initial           — "J. Smith";
 *   • an ordinal or figure — "No. 5", "Fig. 3".
 * A decimal ("5.5 mm") never reaches here at all, because the boundary requires
 * whitespace after the stop.
 */
function endsSentence(head: string, rest: string): boolean {
  // A sentence starts with a capital, a quote or a bracket — never a lowercase letter.
  if (/^\p{Ll}/u.test(rest)) return false;

  const lastToken = head.trimEnd().split(/\s+/).pop() ?? "";
  const word = lastToken.replace(/[)\]"'»“”]+$/u, "").replace(/[.!?…:]+$/u, "");
  if (word.length === 0) return true;
  if (ABBREVIATIONS.has(word.toLowerCase())) return false;
  // A single letter before the stop is an initial ("J. Smith", "А. Иванов").
  if (word.length === 1 && /\p{L}/u.test(word)) return false;
  // "No. 5" / "1." — a bare number before the stop is a label, not a sentence.
  if (/^\d+$/.test(word) && /^\d/.test(rest)) return false;
  return true;
}

/** A piece of text plus the literal separator that preceded it. */
interface Separated {
  text: string;
  separator: string;
}

/**
 * Splits one line into sentences, capturing the whitespace between them.
 *
 * Nothing is added and nothing is dropped: every character outside a captured
 * separator lands in exactly one sentence, so re-emitting sentence + separator
 * reproduces the line character for character.
 */
function splitSentences(text: string): Separated[] {
  const out: Separated[] = [];
  // Sentence punctuation followed by HORIZONTAL whitespace — a newline is a line
  // boundary, handled a level up, and must never be consumed here.
  //
  // A colon is deliberately NOT a boundary. It joins a clause to what introduces it,
  // and cutting there hands the model a fragment that it then translates as a fresh
  // sentence: "…that difference is measurable: the same pack drives…" came back as
  // "…е измерима: Същият пакет задвижва…", capitalised mid-sentence. A heading followed
  // by its list is separated by a NEWLINE, so it is split a level up and loses nothing.
  const boundary = /[.!?…]([^\S\n]+)/g;
  let start = 0;
  let separator = "";
  let match: RegExpExecArray | null;

  while ((match = boundary.exec(text)) !== null) {
    const sentenceEnd = match.index + 1;
    const nextStart = match.index + match[0].length;
    const head = text.slice(start, sentenceEnd);
    const rest = text.slice(nextStart);
    if (rest.length === 0 || !endsSentence(head, rest)) continue;

    const piece = text.slice(start, sentenceEnd).trim();
    if (piece.length > 0) {
      out.push({ text: piece, separator });
      separator = match[1];
    }
    start = nextStart;
  }

  const tail = text.slice(start).trim();
  if (tail.length > 0) out.push({ text: tail, separator });
  return out;
}

/**
 * Divides a single sentence that is too long to send whole.
 *
 * Cuts at a word boundary and records that boundary's whitespace as the separator, so
 * the pieces rejoin exactly. In the degenerate case — no space anywhere near the limit,
 * which in practice means one enormous token — it runs on to the next boundary rather
 * than splitting the token, and only cuts blind when there is none; a blind cut records
 * an EMPTY separator, so rejoining does not insert a space that was never there.
 */
function chunkSentence(sentence: string, limit: number): Separated[] {
  if (sentence.length <= limit) return [{ text: sentence, separator: "" }];

  const out: Separated[] = [];
  let rest = sentence;
  let separator = "";

  while (rest.length > limit) {
    const back = rest.lastIndexOf(" ", limit);
    let at: number;
    if (back > limit / 2) {
      at = back;
    } else {
      const forward = rest.indexOf(" ", limit);
      at = forward !== -1 && forward <= limit * 2 ? forward : limit;
    }

    const head = rest.slice(0, at).trim();
    if (head.length > 0) {
      out.push({ text: head, separator });
      // Whatever we cut at IS the separator: a space when we cut at one, nothing at all
      // when the cut fell inside a token.
      separator = /^\s/.test(rest.slice(at)) ? " " : "";
    }
    rest = rest.slice(at).trim();
  }

  if (rest.length > 0) out.push({ text: rest, separator });
  return out;
}

/**
 * Cuts an article into translatable segments.
 *
 * The body is sanitised with the SAME cleanup the prompt-based engine uses (stripped
 * markup, boilerplate trailers, language-switcher noise — see
 * sanitiseTranslationContent), so both engines translate the same ARTICLE. Capping is
 * deliberately NOT shared by default: see {@link NO_CONTENT_CAP} for why the prompt-based
 * engine's article-length budget does not apply to a segment-at-a-time engine.
 */
export function segmentArticle(
  title: string | null,
  content: string | null,
  options: SegmentArticleOptions = {}
): SegmentedArticle {
  const limit = options.maxSegmentChars ?? MAX_SEGMENT_CHARS;
  const segments: string[] = [];
  const body: BodyPiece[] = [];

  let titleIndex: number | null = null;
  const cleanTitle = title?.trim() ?? "";
  if (cleanTitle.length > 0) {
    titleIndex = 0;
    segments.push(cleanTitle);
  }

  let contentChars = 0;
  if (options.mode !== "title_only") {
    const cleaned = sanitiseTranslationContent(content);
    const capped = capTranslationContent(cleaned, options.maxContentChars ?? NO_CONTENT_CAP);
    contentChars = capped?.length ?? 0;

    if (capped) {
      // The capturing groups keep the separators themselves, so a boundary is never
      // reconstructed from an assumption about what it must have been.
      const paragraphs = capped.split(/(\n[^\S\n]*\n[\s]*)/);

      /** The literal separator owed to the next piece emitted. "" before the first. */
      let pending = "";

      for (let p = 0; p < paragraphs.length; p += 1) {
        // Odd indices are the captured paragraph separators.
        if (p % 2 === 1) {
          pending = paragraphs[p];
          continue;
        }

        const lines = paragraphs[p].split(/(\n)/);
        for (let l = 0; l < lines.length; l += 1) {
          if (l % 2 === 1) {
            pending = lines[l];
            continue;
          }

          const rawLine = lines[l];
          const marker = LINE_MARKER.exec(rawLine.trim());
          const prefix = marker ? marker[1].replace(/\s+$/, " ") : "";
          const lineBody = marker ? rawLine.trim().slice(marker[1].length) : rawLine;

          // A line with neither a letter nor a digit is a rule, a stray bullet or a
          // widget's leftovers — never a sentence. Sending it would spend a call to have
          // a decoder hallucinate something in place of "———". A line of pure digits IS
          // kept: it is how a structured spec table (ArchDaily's "Year:" / "2025") renders
          // a fact's value on its own line, separate from its label.
          if (!/[\p{L}\p{N}]/u.test(lineBody)) continue;

          let first = true;
          for (const sentence of splitSentences(lineBody.trim())) {
            for (const chunk of chunkSentence(sentence.text, limit)) {
              // The line/paragraph separator owed from above wins over the intra-line
              // one for the FIRST piece of the line; after that the piece's own applies.
              const separator = first ? pending : chunk.separator || sentence.separator;
              body.push({
                separator: body.length === 0 ? "" : separator,
                prefix: first ? prefix : "",
                index: segments.length,
              });
              segments.push(chunk.text);
              first = false;
            }
          }
        }
      }
    }
  }

  return { segments, plan: { titleIndex, body }, contentChars };
}

export interface ReassembledArticle {
  translatedTitle: string | null;
  translatedContent: string | null;
}

/** Of two separators, the one that carries more structure. */
function stronger(a: string, b: string): string {
  const newlines = (s: string) => (s.match(/\n/g) ?? []).length;
  if (newlines(a) !== newlines(b)) return newlines(a) > newlines(b) ? a : b;
  return a.length >= b.length ? a : b;
}

/**
 * Puts the translated segments back into an article.
 *
 * A fold over the plan: for each piece, re-emit its literal separator, its marker, then
 * its translation. Because the separators came from the source rather than from a
 * convention, an identity translation round-trips to the input character for character.
 *
 * Returns `null` for a part that has no segments — a bodyless article yields a null
 * body rather than an empty string, which is the same distinction the rest of the
 * pipeline draws between "no body" and "an empty translation".
 */
export function reassembleArticle(
  plan: SegmentPlan,
  translations: readonly string[]
): ReassembledArticle {
  const at = (index: number): string => (translations[index] ?? "").trim();

  const translatedTitle = plan.titleIndex === null ? null : at(plan.titleIndex) || null;

  let out = "";
  /** Separator owed by a piece that was dropped, so its structure is not lost with it. */
  let owed: string | null = null;

  for (const piece of plan.body) {
    const text = at(piece.index);
    const separator: string = owed === null ? piece.separator : stronger(owed, piece.separator);

    if (text.length === 0) {
      // Defence in depth: the provider already refuses an empty segment translation.
      owed = separator;
      continue;
    }

    out += (out.length === 0 ? "" : separator) + piece.prefix + text;
    owed = null;
  }

  return { translatedTitle, translatedContent: out.length > 0 ? out : null };
}
