/**
 * Pure mirror of `competitor_social_items`'s dedup unique index —
 * `@@unique([socialProfileId, externalItemId])` — kept here so a future
 * Part 3C sync service (and this schema foundation's tests) have one
 * documented, testable definition of "do these two collection attempts
 * refer to the same item" ahead of that service ever existing.
 *
 * A NULL `externalItemId` never collides with anything, mirroring Postgres:
 * NULLs are distinct in a unique index, so a sync method that cannot surface
 * a stable platform id gets no dedup guarantee from the database — that is a
 * property of the schema, not a bug, and this function makes it explicit
 * rather than silently "working" only by accident of how a caller happens to
 * compare rows.
 */
export function socialItemDedupKey(
  socialProfileId: string,
  externalItemId: string | null
): string | null {
  if (externalItemId === null) return null;
  return `${socialProfileId}:${externalItemId}`;
}

/** Whether two collection attempts are the SAME item, per the dedup index. */
export function isSameSocialItem(
  a: { socialProfileId: string; externalItemId: string | null },
  b: { socialProfileId: string; externalItemId: string | null }
): boolean {
  const keyA = socialItemDedupKey(a.socialProfileId, a.externalItemId);
  const keyB = socialItemDedupKey(b.socialProfileId, b.externalItemId);
  // Two null-externalItemId attempts are never "the same item" — a null key
  // never matches, even itself, mirroring NULL <> NULL in SQL.
  if (keyA === null || keyB === null) return false;
  return keyA === keyB;
}
