/**
 * `CompetitorIntelligence.relevanceReason` — canonical value in, localized
 * text out (2026-09-02 mixed-language fix).
 *
 * The column holds two genuinely different kinds of value, and only one of
 * them is free-form AI text:
 *
 *  1. **System-written, deterministic reasons.** `recomputeRelevanceForRow`
 *     writes these itself with no model involved — "no research interests
 *     configured", "retries exhausted". These are a finite vocabulary, so they
 *     must be localized by mapping, never by an AI call (§6 of the governing
 *     instruction). They used to be stored as English prose and rendered raw,
 *     which is one of the ways English leaked into the Bulgarian UI.
 *  2. **The model's own one-sentence explanation** of a genuine verdict. That
 *     is free-form analysis text and cannot be mapped; it is written in the
 *     company's analysis language at generation time instead (see
 *     `analysis-language.ts`).
 *
 * Going forward, case 1 is stored as a stable `code:<name>` token — canonical,
 * machine-readable, never a Bulgarian string in the database. Rows written
 * BEFORE this fix hold the old English sentences, so `resolveRelevanceReason`
 * also recognizes those verbatim: existing rows localize correctly with no
 * migration, no backfill, and no re-analysis. That legacy table is the whole
 * reason this is a lookup rather than a bare prefix check.
 *
 * Pure and dependency-free (no Prisma, no React, no next-intl) like this
 * directory's other decision modules — the caller does the `t()`.
 */

export const RELEVANCE_REASON_CODES = ["no_research_interests", "attempts_exhausted"] as const;

export type RelevanceReasonCode = (typeof RELEVANCE_REASON_CODES)[number];

/** Namespaces the canonical tokens so a model-written sentence can never
 *  collide with one — no natural-language reason begins with `code:`. */
export const RELEVANCE_REASON_CODE_PREFIX = "code:";

/** The value to PERSIST for a deterministic reason. */
export function relevanceReasonCodeValue(code: RelevanceReasonCode): string {
  return `${RELEVANCE_REASON_CODE_PREFIX}${code}`;
}

/**
 * The exact English sentences written into this column before 2026-09-02.
 * Matched so pre-existing rows render in the viewer's language too — the
 * deterministic half of "existing rows display correctly" (§5).
 *
 * `attempts_exhausted` is a pattern rather than a literal because the sentence
 * interpolates `MAX_RELEVANCE_ATTEMPTS`, which has changed before and may
 * again; matching on the shape keeps old rows recognizable across that.
 */
const LEGACY_EXACT: ReadonlyArray<readonly [string, RelevanceReasonCode]> = [
  ["No research topics or markets are configured.", "no_research_interests"],
];

const LEGACY_ATTEMPTS_EXHAUSTED =
  /^Relevance evaluation failed after \d+ attempts against this Research Profile version\.$/;

export type ResolvedRelevanceReason =
  /** A deterministic reason — render `t()` of this code, never the raw value. */
  | { kind: "code"; code: RelevanceReasonCode }
  /** The model's own explanation — render as-is; it is already written in the
   *  company's analysis language. */
  | { kind: "text"; text: string }
  | null;

export function resolveRelevanceReason(stored: string | null | undefined): ResolvedRelevanceReason {
  const trimmed = (stored ?? "").trim();
  if (trimmed === "") return null;

  if (trimmed.startsWith(RELEVANCE_REASON_CODE_PREFIX)) {
    const code = trimmed.slice(RELEVANCE_REASON_CODE_PREFIX.length);
    if ((RELEVANCE_REASON_CODES as readonly string[]).includes(code)) {
      return { kind: "code", code: code as RelevanceReasonCode };
    }
    // An unknown `code:` token is still not something to show a user — but it
    // is also not something this module can name. Treated as text so the UI
    // degrades to showing SOMETHING truthful rather than an empty section.
    return { kind: "text", text: trimmed };
  }

  for (const [sentence, code] of LEGACY_EXACT) {
    if (trimmed === sentence) return { kind: "code", code };
  }
  if (LEGACY_ATTEMPTS_EXHAUSTED.test(trimmed)) {
    return { kind: "code", code: "attempts_exhausted" };
  }

  return { kind: "text", text: trimmed };
}
