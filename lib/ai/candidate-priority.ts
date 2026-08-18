/**
 * Priority ordering of generation candidates.
 *
 * The company's topic priorities decide the ORDER articles are offered to
 * generation in, and nothing else. This module is the pure half of that: the
 * tiers, the ordering, and the diagnostic that explains an outcome.
 *
 * Two boundaries are load-bearing, and both are about what priority is NOT:
 *
 *   • **Priority orders; it never grants eligibility.** Every existing filter —
 *     `enabled`, `usedInPost`, the enabled source, the scoped source window, the
 *     atomic reservation, the semantic/Jaccard gates — runs exactly as before and
 *     is applied FIRST. This only decides which of the already-eligible articles
 *     is offered first. A HIGH article that is disabled, consumed, or reserved is
 *     simply not in the list to be ordered.
 *
 *   • **A missing verdict is not a rejection.** `null` covers an unconfigured
 *     company, an article still queued, and one whose classification failed. All
 *     three stay eligible, ranked after MEDIUM.
 *
 * REJECTED is the exception to both: it is not ordered last, it is not offered at
 * all. That holds for EVERY generation path — cron, bulk, the manual form and the
 * prompt preview alike. There was once a carve-out for user-driven runs, on the
 * reasoning that a person who picks a source has made a choice; it was removed
 * deliberately. The choice a person makes is which SOURCE to draw from, and the
 * company's own topic rules are what decide which of that source's articles are
 * worth writing about — so honouring the verdict is honouring the choice, not
 * overruling it. There is no flag here to turn any of this off.
 */

import type { Classification } from "./feed-item-classification";

/**
 * Rank order. Lower sorts first.
 *
 * `unclassified` sits last rather than first because it is genuinely unknown: it
 * may turn out to be REJECTED once the drain reaches it. Ranking it behind MEDIUM
 * means a company with real verdicts prefers what it has actually asked for,
 * while a company with none (every row null) is left in a single tier and keeps
 * its pre-existing recency order untouched.
 */
export const CANDIDATE_TIERS = ["high", "medium", "unclassified"] as const;
export type CandidateTier = (typeof CANDIDATE_TIERS)[number];

export function tierOf(classification: string | null | undefined): CandidateTier | "rejected" {
  if (classification === "HIGH") return "high";
  if (classification === "MEDIUM") return "medium";
  if (classification === "REJECTED") return "rejected";
  return "unclassified";
}

/**
 * The tiers a generation queries, in the order it queries them.
 *
 * REJECTED is absent, and its absence IS the exclusion — there is no `NOT`
 * filter anywhere that a later edit could weaken without noticing. Exported so
 * that claim is a test rather than a comment.
 *
 * This is the ONE definition. The classification list and the eligibility
 * fragment below are both derived from it, so a fifth verdict or a reordering can
 * only ever be written once.
 */
export const PRIORITY_TIER_FILTERS: ReadonlyArray<{
  tier: CandidateTier;
  where: { classification: Classification | null };
}> = [
  { tier: "high", where: { classification: "HIGH" } },
  { tier: "medium", where: { classification: "MEDIUM" } },
  // Unconfigured company, still queued, or a failed classification — all
  // eligible, all ranked last.
  { tier: "unclassified", where: { classification: null } },
];

/** The classification values any generation may draw from. Derived, never typed twice. */
export const GENERATION_CANDIDATE_CLASSIFICATIONS: ReadonlyArray<Classification | null> =
  PRIORITY_TIER_FILTERS.map((t) => t.where.classification);

/**
 * "Any tier generation may draw from", as one `where` fragment — for the callers
 * that ask a yes/no question about the same population rather than drawing an
 * ordered window from it (today: the manual source dropdown's availability
 * check).
 *
 * Written as an OR of equalities, one per tier, rather than as
 * `{ not: "REJECTED" }` or `{ in: [...] }`. Both of those are traps on a nullable
 * column — Prisma's `in` never matches NULL, so the unclassified tier would
 * silently vanish and every un-drained article would read as unavailable. An
 * explicit `null` branch cannot go wrong that way. It is also the same shape as
 * the tiered fetch: REJECTED is excluded by not being named, not by a negation.
 */
export function eligibleClassificationWhere(): {
  OR: Array<{ classification: Classification | null }>;
} {
  return { OR: PRIORITY_TIER_FILTERS.map(({ where }) => ({ ...where })) };
}

