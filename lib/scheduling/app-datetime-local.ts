/**
 * The app's business time zone, in the two directions scheduling needs it:
 * bridging `<input type="datetime-local">`, and turning "this day at this time"
 * into an instant.
 *
 * Every timestamp in this app renders in `APP_TIME_ZONE` rather than the
 * viewer's own zone, so that a date reads the same for everyone discussing it
 * (see lib/i18n/format-date.ts). A datetime-local input does not follow that
 * rule: its value is a bare wall clock, and the browser's own `new Date(value)`
 * interprets it in whatever zone the viewer happens to be in.
 *
 * Left alone, that means someone in London types 18:30, the app stores 18:30
 * UTC, and the card they are looking at immediately reads it back as 21:30. The
 * two functions here close that gap: the input always shows and always means
 * business-zone wall clock, exactly like the text beside it.
 *
 * Pure, with no React in it, so the conversion can be tested directly — the
 * awkward cases (a DST boundary, a viewer in a different zone) are not ones to
 * discover by clicking.
 */

import { APP_TIME_ZONE } from "@/lib/i18n/format-date";

/** Reads an instant's wall-clock parts as they appear in the business zone. */
const partsFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: APP_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function wallClockPartsAt(utcMs: number): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const part of partsFormatter.formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  // "24" for midnight is legal ICU output in an hour-cycle-23 formatter on some
  // runtimes; normalising it here keeps the arithmetic below honest.
  if (parts.hour === "24") parts.hour = "00";
  return parts;
}

/**
 * How far ahead of UTC the business zone is at a given instant, in ms.
 *
 * Derived by formatting the instant into the zone and reading those wall-clock
 * parts back as if they were UTC — the difference is the offset. This is the
 * only way to get it without a tz database of our own, and it stays correct
 * across DST because it asks about one specific instant.
 */
function zoneOffsetMsAt(utcMs: number): number {
  const p = wallClockPartsAt(utcMs);
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second)
  );
  // Millisecond precision is lost by the formatter; add it back so the offset is
  // a whole-minute quantity rather than being skewed by the instant's own ms.
  return asUtc - (utcMs - (utcMs % 1000));
}

/**
 * An instant → the `YYYY-MM-DDTHH:mm` a datetime-local input should show for it,
 * in business-zone wall clock. Empty string for anything unparseable, which is
 * what an input wants for "no value".
 */
export function toAppDateTimeLocal(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const p = wallClockPartsAt(date.getTime());
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/**
 * A datetime-local value, read as business-zone wall clock → the ISO instant it
 * names. Null when the value is not a usable date.
 *
 * Solved by iteration rather than algebra: the offset that applies depends on
 * the instant, and the instant is what we are trying to find. One correction
 * settles it everywhere except inside a DST transition, and the second pass
 * covers that — a wall clock in the skipped hour has no true instant, and this
 * resolves it forward rather than throwing.
 */
export function fromAppDateTimeLocal(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return null;

  const asUtc = Date.parse(`${value.length === 16 ? `${value}:00` : value}Z`);
  if (Number.isNaN(asUtc)) return null;

  let utcMs = asUtc - zoneOffsetMsAt(asUtc);
  utcMs = asUtc - zoneOffsetMsAt(utcMs);

  return new Date(utcMs).toISOString();
}

// ─── Scheduling ────────────────────────────────────────────────────────────────
//
// The same conversion, for code that is placing a post on a calendar rather than
// filling in an input. A channel configured to publish at 18:30 means 18:30 on
// the clock the company reads — so the instant that names depends on the UTC
// offset Sofia is on that week, and cannot be assembled with `setUTCHours`.

/** Two-digit, for building a wall-clock string. */
function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * A calendar day (`YYYY-MM-DD`) plus a wall-clock time, both read in the
 * business zone → the instant they name.
 *
 * Null when the day or the time is not a real one. Callers get to decide what
 * that means: `ChannelConfig.postingWindows` is shape-checked but never
 * range-checked, so a stored `"25:00"` has to land somewhere deliberate rather
 * than rolling over into the following day.
 */
export function appZoneInstant(day: string, hour: number, minute: number): Date | null {
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  // A well-formed day that does not exist (`2026-02-30`) parses, by rolling over
  // into the next month — which would put the post on a date nobody chose. The
  // round trip is what catches it.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const midnight = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== day) return null;

  const iso = fromAppDateTimeLocal(`${day}T${pad2(hour)}:${pad2(minute)}`);
  return iso === null ? null : new Date(iso);
}

/** The business-zone wall clock an instant shows. Null for an unusable date. */
export function appZoneClock(value: Date): { day: string; hour: number; minute: number } | null {
  const local = toAppDateTimeLocal(value);
  if (local === "") return null;

  return {
    day: local.slice(0, 10),
    hour: Number(local.slice(11, 13)),
    minute: Number(local.slice(14, 16)),
  };
}

/**
 * The calendar day it currently is in the business zone, as `YYYY-MM-DD`.
 *
 * "Today" for a form offering publishing dates has to be today where the company
 * is, not today in UTC — the two disagree for three hours every evening, and
 * that is exactly when someone scheduling for "tomorrow" would otherwise be
 * offered a date that is already gone.
 */
export function appZoneToday(now: Date): string {
  return toAppDateTimeLocal(now).slice(0, 10);
}
