/**
 * Core-message quality heuristic (Phase 1.5) — pure, deterministic, no LLM.
 *
 * Motivation: a Corfu family-travel post was accepted at topSimilarity 0.736
 * because its coreMessage was generic praise ("Corfu is ideal for family
 * holidays..."). Broad, praise-only claims are semantically bland, so distinct
 * generic claims land far apart in embedding space and hide real repetition.
 *
 * This flags a coreMessage as generic when it leans on destination/product
 * praise ("ideal for", "perfect choice", "unforgettable experience", …) WITHOUT
 * a specific, verifiable reason. It is intentionally conservative: a claim that
 * pairs praise with a concrete reason (a number, or a "because"/"thanks to"
 * clause) is NOT flagged, and a claim with no praise language is never flagged.
 *
 * This is NOT an LLM judge and NOT a similarity threshold — it is a cheap
 * lexical guard used to trigger a (fail-safe) regeneration and to surface a
 * calibration signal. Thresholds (0.80 / 0.86) are untouched.
 */

// Generic praise patterns — the phrasing that carried the Corfu example.
const GENERIC_PRAISE_PATTERNS: RegExp[] = [
  /\bideal\s+(?:place|destination|spot|choice|option|for)\b/,
  /\bperfect\s+(?:place|destination|spot|choice|option|for|getaway|escape)\b/,
  /\bunforgettable\s+(?:experience|memories|holiday|vacation|trip|journey)\b/,
  /\bmemories\s+(?:that\s+)?last\s+a\s+lifetime\b/,
  /\bmust[-\s]?(?:visit|see|do)\b/,
  /\b(?:the\s+)?(?:best|top)\s+(?:place|destination|choice|option|spot)\b/,
  /\bgreat\s+(?:choice|option|place|destination)\b/,
  /\bsomething\s+for\s+everyone\b/,
  /\b(?:a\s+)?dream\s+(?:destination|vacation|holiday|getaway)\b/,
  /\bwhether\s+you(?:'re|\s+are)\b.*\bthere(?:'s|\s+is)\s+something\b/,
  /\bworld[-\s]?class\s+(?:experience|destination|service)\b/,
  /\btruly\s+(?:special|unique|unforgettable|magical)\b/,
];

// Signals that a concrete, verifiable reason backs the praise. Their presence
// means the claim is specific enough — praise is grounded, not empty.
const SPECIFIC_REASON_PATTERNS: RegExp[] = [
  /\d/, // any number: distances, counts, prices, ages, durations
  /\b(?:because|since|thanks to|due to|so that|which means|as a result)\b/,
  /\b(?:by|through)\s+\w+ing\b/, // "by offering", "through combining"
];

export interface CoreMessageAssessment {
  generic: boolean;
  /** Human-readable reasons — surfaced in retry prompts and diagnostics. */
  reasons: string[];
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Returns whether the coreMessage is generic praise without a specific reason,
 * plus the reasons why. Empty/whitespace input is treated as generic.
 */
export function assessCoreMessage(coreMessage: string | null | undefined): CoreMessageAssessment {
  const norm = normalize(coreMessage ?? "");
  if (!norm) {
    return { generic: true, reasons: ["empty coreMessage"] };
  }

  const matchedPraise = GENERIC_PRAISE_PATTERNS.filter((re) => re.test(norm));
  if (matchedPraise.length === 0) {
    return { generic: false, reasons: [] };
  }

  const hasReason = SPECIFIC_REASON_PATTERNS.some((re) => re.test(norm));
  if (hasReason) {
    return { generic: false, reasons: [] };
  }

  return {
    generic: true,
    reasons: ["generic praise without a specific, verifiable reason"],
  };
}

/** Convenience boolean wrapper around {@link assessCoreMessage}. */
export function isGenericCoreMessage(coreMessage: string | null | undefined): boolean {
  return assessCoreMessage(coreMessage).generic;
}