/**
 * Composes each tier onto the caller's eligibility filter.
 *
 * The base is spread FIRST so a tier can only ever narrow it. That ordering is
 * what guarantees priority cannot grant eligibility: `enabled`, `usedInPost`, the
 * source scope and every other existing rule survive into all three queries, so a
 * disabled or already-consumed HIGH article is absent from the HIGH tier rather
 * than blocking the MEDIUM one.
 */
export function priorityTierWheres(
  base: Record<string, unknown>
): Array<{ tier: CandidateTier; where: Record<string, unknown> }> {
  return PRIORITY_TIER_FILTERS.map(({ tier, where }) => ({ tier, where: { ...base, ...where } }));
}

/**
 * Why a generation ended up where it did — the answer to "why a MEDIUM article
 * when HIGH ones exist?".
 *
 * Counted from rows the pipeline has already looked at, so it costs one extra
 * `groupBy` per generation rather than a second candidate query. Deliberately
 * counts, not ids: the point is to make a run explicable in a log line, not to
 * reproduce the whole feed in it.
 */
export interface PriorityDiagnostic {
  /** Eligible candidates offered, by tier — the window generation actually saw. */
  offered: Record<CandidateTier, number>;
  /**
   * HIGH articles this company has that were NOT offered, by the rule that
   * withheld them. This is the part that answers the question: a run that used a
   * MEDIUM article while `withheldHigh.used = 4` was not ignoring priority.
   */
  withheldHigh: {
    /** Already written from — one-post-per-article. */
    used: number;
    /** Manually switched off by a person. Authoritative over any verdict. */
    disabled: number;
    /** Its content source is switched off. */
    sourceDisabled: number;
  };
  /** The tier the article this run actually claimed came from, once known. */
  selected?: CandidateTier;
}

export function emptyPriorityDiagnostic(): PriorityDiagnostic {
  return {
    offered: { high: 0, medium: 0, unclassified: 0 },
    withheldHigh: { used: 0, disabled: 0, sourceDisabled: 0 },
  };
}

/** Tallies an offered window into the diagnostic's `offered` counts. */
export function countOffered(
  items: ReadonlyArray<{ classification?: string | null }>
): Record<CandidateTier, number> {
  const offered: Record<CandidateTier, number> = { high: 0, medium: 0, unclassified: 0 };
  for (const item of items) {
    const tier = tierOf(item.classification);
    // A REJECTED row should never reach here — the query excludes it — but if one
    // ever did, it must not be silently counted as something it is not.
    if (tier !== "rejected") offered[tier] += 1;
  }
  return offered;
}

/**
 * Orders an already-eligible window by priority, then by the pre-existing
 * recency order WITHIN each tier.
 *
 * Stable: `Array.prototype.sort` is stable in every supported runtime, so items
 * of the same tier keep the order the query returned them in — which is the
 * existing `publishedAt desc, createdAt desc`. That is what makes this purely
 * additive: strip the verdicts (or give a company none) and the result is exactly
 * the order generation used before this feature existed.
 */
export function orderByPriority<T extends { classification?: string | null }>(
  items: readonly T[]
): T[] {
  const rank = (item: T): number => {
    const tier = tierOf(item.classification);
    // A rejected row sorts last as a defensive backstop; the query excludes it.
    return tier === "rejected" ? CANDIDATE_TIERS.length : CANDIDATE_TIERS.indexOf(tier);
  };
  return [...items].sort((a, b) => rank(a) - rank(b));
}

/**
 * The one-line summary a generation logs.
 *
 * Reads as a sentence on purpose — this is the thing an operator greps for when
 * asked why a run picked what it picked.
 */
export function describePrioritySelection(diagnostic: PriorityDiagnostic): string {
  const { offered, withheldHigh, selected } = diagnostic;
  const withheld =
    withheldHigh.used + withheldHigh.disabled + withheldHigh.sourceDisabled === 0
      ? "none withheld"
      : `withheld HIGH: ${withheldHigh.used} used, ${withheldHigh.disabled} disabled, ${withheldHigh.sourceDisabled} source off`;
  return `offered high=${offered.high} medium=${offered.medium} unclassified=${offered.unclassified}; ${withheld}${
    selected ? `; selected from ${selected}` : ""
  }`;
}
