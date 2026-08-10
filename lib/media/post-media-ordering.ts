/**
 * Putting a post's own images at the front of the company gallery.
 *
 * The gallery is a paged company-wide list ordered by date, so an image this post
 * is actually using can sit anywhere in it — including on a page the picker never
 * loaded. Merging rather than sorting is what makes the guarantee hold: the
 * post's assets are prepended from their own source, so they appear first whether
 * or not the loaded page happens to contain them.
 *
 * Order within each group is preserved: the post's images keep their
 * current-then-previous order, and the rest of the gallery keeps the server's.
 */
export function orderGalleryWithPostFirst<T extends { id: string }>(
  postMedia: readonly T[],
  gallery: readonly T[]
): T[] {
  if (postMedia.length === 0) return [...gallery];
  const postIds = new Set(postMedia.map((item) => item.id));
  // Filtered, not just prepended — an asset present in both must not be listed
  // twice, and the post's copy is the one carrying its badge.
  return [...postMedia, ...gallery.filter((item) => !postIds.has(item.id))];
}
