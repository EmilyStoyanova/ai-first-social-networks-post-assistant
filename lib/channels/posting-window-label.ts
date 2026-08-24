/**
 * Turning a channel's saved posting windows into the lines a person reads.
 *
 * Lives apart from the card that renders it for one reason: this is the only
 * place an owner can check what they configured without entering edit mode, and
 * "the schedule I saved is displayed correctly" is a claim worth testing. A
 * component that formats inline can only be checked by looking at it.
 *
 * The day NAME is localised, the time is not — `09:00–17:00` reads the same in
 * both locales and matches what the editor's textarea holds. The editor keeps
 * speaking the stored `MONDAY` tokens; only this display side translates them.
 *
 * Pure: no React, no next-intl. The caller passes a lookup, which in the app is
 * next-intl's `t` and in tests is a plain function.
 */

import type { PostingWindow } from "@/lib/services/company/list-channel-configs.service";

/**
 * Resolves a stored day token (`"MONDAY"`) to its label in the reader's locale.
 * Returning the token unchanged is the correct answer for one this locale has no
 * name for — better a recognisable `MONDAY` than a thrown missing-message.
 */
export type DayLabel = (day: string) => string;

/** En dash: a range, matching how times are shown everywhere else in the app. */
const RANGE_SEPARATOR = "–";

/** One window as a single line, e.g. `Понеделник 09:00–17:00`. */
export function formatPostingWindow(window: PostingWindow, dayLabel: DayLabel): string {
  return `${dayLabel(window.day)} ${window.start}${RANGE_SEPARATOR}${window.end}`;
}

/**
 * Every saved window as its own line, in the order it was saved.
 *
 * Saved order, not sorted: the textarea is authored line by line and reading the
 * card back in a different order than it was typed reads as a different
 * schedule. An empty list yields no lines at all — the caller renders nothing
 * rather than a "not set" placeholder, because a channel with no windows takes
 * no part in automatic generation and has no schedule to display.
 */
export function postingWindowLines(
  windows: readonly PostingWindow[],
  dayLabel: DayLabel
): string[] {
  return windows.map((window) => formatPostingWindow(window, dayLabel));
}
