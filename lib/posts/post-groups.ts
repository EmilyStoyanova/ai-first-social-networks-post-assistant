/**
 * Collapsing a post list into content topics.
 *
 * One topic written for three channels is three independent `Post` records —
 * three texts, three images, three schedules, three approval decisions — and
 * they must stay that way. What changes is only how they are PRESENTED: as one
 * card with a channel selector, rather than as three near-identical cards the
 * reader has to notice are the same story.
 *
 * ── Why `contentGroupId` and not `generationBatchId` ────────────────────────
 *
 * They answer different questions. A batch is "these posts were made by one
 * click" — a run of five topics across three channels shares ONE batch id across
 * all fifteen posts, so grouping by it would fold the whole run into a single
 * card. A content group is "these posts are the same topic", which is exactly
 * the question this module asks.
 *
 * ── Why a null group is not a group ─────────────────────────────────────────
 *
 * Every post written before this feature has `contentGroupId = null`, as does
 * every post cron writes. Null is the absence of a topic, not a topic they share:
 * treating it as a key would collapse a company's entire back catalogue into one
 * card. So each ungrouped post becomes a group of one, and renders exactly as it
 * always has.
 *
 * Pure, and typed against the narrowest shape it needs, so it can be tested
 * without a database or a rendered component.
 */

import { channelSortIndex } from "./channel-selection";

/** The only fields grouping depends on — `PostItem` satisfies it structurally. */
export interface GroupablePost {
  id: string;
  channel: string;
  contentGroupId: string | null;
}

export interface PostGroup<T extends GroupablePost> {
  /**
   * React key and stable identity for the card.
   *
   * Prefixed by kind, because a content-group id and a post id are both uuids
   * drawn from the same space: without the prefix a group could in principle
   * collide with an unrelated ungrouped post and the two would share a card.
   */
  key: string;
  /** Null for an ungrouped post — the card then behaves exactly as before. */
  contentGroupId: string | null;
  /** The channel versions that actually exist, in canonical channel order. */
  posts: T[];
}

/**
 * The posts, as topics.
 *
 * Groups appear in the order their FIRST post appears in the input, so the
 * caller's sort — newest first, everywhere this is used — still decides where a
 * topic sits in the grid. Sorting groups by anything of their own would quietly
 * reorder the page.
 *
 * Within a group the versions are ordered by channel rather than by creation, so
 * the dropdown reads Facebook, LinkedIn, Instagram, TikTok on every card
 * regardless of which channel the generator happened to write first.
 */
export function groupPostsByTopic<T extends GroupablePost>(posts: readonly T[]): PostGroup<T>[] {
  const groups: PostGroup<T>[] = [];
  const byGroupId = new Map<string, PostGroup<T>>();

  for (const post of posts) {
    if (post.contentGroupId === null) {
      // Its own card, keyed by the post itself. Two ungrouped posts are never
      // siblings, however much else they have in common.
      groups.push({ key: `post:${post.id}`, contentGroupId: null, posts: [post] });
      continue;
    }

    const existing = byGroupId.get(post.contentGroupId);
    if (existing) {
      existing.posts.push(post);
      continue;
    }

    const group: PostGroup<T> = {
      key: `group:${post.contentGroupId}`,
      contentGroupId: post.contentGroupId,
      posts: [post],
    };
    byGroupId.set(post.contentGroupId, group);
    groups.push(group);
  }

  // Sorted once at the end rather than on insert: a group is small (at most one
  // post per channel) and this keeps the traversal above a single pass.
  for (const group of groups) {
    if (group.posts.length > 1) {
      group.posts.sort((a, b) => channelSortIndex(a.channel) - channelSortIndex(b.channel));
    }
  }

  return groups;
}

/**
 * Which version of a group the card is showing.
 *
 * Falls back to the first version whenever the remembered id is not in the group
 * — which is not an edge case but the ordinary consequence of deleting a
 * sibling, or of a filter hiding the version that was selected. Returning a post
 * unconditionally (rather than null) is what lets the card render without a
 * "nothing selected" state it would otherwise need everywhere.
 *
 * Callers must never render a group with no posts; `groupPostsByTopic` cannot
 * produce one, and a group whose last post is deleted is removed rather than
 * emptied.
 */
export function selectGroupPost<T extends GroupablePost>(
  group: PostGroup<T>,
  selectedId: string | null
): T {
  if (selectedId !== null) {
    const chosen = group.posts.find((p) => p.id === selectedId);
    if (chosen) return chosen;
  }
  return group.posts[0];
}

/**
 * The channel versions this group can switch between.
 *
 * Only the posts that EXIST. A topic whose LinkedIn generation failed has no
 * LinkedIn record, so LinkedIn is not offered — an option that selected nothing
 * would be a broken control, and the failure itself is reported by the batch
 * summary, which is where a failure belongs.
 */
export function groupChannelVersions<T extends GroupablePost>(
  group: PostGroup<T>
): Array<{ id: string; channel: string }> {
  return group.posts.map((p) => ({ id: p.id, channel: p.channel }));
}

/**
 * The group after one of its posts is deleted, or null when that was the last
 * one and the card should disappear.
 *
 * Separated from the list-level removal so the two behaviours this feature
 * promises are stated in one place and can be tested directly: deleting one
 * channel version keeps the topic, deleting the final version removes it.
 */
export function removePostFromGroup<T extends GroupablePost>(
  group: PostGroup<T>,
  postId: string
): PostGroup<T> | null {
  const posts = group.posts.filter((p) => p.id !== postId);
  if (posts.length === 0) return null;
  return { ...group, posts };
}
