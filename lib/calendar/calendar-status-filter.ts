/**
 * The calendar's status filter — All Posts / Drafts / Scheduled / Published.
 *
 * Four buckets over seven statuses, and every boundary below is one the services
 * already draw. None of it is invented here.
 *
 *   • **Published** — `sent_to_buffer` + `published`. The same pair as the posts
 *     grid's "published" filter and as SYNCABLE_STATUSES in
 *     sync-post-metrics.service.ts. A post in `sent_to_buffer` has left the
 *     building: `markPostSent` stamps `publishedAt` at the same moment it writes
 *     the status, so on a calendar it has a real date and belongs in the past.
 *
 *   • **Scheduled** — `approved`, and only `approved`. This is the workflow's own
 *     definition, not a guess: `publishCandidateWhere` selects `status:
 *     "approved"` with a non-null `scheduledFor`, so an approved post is exactly
 *     the set of posts the publishing sweep is going to send. Nothing else in the
 *     system is queued for delivery.
 *
 *   • **Drafts** — `draft` + `pending_approval`. Both mean "not approved yet",
 *     which is what makes them one bucket here even though the posts grid splits
 *     them: that grid inherited the retired Approvals tab's job and needs the
 *     approval queue as its own filter, while a calendar is being asked "what is
 *     not yet cleared to go out?".
 *
 *   • Neither — `rejected` and `failed`. `rejected` is excluded for the reason
 *     the posts grid excludes it: rejection does not reset a post to draft, so
 *     burying an owner's decision inside "Drafts" would hide it. `failed` is
 *     excluded because publishing was attempted and did NOT happen — grouping it
 *     with Published would report a post as having gone out when it has not, and
 *     grouping it with Scheduled would promise a delivery that is not coming.
 *     Both still appear under **All Posts**, wearing their own status badge,
 *     which is where a post needing attention should be visible.
 *
 * Pure and free of React, so the mapping is testable and so the calendar and any
 * later caller cannot end up with two versions of it.
 */

import type { PostStatusValue } from "@/lib/posts/post-actions";

export const CALENDAR_STATUS_FILTERS = ["all", "drafts", "scheduled", "published"] as const;

export type CalendarStatusFilter = (typeof CALENDAR_STATUS_FILTERS)[number];

/** What an absent or unrecognized `?status=` falls back to. */
export const DEFAULT_CALENDAR_STATUS_FILTER: CalendarStatusFilter = "all";

/** The query-string key this filter reads and writes. */
export const CALENDAR_STATUS_PARAM = "status";

/**
 * The statuses behind each bucket. Typed as `PostStatusValue[]` so a status that
 * does not exist is a compile error rather than a filter that silently matches
 * nothing.
 */
const FILTER_STATUSES: Record<Exclude<CalendarStatusFilter, "all">, readonly PostStatusValue[]> = {
  drafts: ["DRAFT", "PENDING_APPROVAL"],
  scheduled: ["APPROVED"],
  published: ["SENT_TO_BUFFER", "PUBLISHED"],
};

/** Reads a filter out of a query-string value. */
export function resolveCalendarStatusFilter(
  raw: string | string[] | undefined
): CalendarStatusFilter {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return DEFAULT_CALENDAR_STATUS_FILTER;

  const normalized = value.trim().toLowerCase();
  return (CALENDAR_STATUS_FILTERS as readonly string[]).includes(normalized)
    ? (normalized as CalendarStatusFilter)
    : DEFAULT_CALENDAR_STATUS_FILTER;
}

/** Whether one post belongs in the current view. */
export function matchesCalendarStatusFilter(status: string, filter: CalendarStatusFilter): boolean {
  if (filter === "all") return true;
  // `PostItem` uppercases status on the way out of the service; normalizing here
  // means a caller holding a raw Prisma value gets the same answer.
  const normalized = status.trim().toUpperCase();
  return (FILTER_STATUSES[filter] as readonly string[]).includes(normalized);
}

/** Narrows a loaded list. */
export function filterByCalendarStatus<T extends { status: string }>(
  posts: readonly T[],
  filter: CalendarStatusFilter
): T[] {
  if (filter === "all") return [...posts];
  return posts.filter((post) => matchesCalendarStatusFilter(post.status, filter));
}

/**
 * How many posts each bucket would show, for the count beside its label.
 *
 * Computed from the same predicate the grid uses, so a label can never promise a
 * post the grid then hides.
 */
export function calendarStatusCounts<T extends { status: string }>(
  posts: readonly T[]
): Record<CalendarStatusFilter, number> {
  return Object.fromEntries(
    CALENDAR_STATUS_FILTERS.map((filter) => [filter, filterByCalendarStatus(posts, filter).length])
  ) as Record<CalendarStatusFilter, number>;
}

/**
 * The query string for a filter, preserving the view and anchor already in the
 * URL — changing the filter must not throw the user back to today.
 */
export function buildCalendarStatusQuery(
  current: URLSearchParams | string,
  filter: CalendarStatusFilter
): string {
  const params = new URLSearchParams(current);
  params.set(CALENDAR_STATUS_PARAM, filter);
  return params.toString();
}
