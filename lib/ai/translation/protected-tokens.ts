import { TranslationParseError } from "@/lib/ai/feed-item-translation";
import { ABBREVIATIONS } from "@/lib/ai/translation/madlad-segmentation";

/**
 * Holding non-translatable values out of the decoder.
 *
 * MADLAD is a translation model, and it translates everything it is given — including
 * things that are DATA rather than language. Measured against the running worker, an
 * unprotected article loses them outright:
 *
 *   "…published at https://example.com/safety/extinguisher-checklist and should…"
 *     → "…са публикувани на адрес и трябва…"            (URL deleted)
 *   "…https://example.com/safety/checklist for details."
 *     → "…https://безопасност/контролен-списък… за подробности."   (path TRANSLATED)
 *   "Write to service@example.com before the warranty expires."
 *     → "Пишете на адрес преди да изтече гаранцията."   (address deleted)
 *   "The model is DCD-800 P2 and it weighs 1.6 kg."
 *     → "Моделът е и тежи 1.6 кг."                      (model code deleted)
 *
 * All four are silent: the sentence still reads well, so nothing downstream can tell
 * that the one piece of information the reader needed is gone. So each such value is
 * swapped for a placeholder before the call and swapped back afterwards.
 *
 * ── Why `[[0]]` and not `__URL_0__` ──────────────────────────────────────────
 * The placeholder has to survive a SentencePiece tokenizer and a beam search that were
 * never told it is special. That is an empirical question, not a design one, so the
 * candidates were measured against the real model:
 *
 *   [[0]]        survives  — every position tested, incl. duplicates and [[10]]/[[11]]
 *   #0# / @0@    survives
 *   X0X          MANGLED   — transliterated to Cyrillic "Х0Х" mid-sentence
 *   __URL_0__    DESTROYED — collapsed to "__"
 *   ⟦0⟧          DESTROYED — dropped, or decoded as "0000"
 *
 * `[[n]]` was chosen because it survived every context tried: sentence-initial,
 * sentence-final, before a comma/colon/parenthesis, twice in one sentence, five in one
 * sentence, and with two-digit indices.
 *
 * ── What is deliberately NOT protected ───────────────────────────────────────
 * Bare numbers, decimals, ranges, prices and measurements are left translatable,
 * because the same measurement showed the model handles them CORRECTLY and localises
 * them the way Bulgarian actually writes them:
 *
 *   "at approx. 12.5 bar"   → "на около 12,5 бара"      (decimal comma — correct)
 *   "90 Nm … 13 mm"         → "90 Нм … 13 мм"           (units in Cyrillic — correct)
 *   "between 5 and 15 years" → "между 5 и 15 години"
 *
 * Freezing those behind a placeholder would force English formatting into Bulgarian
 * text and make the output worse, not safer. Protection is for values whose identity
 * is exact and whose loss is silent — not for everything that contains a digit.
 */

/** The classes of value held out of the decoder. Each is justified by a measured loss. */
export type ProtectedTokenKind = "url" | "email" | "identifier";

export interface ProtectedValue {
  kind: ProtectedTokenKind;
  /** The exact source text, restored verbatim. */
  value: string;
}

export interface ProtectedText {
  /** What goes on the wire: the source with each protected value replaced by `[[n]]`. */
  text: string;
  /**
   * The captured originals, indexed by placeholder number. Every OCCURRENCE gets its
   * own index — the same URL twice yields `[[0]]` and `[[1]]` — so multiplicity is
   * preserved by construction and validation is a simple "each index exactly once".
   */
  values: ProtectedValue[];
}

/** The placeholder syntax. Two brackets, a decimal index, two brackets. */
const PLACEHOLDER = /\[\[(\d+)\]\]/g;

/** Rendered form of placeholder `index`. */
export function placeholderFor(index: number): string {
  return `[[${index}]]`;
}

