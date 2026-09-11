/**
 * Ingestion-time extraction for listing feeds.
 *
 * This is the step the source's "What to extract from each listing" instruction
 * drives. It runs ONCE PER LISTING, at ingestion, and decides which of the
 * provider's facts become that listing's FeedItem content. The Writer is then
 * handed facts and never sees the instruction — it is not the Writer's job to
 * work out what "extract" means.
 *
 *     source API → canonical fields → THIS SELECTION → FeedItem content → Writer
 *
 * ── Why there is no model call here ──────────────────────────────────────────
 * A product page needs one because its facts are prose and must be found. A
 * listing's facts arrive already named by the provider, so the only question left
 * is WHICH of them the owner asked for — a matching problem, not a reading one.
 * Sending it to a model could only add failure modes: a dropped field, a restated
 * price, an "improved" URL. Canonical values (externalId, url, imageUrl, title,
 * createdAt) never pass through here at all — see selectListingFields' contract.
 *
 * ── What this deliberately cannot do ────────────────────────────────────────
 * Selection is matching, not comprehension. An instruction asking for a fact the
 * provider does not publish as a field — "equipment" described in free text, a
 * "year" buried inside a title string, a currency the API never states — cannot
 * be satisfied here, and is reported as unavailable rather than guessed at. That
 * limitation is a property of the provider's data, not of this module: a richer
 * endpoint closes it by declaring more fields, with no change to this file.
 */

import type { ListingField } from "@/lib/integrations/listing-feed/types";

/** What the instruction selected, and what it asked for and could not get. */
export interface ListingSelection {
  /** The fields to store as this listing's factual content, in provider order. */
  fields: ListingField[];
  /**
   * Terms the instruction asked for that no field answers to.
   *
   * Kept for diagnosis and for the owner-facing truth that these were NOT
   * quietly supplied from elsewhere. Never rendered into a prompt as a gap to
   * fill — that is how a model ends up inventing a year.
   */
  unavailable: string[];
  /**
   * How `fields` was chosen:
   *   • "all"        — no instruction; every fact the provider read.
   *   • "instructed" — the instruction matched, and selected these.
   *   • "unmatched"  — an instruction was given and matched NOTHING, so every
   *                    fact was kept rather than none. See the note below.
   */
  basis: "all" | "instructed" | "unmatched";
}

/**
 * Words carrying no selection meaning. Trimmed so that "Extract the price and
 * the location of each listing" does not match a field whose concepts happen to
 * include a common word.
 *
 * English and Bulgarian, because an owner writes this field in their own
 * language and the two locales this product ships in are `en` and `bg`.
 */
const STOPWORDS = new Set([
  // English
  "extract",
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "for",
  "from",
  "each",
  "every",
  "all",
  "any",
  "with",
  "its",
  "their",
  "please",
  "include",
  "listing",
  "listings",
  "item",
  "items",
  "details",
  "detail",
  "information",
  "info",
  "data",
  "fields",
  "field",
  "plus",
  "also",
  "other",
  "relevant",
  "where",
  "available",
  "if",
  "is",
  "are",
  "to",
  "in",
  "on",
  "by",
  "as",
  "it",
  "this",
  "that",
  "these",
  "those",
  // Bulgarian
  "извлечи",
  "извлича",
  "вземи",
  "взема",
  "и",
  "или",
  "на",
  "от",
  "за",
  "с",
  "всяка",
  "всеки",
  "всяко",
  "всички",
  "обява",
  "обяви",
  "обявата",
  "детайли",
  "информация",
  "данни",
  "поле",
  "полета",
  "както",
  "също",
  "ако",
  "има",
  "налично",
  "налична",
  "да",
  "се",
  "в",
]);

/**
 * Lowercases and strips punctuation, leaving space-separated words.
 *
 * Uses a Unicode property escape rather than `\w`, because `\w` is ASCII-only —
 * it would shred every Bulgarian instruction into nothing. (The same trap that
 * `bgWord()` exists for in generation-compliance.ts.)
 */
function normalize(text: string): string {
  return ` ${text
    .toLocaleLowerCase("bg")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;
}

/** The meaningful words of an instruction, in order, deduplicated. */
export function instructionTerms(instruction: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const word of normalize(instruction).split(" ")) {
    if (!word || word.length < 2 || STOPWORDS.has(word) || seen.has(word)) continue;
    seen.add(word);
    terms.push(word);
  }
  return terms;
}

/**
 * Whether a field answers to anything in the instruction.
 *
 * Exact token match for single-word concepts and phrase containment for
 * multi-word ones. Deliberately NOT fuzzy: a provider declares its own plurals
 * and translations, so there is no stemming to get subtly wrong, and a field is
 * either asked for or it is not.
 */
function fieldMatches(
  field: ListingField,
  normalized: string,
  terms: ReadonlySet<string>
): boolean {
  for (const concept of field.concepts) {
    const c = concept.toLocaleLowerCase("bg").trim();
    if (!c) continue;
    if (c.includes(" ")) {
      if (normalized.includes(` ${c} `)) return true;
    } else if (terms.has(c)) {
      return true;
    }
  }
  return false;
}

/**
 * Applies one listing's extraction instruction to one listing's fields.
 *
 * Pure, and pure on purpose: this is the rule that decides what a post may state
 * about a real item with a real price, so it is testable without a provider, a
 * database, or a model.
 *
 * CANONICAL VALUES ARE NOT AN INPUT HERE. The listing's externalId, URL, image
 * and title are not fields and are never passed to this function — no instruction
 * can drop, reorder or alter them. That is what keeps "preserve the listing URL"
 * a structural guarantee rather than a rule someone has to remember.
 *
 * No instruction means every fact, which is the correct default: an owner who has
 * said nothing has not asked for anything to be left out.
 */
export function selectListingFields(
  fields: readonly ListingField[],
  instruction: string | null | undefined
): ListingSelection {
  const text = instruction?.trim();
  if (!text) return { fields: [...fields], unavailable: [], basis: "all" };

  const normalized = normalize(text);
  const terms = new Set(instructionTerms(text));

  const selected = fields.filter((f) => fieldMatches(f, normalized, terms));

  // Which requested terms nothing answered to. Computed from the terms rather
  // than from the unselected fields, so it reports what the OWNER asked for
  // ("year", "engine") and not what the provider happens to carry.
  const answered = new Set<string>();
  for (const field of selected) {
    for (const concept of field.concepts) {
      const c = concept.toLocaleLowerCase("bg").trim();
      if (terms.has(c)) answered.add(c);
      else if (c.includes(" "))
        for (const part of c.split(" ")) if (terms.has(part)) answered.add(part);
    }
  }
  const unavailable = [...terms].filter((t) => !answered.has(t));

  // An instruction that matches nothing keeps every fact instead of producing an
  // empty listing. The alternative — storing a FeedItem with no facts at all —
  // would silently make the whole feed ungeneratable, and the likeliest cause is
  // an instruction written in the vocabulary of a different provider rather than
  // a genuine request for a post with nothing in it. Flagged, not hidden: the
  // caller logs it and `basis` records it on the row.
  if (selected.length === 0) {
    return { fields: [...fields], unavailable, basis: "unmatched" };
  }

  return { fields: selected, unavailable, basis: "instructed" };
}
