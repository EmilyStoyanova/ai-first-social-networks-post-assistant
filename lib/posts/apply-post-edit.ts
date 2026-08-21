/**
 * Fold a saved edit back into the list that owns the posts.
 *
 * The card that hosts the edit modal keeps its own copy of the text while it is
 * mounted, which is what repaints the moment a save returns. That copy is not
 * the list's record, though, and it does not survive a remount — switching the
 * channel-version selector to a sibling and back re-seeds the card from the
 * list, and before this the list still held the pre-edit text, so the edit
 * appeared to roll back. The list is the source of truth for a post between
 * server renders; an edit has to land in it.
 *
 * Kept pure and shared because two grids (`GeneratedPostsSection`,
 * `ChannelPostsSection`) do exactly this and a third surface (the calendar)
 * deliberately does not — it holds no local list and refreshes instead.
 */

/** The slice of a post an edit can touch. `PostItem` satisfies it. */
export interface EditablePost {
  id: string;
  text: string;
  hashtags: string[];
}

export function applyPostEdit<T extends EditablePost>(
  posts: T[],
  id: string,
  content: string,
  hashtags: string[]
): T[] {
  let changed = false;

  const next = posts.map((post) => {
    if (post.id !== id) return post;
    if (post.text === content && sameHashtags(post.hashtags, hashtags)) return post;
    changed = true;
    return { ...post, text: content, hashtags };
  });

  // Same array back when the edit changed nothing — a save that only
  // re-submitted the existing text should not repaint the grid, and neither
  // should an id this list does not hold.
  return changed ? next : posts;
}

/** Order matters here, unlike in the service's audit-log diff: the chips are
 *  drawn in array order, so a reorder is a visible change. */
function sameHashtags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((tag, i) => tag === b[i]);
}
