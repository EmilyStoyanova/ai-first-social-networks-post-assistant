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
