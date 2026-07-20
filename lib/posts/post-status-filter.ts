import type { PostStatusValue } from "./post-actions";

/**
 * The status filter above the posts grid.
 *
 * Four choices deliberately cover seven statuses, because the grid's question is
 * "where is this post in the workflow?" rather than "what is its exact enum
 * value?" — the StatusBadge on each card already answers the second.
 *
 * The groupings are not invented here; each mirrors a boundary the services
 * already draw (see the notes on FILTER_STATUSES below). Nothing in this file
 * introduces a new status constant: PostStatusValue in ./post-actions remains
 * the single client-side list, and it is the compile-time check that every
 * status below is real.
 */

export const POST_STATUS_FILTERS = ["all", "published", "approved", "draft"] as const;

export type PostStatusFilter = (typeof POST_STATUS_FILTERS)[number];

/** What an absent or unrecognized ?status= falls back to. */
export const DEFAULT_POST_STATUS_FILTER: PostStatusFilter = "all";

/** The query-string key this filter reads and writes. */
export const POST_STATUS_PARAM = "status";

const FILTER_STATUSES: Record<Exclude<PostStatusFilter, "all">, readonly PostStatusValue[]> = {
  /**
   * "Successfully published to Buffer" — the same pair that makes a post
   * eligible for metrics (SYNCABLE_STATUSES in
   * lib/services/analytics/sync-post-metrics.service.ts). A post sitting in
   * sent_to_buffer has left the system for good, so grouping it with published
   * matches what an owner means when they ask what went out.
   *
   * FAILED is excluded: publishing was attempted and did not happen.
   */
  published: ["SENT_TO_BUFFER", "PUBLISHED"],

  /** Approved but not yet published — approval granted, nothing sent yet. */
  approved: ["APPROVED"],

  /**
   * PENDING_APPROVAL counts as a draft. The status model treats the two as one
   * bucket wherever the distinction would matter: resolvePostActions reports
   * `approvalPending` for both (approval is still outstanding), and
   * post-editor.service.ts lets both be edited. The difference between them is
   * only who is waiting, which the badge on the card shows.
   *
   * REJECTED is excluded: rejection does not reset the post to draft (see
   * rejectPost), so an owner's decision would otherwise be hidden inside a
   * bucket labelled "work in progress".
   */
  draft: ["DRAFT", "PENDING_APPROVAL"],
};

/**
 * Reads a filter out of a query-string value.
 *
 * Accepts the shape Next.js hands to a page's searchParams (a repeated param
 * arrives as an array). Anything unrecognized — a typo, a stale link, a
 * removed option — falls back to "all" rather than showing an empty grid the
 * user cannot explain.
 */
export function resolvePostStatusFilter(raw: string | string[] | undefined): PostStatusFilter {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return DEFAULT_POST_STATUS_FILTER;

  const normalized = value.trim().toLowerCase();
  return (POST_STATUS_FILTERS as readonly string[]).includes(normalized)
    ? (normalized as PostStatusFilter)
    : DEFAULT_POST_STATUS_FILTER;
}

/** Whether one post belongs in the current view. */
export function matchesPostStatusFilter(status: string, filter: PostStatusFilter): boolean {
  if (filter === "all") return true;
  // PostItem uppercases status on the way out of listPosts; normalizing here
  // means a caller holding a raw Prisma value gets the same answer.
  const normalized = status.trim().toUpperCase();
  return (FILTER_STATUSES[filter] as readonly string[]).includes(normalized);
}

/** Narrows a loaded list. Purely client-side — no refetch, so the grid is instant. */
export function filterPostsByStatus<T extends { status: string }>(
  posts: readonly T[],
  filter: PostStatusFilter
): T[] {
  if (filter === "all") return [...posts];
  return posts.filter((post) => matchesPostStatusFilter(post.status, filter));
}

/**
 * The query string for a given filter, preserving everything else already in
 * the URL.
 *
 * Before Phase 4a the parameter that mattered was `tab=posts`, without which
 * switching filters threw the user back to the overview. Posts is its own route
 * now, but the preservation rule stands: the caller pairs this with the current
 * pathname, and any other parameter on it belongs to someone else.
 */
export function buildPostStatusQuery(
  current: URLSearchParams | string,
  filter: PostStatusFilter
): string {
  const params = new URLSearchParams(current);
  params.set(POST_STATUS_PARAM, filter);
  return params.toString();
}

/**
 * Which empty state the grid should show, if any.
 *
 * "no-posts" and "no-matches" are different messages because they need
 * different answers: the first asks the user to generate a post, the second
 * tells them their filter is hiding the posts they have.
 */
export function resolvePostsEmptyState(
  totalCount: number,
  visibleCount: number
): "no-posts" | "no-matches" | null {
  if (totalCount === 0) return "no-posts";
  if (visibleCount === 0) return "no-matches";
  return null;
}
