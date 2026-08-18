/**
 * Putting a post on a day.
 *
 * ── Which instant a post is drawn at ────────────────────────────────────────
 *
 * `publishedAt ?? scheduledFor`, and the order matters more than it looks.
 *
 *   • `publishedAt` is stamped by `markPostSent` at the moment a post actually
 *     reaches Buffer. For anything already out, that is the only honest date: a
 *     post approved for 09:00 and sent by the 09:20 sweep belongs at 09:20, and
 *     one published on demand from its card has no `scheduledFor` at all — under
 *     a `scheduledFor`-first rule it would vanish from the calendar entirely.
 *
 *   • `scheduledFor` is when a post is DUE, which is the only date an unpublished
 *     post has. It carries two different promises (a hand-picked time the sweep
 *     honours exactly, versus the weekly filler's estimate — see
 *     `Post.manuallyScheduled` and lib/scheduling/publish-window.ts), but both
 *     are the time the post is planned for, and planning is what a calendar
 *     shows. The card the user opens says which of the two it is.
 *
 * A post with neither is genuinely undated — an unscheduled draft. It is not
 * placed anywhere, because there is no cell it belongs in, and a calendar that
 * guessed one would be showing a plan nobody made. (The windowed read never
 * returns such a post in the first place; `placePost` still answers for it,
 * because the rule belongs with the placement rather than with the query.)
 *
 * ── Which DAY that instant falls on ─────────────────────────────────────────
 *
 * The business zone's, via `appZoneClock`, exactly like every timestamp the app
 * renders (lib/i18n/format-date.ts). Nothing here reads the viewer's clock, so a
 * post at 23:30 Sofia time sits on the same day for a reader in London as it
 * does for the company that scheduled it — and the answer does not change
 * between the server render and hydration.
 *
 * Pure: no Prisma, no React, no ambient `now`.
 */

import { appZoneClock } from "@/lib/scheduling/app-datetime-local";

/** The post fields a calendar placement needs. */
export interface PlaceablePost {
  scheduledFor: string | null;
  publishedAt: string | null;
}

export interface CalendarEntry<T> {
  post: T;
  /** The business-zone day it is drawn on, `YYYY-MM-DD`. */
  day: string;
  /** Business-zone wall clock, `HH:mm` — what the chip in the cell shows. */
  time: string;
  /** The instant itself, ISO, for ordering within a day. */
  instant: string;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * The instant a post is drawn at, or null when it has none.
 *
 * Exported because "is this post datable at all?" is the question the undated
 * count is built from, and answering it twice in two places is how the count and
 * the grid start disagreeing.
 */
export function calendarInstant(post: PlaceablePost): Date | null {
  const raw = post.publishedAt ?? post.scheduledFor;
  if (raw === null) return null;

  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** One post as a placed entry, or null when it has no date to be placed by. */
export function placePost<T extends PlaceablePost>(post: T): CalendarEntry<T> | null {
  const instant = calendarInstant(post);
  if (instant === null) return null;

  const clock = appZoneClock(instant);
  if (clock === null) return null;

  return {
    post,
    day: clock.day,
    time: `${pad2(clock.hour)}:${pad2(clock.minute)}`,
    instant: instant.toISOString(),
  };
}

/**
 * Every post that has a date, placed and ordered by instant.
 *
 * Sorted globally rather than per day so the order inside a cell is settled once
 * — `groupEntriesByDay` preserves it, and a cell showing "09:00, 14:30, 11:15"
 * would read as a bug whatever the underlying query order was.
 */
export function placePosts<T extends PlaceablePost>(posts: readonly T[]): CalendarEntry<T>[] {
  return posts
    .map(placePost)
    .filter((entry): entry is CalendarEntry<T> => entry !== null)
    .sort((a, b) => a.instant.localeCompare(b.instant));
}

/**
 * The entries that fall inside the visible grid.
 *
 * Needed even though the query is already windowed: the window is fetched on
 * `scheduledFor` OR `publishedAt`, so a post scheduled inside the window but
 * published outside it comes back and then places itself on a day the grid does
 * not draw. Filtering on the RESOLVED day is the only way the two can agree.
 */
export function entriesWithinDays<T>(
  entries: readonly CalendarEntry<T>[],
  days: readonly string[]
): CalendarEntry<T>[] {
  const visible = new Set(days);
  return entries.filter((entry) => visible.has(entry.day));
}

/**
 * Entries bucketed by day, in the grid's order.
 *
 * Every visible day gets a key, including the empty ones — a cell with no posts
 * is a fact the grid draws, not a lookup that should come back undefined.
 */
export function groupEntriesByDay<T>(
  entries: readonly CalendarEntry<T>[],
  days: readonly string[]
): Map<string, CalendarEntry<T>[]> {
  const byDay = new Map<string, CalendarEntry<T>[]>();
  for (const day of days) byDay.set(day, []);

  for (const entry of entries) {
    byDay.get(entry.day)?.push(entry);
  }

  return byDay;
}
