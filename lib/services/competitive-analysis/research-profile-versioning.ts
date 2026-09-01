/**
 * Pure logic for the Research Profile's default-computation and versioning
 * rules (§3.2/§3.6 of the approved plan) — kept Prisma-free so both are
 * directly unit-testable, mirroring `lib/scheduling/content-mix.ts`'s split.
 */

/** researchTopics default when no profile row exists yet: Brand Guidelines'
 *  top + medium priority topics, or `[]` when Brand Guidelines has none. The
 *  module must still work with nothing configured. */
export function defaultResearchTopicsFromBrand(
  brand: { topPriorityTopics: string[]; mediumPriorityTopics: string[] } | null
): string[] {
  if (!brand) return [];
  return [...brand.topPriorityTopics, ...brand.mediumPriorityTopics];
}

/** Order-independent equality — a reordered list is not a content change. */
export function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}

/**
 * `profileVersion` starts at 1 and increments ONLY when `researchTopics` or
 * `markets` actually changed — never for an `analysisPeriodDays`-only save.
 * `existing` is null on the first-ever Save (no row yet), which always yields
 * version 1 regardless of what is being saved.
 */
export function computeNextProfileVersion(
  existing: { researchTopics: string[]; markets: string[]; profileVersion: number } | null,
  next: { researchTopics: string[]; markets: string[] }
): number {
  if (!existing) return 1;
  const contentChanged =
    !sameStringSet(existing.researchTopics, next.researchTopics) ||
    !sameStringSet(existing.markets, next.markets);
  return contentChanged ? existing.profileVersion + 1 : existing.profileVersion;
}

/** True only when a save actually moved `profileVersion` on an EXISTING row —
 *  never for a first-ever save (there is no prior version to move away from)
 *  and never for a period-only save. Exists as its own function so
 *  `shouldRecomputeRelevanceOnSave` can state its two conditions
 *  (`isFirstSave || versionBumped`) as two independently-named, independently
 *  testable facts rather than one inlined boolean expression. */
export function versionWasBumped(
  existing: { profileVersion: number } | null,
  nextVersion: number
): boolean {
  return existing !== null && nextVersion !== existing.profileVersion;
}

/**
 * Whether a Research Profile save should trigger the bounded relevance
 * recompute drain (`recompute-stale-relevance.service.ts`) — verification
 * pass §1.
 *
 * True on the FIRST-EVER save (`existing === null`), not just on a later
 * version bump. Before this row is ever persisted, `recomputeStaleRelevanceForCompany`
 * refuses to run at all (it returns immediately when no profile row exists —
 * see that service's own guard), so any competitor content already extracted
 * while unpersisted sits at `relevance: pending, relevanceProfileVersion:
 * null` with NOTHING ever triggering its first relevance computation unless
 * something recognizes that the row now exists. Relying on `versionBumped`
 * alone misses this: on a first save `existing` is null, so `versionBumped`
 * is unconditionally false by its own definition above — not a coincidence
 * this function has to work around, but the exact bug this pass found.
 *
 * This is also why NO version sentinel (e.g. a non-persisted "version 0" for
 * unsaved Brand-derived defaults) is needed: relevance is NEVER computed
 * before this row is persisted (there is no code path that does), so the
 * first save's `profileVersion` — always 1, per `computeNextProfileVersion`
 * — is the ONLY version any of that backlog is ever judged against. A
 * sentinel would be solving a collision that cannot occur under the current
 * one-row-per-company, recompute-only-after-persistence design.
 */
export function shouldRecomputeRelevanceOnSave(
  existing: { profileVersion: number } | null,
  versionBumped: boolean
): boolean {
  return existing === null || versionBumped;
}
