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
 * ── Why a group holds at most one version per channel ───────────────────────
 *
 * A group's versions ARE the card's channel selector, so the selector shows one
 * entry per post — which is only the same thing as one entry per network while
 * the two are in step. They can fall out of step: the grid adds generated posts
 * to its list optimistically, and a topic run picked back up after a reload
 * re-reports channels the server-rendered list already held. A second copy of
 * each post then made a two-channel topic offer "Facebook, Facebook, Instagram,
 * Instagram".
 *
 * The list-level cause is fixed where the list is held — the grid refuses a post
 * it already has — but the invariant belongs here too, because it is a fact
 * about the model rather than about one caller: one topic has one version per
 * network. The database says the same thing from the other side, with uniqueness
 * on (primaryFeedItemId, channel), so a further record for a channel the group
 * already has is never a second version worth choosing between.
 *
 * Keyed by the channel IDENTIFIER, upper-cased, and never by the label a reader
 * sees: the label is a display concern, it is translated in some surfaces, and
 * two identifiers must not merge because their names happen to render alike.
 *
 * Pure, and typed against the narrowest shape it needs, so it can be tested
 * without a database or a rendered component.
 */

import { channelSortIndex } from "./channel-selection";

/**
 * A channel's identity for grouping.
 *
 * `PostItem.channel` arrives upper-cased and the wire spells it lower-case, so
 * the case is normalised rather than trusted — the alternative is a group that
 * offers "facebook" and "FACEBOOK" as two networks.
 */
function channelKey(channel: string): string {
  return channel.toUpperCase();
}

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
  /**
   * The channel versions that actually exist, in canonical channel order — at
   * most one per channel, which is what makes this the card's selector.
   */
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
 *
 * A channel is taken once per group — see the note above. The FIRST record for
 * it wins, which under the caller's newest-first sort is the most recent one.
 */
export function groupPostsByTopic<T extends GroupablePost>(posts: readonly T[]): PostGroup<T>[] {
  const groups: PostGroup<T>[] = [];
  // The channel set rides alongside the group rather than being derived from
  // `posts` on each hit: it is the thing being enforced, and re-scanning a list
  // to ask what is already in it invites the two to disagree.
  const byGroupId = new Map<string, { group: PostGroup<T>; channels: Set<string> }>();

  for (const post of posts) {
    if (post.contentGroupId === null) {
      // Its own card, keyed by the post itself. Two ungrouped posts are never
      // siblings, however much else they have in common — including their
      // channel, so nothing is collapsed here.
      groups.push({ key: `post:${post.id}`, contentGroupId: null, posts: [post] });
      continue;
    }

    const channel = channelKey(post.channel);
    const existing = byGroupId.get(post.contentGroupId);
    if (existing) {
      // This network is already offered by the group. A second entry for it
      // would be an option that says the same word twice.
      if (existing.channels.has(channel)) continue;
      existing.channels.add(channel);
      existing.group.posts.push(post);
      continue;
    }

    const group: PostGroup<T> = {
      key: `group:${post.contentGroupId}`,
      contentGroupId: post.contentGroupId,
      posts: [post],
    };
    byGroupId.set(post.contentGroupId, { group, channels: new Set([channel]) });
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
 *
 * One entry per network, because the group itself holds one version per channel
 * (see the note at the top of this file).
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
