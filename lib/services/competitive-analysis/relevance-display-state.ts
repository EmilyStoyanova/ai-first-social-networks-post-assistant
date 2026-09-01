/**
 * Truthful relevance UI state (2026-09 relevance-UI fix) — pure decision,
 * kept Prisma/React-free so it is directly unit-testable and shared by both
 * the Content list card and the Content detail drawer, mirroring this
 * directory's existing pure-logic modules (`competitor-list-filter.ts`,
 * `research-profile-versioning.ts`).
 *
 * The bug this replaces: the Content UI showed a generic "Not evaluated yet"
 * for every row whose `relevance` was still `pending` — indistinguishable
 * whether that meant "genuinely awaiting the drain," "this company has never
 * saved a Research Profile, so nothing can ever evaluate it," or "relevance
 * was attempted and exhausted its retries" (see
 * `recompute-stale-relevance.service.ts`'s 2026-09 relevance-retry fix for
 * the last case). None of that ambiguity is new schema — every signal this
 * function reads already exists on `CompetitorIntelligence` plus the
 * Research Profile's own `persisted` flag.
 */

export const RELEVANCE_DISPLAY_STATES = [
  "relevant",
  "related",
  "out_of_scope",
  "pending",
  "failed",
  "profile_not_configured",
] as const;

export type RelevanceDisplayState = (typeof RELEVANCE_DISPLAY_STATES)[number];

export interface RelevanceDisplayInput {
  /** The raw `CompetitorIntelligence.relevance` column value. */
  relevance: string;
  /** Non-null on a row that failed to reach a genuine verdict (an
   *  exhausted-retries settle writes a reason while leaving `relevance` at
   *  `pending` — see `recomputeRelevanceForRow`'s module comment) OR a
   *  genuine verdict's own explanation. Both cases keep `relevanceReason`
   *  non-null, but only the FIRST is reachable while `relevance` is still
   *  `pending` — a genuine verdict always moves `relevance` off `pending`,
   *  so checking `relevance === "pending" && relevanceReason` unambiguously
   *  identifies the failed-and-exhausted case, never a real verdict. */
  relevanceReason: string | null;
}

/**
 * `profileConfigured` is the company's Research Profile's `persisted` flag
 * (`ResearchProfileDTO.persisted` — see `get-research-profile-or-defaults.
 * service.ts`), NOT whether a lazy, unsaved default is being shown. Takes
 * priority over every row-level signal: without a saved profile, relevance
 * can never genuinely be computed for ANY row (`recomputeStaleRelevanceForCompany`
 * itself refuses to run at all — see that file's "no persisted profile"
 * guard), so showing a row-specific state here would be misleading.
 */
export function relevanceDisplayState(
  item: RelevanceDisplayInput,
  profileConfigured: boolean
): RelevanceDisplayState {
  if (!profileConfigured) return "profile_not_configured";

  if (
    item.relevance === "relevant" ||
    item.relevance === "related" ||
    item.relevance === "out_of_scope"
  ) {
    return item.relevance;
  }

  // relevance === "pending" from here on. A non-null reason at this point
  // can ONLY be the exhausted-retries settle write — a genuine verdict
  // always moves `relevance` off `pending` in the same write that sets its
  // reason (see recomputeRelevanceForRow's success/out-of-scope branches).
  if (item.relevanceReason) return "failed";

  return "pending";
}