/** Punctuation that can sit around a value without belonging to it. */
const LEADING = /^[([{"'«„“‘]+/u;
const TRAILING = /[)\]}"'»”’.,;:!?…]+$/u;

const URL = /^(?:https?:\/\/|www\.)[^\s]+$/i;
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/**
 * A number — cardinal, ordinal, or decade — compounded with a plain lowercase word:
 * "15-minute", "13th-century", "1980s-built", "3-day", "5-star". This reads as prose,
 * not as a code, and MADLAD translates it correctly and faithfully left alone:
 *   "13th-century church" → "църква от 13-ти век"
 *   "a 15-minute drive"   → "на 15 минути път" (measured against the real worker)
 *
 * It was previously caught by the internal-punctuation branch below (a digit run joined
 * to a letter run by a hyphen is indistinguishable, by shape alone, from "DCD-800"), and
 * that is a real production failure, not a theoretical one — first for the ordinal/decade
 * shape ("13th-century", feed item 825c8475, segment 9/17), then for the plain cardinal
 * shape ("15-minute", same feed item, segment 32/120, once the article-length fix let the
 * article reach that far): protecting it forces the placeholder into an
 * ATTRIBUTIVE-ADJECTIVE slot immediately before the noun it modifies ("a [[0]] drive",
 * "[[0]] church stood…") — measured against the real worker, that is precisely the
 * position `[[n]]` is unreliable in. The model either drops the token outright or
 * hallucinates a substitute in its place — for "15-minute" specifically, MADLAD did not
 * merely drop [[0]], it invented a DIFFERENT number ("10 минути" for "15-minute"), which
 * restoreTokens still correctly rejects, but is a sharper illustration of why a guess is
 * never an acceptable fallback here. The same placeholder in a NOUN position (an
 * appositive, a sentence-final complement, a "the [[0]] warehouse" subject) survives
 * reliably — the problem is the position this specific token class forces the placeholder
 * into, not the `[[n]]` syntax itself.
 *
 * The ordinal/decade suffix (`st`/`nd`/`rd`/`th`/`s`) is therefore optional, not required:
 * a bare cardinal followed by "-" and a lowercase word is the same shape and the same
 * failure. This does not broaden which genuine identifiers get excluded — every real
 * model code / SKU / version string measured (`DCD-800`, `TX-2/B`, `v2.14.3`, `P2`,
 * `230V`) either does not start with a digit, uses a separator other than "-", or ends in
 * uppercase/mixed-case rather than a plain lowercase word, so none of them match this
 * shape.
 */
const NUMBER_HYPHEN_WORD_COMPOUND = /^\d+(?:st|nd|rd|th|s)?-[a-z]+$/;

/**
 * Whether a token is a product/model/version identifier rather than a word.
 *
 * Narrow on purpose. It requires BOTH a letter and a digit, and then one of two shapes
 * that ordinary prose does not have:
 *   • internal punctuation joining alphanumerics — "DCD-800", "v2.14.3", "TX-2/B";
 *   • no lowercase letters at all — "P2", "3D", "B12", "230V".
 *
 * That admits model codes, SKUs and version strings while leaving "5kg", "12mm" and
 * "1.6" alone — which matters, because those are exactly the tokens the model gets
 * RIGHT and localises, and freezing them would be a regression. The number-hyphen-word
 * exclusion above is carved out of the internal-punctuation shape for the same reason.
 */
function isIdentifier(token: string): boolean {
  if (token.length < 2) return false;
  if (!/[A-Za-z]/.test(token)) return false;
  if (!/\d/.test(token)) return false;
  if (NUMBER_HYPHEN_WORD_COMPOUND.test(token)) return false;
  if (/^[A-Za-z0-9]+[-._/][A-Za-z0-9]+(?:[-._/][A-Za-z0-9]+)*$/.test(token)) return true;
  return !/[a-z]/.test(token) && /^[A-Z0-9]+$/.test(token);
}

function classify(token: string): ProtectedTokenKind | null {
  if (URL.test(token)) return "url";
  if (EMAIL.test(token)) return "email";
  if (isIdentifier(token)) return "identifier";
  return null;
}

/**
 * Sentence punctuation immediately followed by an uppercase letter and a lowercase
 * letter, with NO whitespace between them at all — the shape a broken extraction leaves
 * when two paragraphs are concatenated without a separator:
 *   "...the area's sine qua non grande dame since 1965.In the 55 rooms..."
 * (feed item 825c8475, segment 69/120 — "1965.In" matched the version-string shape of
 * `isIdentifier` below and was protected; MADLAD dropped the placeholder, and the whole
 * translation was correctly rejected rather than stored corrupted). The same article
 * carries dozens of these from widget/byline concatenation ("Read Full ReviewLa Roqqa",
 * "—S.M.Read Full Review") — a systemic extraction artifact, not a one-off.
 *
 * Requiring a LOWERCASE second letter is what keeps this from firing inside a real
 * decimal or version string: every digit that can legally follow "." in those (`12.5`,
 * `v2.14.3`) is a DIGIT, never an uppercase letter, so this pattern cannot match there
 * at all — see `normaliseGluedSentenceBoundaries` below for why URLs and e-mail
 * addresses need a separate, explicit exclusion instead of relying on this alone.
 */
const GLUED_SENTENCE_BOUNDARY = /[.!?…]\p{Lu}\p{Ll}/u;

/**
 * Inserts the missing space at a glued sentence boundary, so neither `protectTokens`
 * below nor MADLAD itself ever sees "1965.In" as a single unit.
 *
 * Walks the SAME whitespace-delimited tokens `protectTokens` walks, using the SAME
 * leading/trailing punctuation stripping, so "core" means the same thing in both
 * places. A token is left completely untouched when:
 *   • it IS a URL or e-mail address — a "." inside either is data, and `[^\s]+` in
 *     both those patterns would otherwise happily swallow a glued word past the real
 *     boundary ("www.example.com.The" reads as one non-whitespace run); splitting it
 *     would corrupt the address, so recognising it as one is checked FIRST and wins;
 *   • the word immediately before the punctuation is a known abbreviation ("etc.",
 *     "approx.") or a single-letter initial ("J.") — the exact judgement
 *     `splitSentences`/`endsSentence` already make in madlad-segmentation.ts for the
 *     ordinary, whitespace-preceded case, reused here via the shared
 *     {@link ABBREVIATIONS} list so a glued boundary and a spaced one are classified by
 *     one rule, not two that could drift apart. (A multi-letter abbreviated name like
 *     "J.K." is not specially excluded: splitting "J.K.Rowling" into "J.K. Rowling" is
 *     the CORRECT canonical form, not a corruption, and neither half contains a digit,
 *     so it can never be misclassified as an identifier either way.)
 *
 * Everything else gets exactly one space inserted, right after the punctuation mark —
 * nothing is deleted, reordered, or translated here, so this can never introduce the
 * kind of loss the rest of this module exists to prevent.
 */
export function normaliseGluedSentenceBoundaries(text: string): string {
  let out = "";
  let cursor = 0;

  const token = /\S+/g;
  let match: RegExpExecArray | null;

  while ((match = token.exec(text)) !== null) {
    const raw = match[0];
    const lead = LEADING.exec(raw)?.[0] ?? "";
    const withoutLead = raw.slice(lead.length);
    const trail = TRAILING.exec(withoutLead)?.[0] ?? "";
    const core = withoutLead.slice(0, withoutLead.length - trail.length);
    if (core.length === 0) continue;
    if (URL.test(core) || EMAIL.test(core)) continue;

    const boundary = GLUED_SENTENCE_BOUNDARY.exec(core);
    if (!boundary || boundary.index === undefined) continue;

    const splitAt = boundary.index + 1; // right after the punctuation mark
    const word = core.slice(0, splitAt).replace(/[.!?…]+$/u, "");
    if (ABBREVIATIONS.has(word.toLowerCase())) continue;
    if (word.length === 1 && /\p{L}/u.test(word)) continue; // a single-letter initial

    const absoluteSplit = match.index + lead.length + splitAt;
    out += text.slice(cursor, absoluteSplit) + " ";
    cursor = absoluteSplit;
  }

  out += text.slice(cursor);
  return out;
}

/**
 * Replaces every protected value in one segment with a placeholder.
 *
 * Works on whitespace-delimited tokens, stripping the punctuation that surrounds a
 * value without belonging to it — so "(see https://example.com/a)," protects the URL
 * and leaves the bracket and the comma in the sentence for the model to place.
 *
 * The text is first passed through {@link normaliseGluedSentenceBoundaries}, so a
 * broken-extraction artifact like "1965.In" is never a candidate token here in the
 * first place — see that function for what it does and does not touch.
 */
export function protectTokens(rawText: string): ProtectedText {
  const text = normaliseGluedSentenceBoundaries(rawText);
  const values: ProtectedValue[] = [];
  let out = "";
  let cursor = 0;

  const token = /\S+/g;
  let match: RegExpExecArray | null;

  while ((match = token.exec(text)) !== null) {
    const raw = match[0];
    const lead = LEADING.exec(raw)?.[0] ?? "";
    const withoutLead = raw.slice(lead.length);
    const trail = TRAILING.exec(withoutLead)?.[0] ?? "";
    const core = withoutLead.slice(0, withoutLead.length - trail.length);
    if (core.length === 0) continue;

    const kind = classify(core);
    if (kind === null) continue;

    const start = match.index + lead.length;
    out += text.slice(cursor, start) + placeholderFor(values.length);
    cursor = start + core.length;
    values.push({ kind, value: core });
  }

  out += text.slice(cursor);
  return { text: out, values };
}

/** Every `[[n]]` in `text`, as numbers, in order of appearance. */
function placeholderIndices(text: string): number[] {
  const found: number[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) found.push(Number(match[1]));
  return found;
}

/**
 * Puts the protected values back, refusing anything ambiguous.
 *
 * A translation is only restorable when every placeholder that was sent came back
 * exactly once — no more, no fewer, and none invented. Anything else is rejected
 * rather than repaired: a guess about which URL belonged where is precisely the silent
 * corruption this module exists to prevent, and a rejected article is retried and
 * visible where a corrupted one is neither.
 */
export function restoreTokens(
  translated: string,
  values: readonly ProtectedValue[],
  context: string
): string {
  const found = placeholderIndices(translated);

  if (values.length === 0) {
    if (found.length > 0) {
      throw new TranslationParseError(
        `Translation invented placeholder(s) ${found.map(placeholderFor).join(", ")} in ${context}, which had none.`,
        "protected_token"
      );
    }
    return translated;
  }

  const seen = new Map<number, number>();
  for (const index of found) seen.set(index, (seen.get(index) ?? 0) + 1);

  const missing: string[] = [];
  const duplicated: string[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const count = seen.get(i) ?? 0;
    if (count === 0) missing.push(placeholderFor(i));
    else if (count > 1) duplicated.push(`${placeholderFor(i)}×${count}`);
    seen.delete(i);
  }
  const invented = [...seen.keys()].map(placeholderFor);

  if (missing.length > 0 || duplicated.length > 0 || invented.length > 0) {
    const parts = [
      missing.length > 0 ? `dropped ${missing.join(", ")}` : "",
      duplicated.length > 0 ? `duplicated ${duplicated.join(", ")}` : "",
      invented.length > 0 ? `invented ${invented.join(", ")}` : "",
    ].filter(Boolean);
    throw new TranslationParseError(
      `Translation ${parts.join("; ")} in ${context} — the protected value(s) ` +
        `${missing.concat(duplicated, invented).length} could not be restored unambiguously ` +
        `(${values.map((v) => v.value).join(", ")}).`,
      "protected_token"
    );
  }

  return translated.replace(PLACEHOLDER, (_whole, digits: string) => values[Number(digits)].value);
}

/**
 * Every URL in a piece of text, in order.
 *
 * Used for the article-level invariant: the translation must carry exactly the URLs the
 * source did, in the same order and the same number of times. Restoration already
 * guarantees this per segment; this is the independent second check across the whole
 * reassembled article, where a segmentation fault could still drop one.
 */
export function extractUrls(text: string): string[] {
  const urls: string[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    const raw = match[0];
    const core = raw.replace(LEADING, "").replace(TRAILING, "");
    if (core.length > 0 && URL.test(core)) urls.push(core);
  }
  return urls;
}
