"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { CalendarDays } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { StatusBadge, type PostStatusValue } from "@/components/ui/StatusBadge";
import { ChannelChip, type ChannelValue } from "@/components/ui/ChannelChip";
import { GeneratedPostCard } from "./generated-post-card";
import { groupEntriesByDay, type CalendarEntry } from "@/lib/calendar/calendar-entries";
import { isSameMonth, type CalendarView } from "@/lib/calendar/calendar-range";
import { dateLocaleFor, formatWeekdayShort } from "@/lib/i18n/format-date";
import type { PostItem } from "@/lib/services/company/list-posts.service";
import type { PostRole } from "@/lib/posts/post-actions";

/** How many posts a MONTH cell shows before collapsing the rest behind "+N more". */
const MONTH_CELL_LIMIT = 2;

/** How much post text a chip carries. Longer than any cell can draw, and short
 *  enough that a month of posts is not a page of prose in the DOM. */
const PREVIEW_CHARS = 120;

interface Props {
  slug: string;
  view: CalendarView;
  /** Every cell the grid draws, in order — from `buildCalendarRange`. */
  days: string[];
  /** The anchor day, which decides what counts as "this month" in month view. */
  anchor: string;
  /** Business-zone today, for the highlighted cell. */
  today: string;
  /** Already narrowed to the channel scope, the status filter, and these days. */
  entries: CalendarEntry<PostItem>[];
  role: PostRole;
  canDelete: boolean;
  bufferConnected: boolean;
  /** Offers the generation-trace action on the opened card. Admin-only. */
  isGlobalAdmin?: boolean;
}

/** Midday UTC — see the note in calendar-toolbar.tsx. */
function middayOf(day: string): string {
  return `${day}T12:00:00.000Z`;
}

/** The first line or so of a post, with the newlines flattened out. */
function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat;
}

function asChannelValue(channel: string): ChannelValue | null {
  const lower = channel.toLowerCase();
  return lower === "facebook" || lower === "linkedin" || lower === "instagram" || lower === "tiktok"
    ? lower
    : null;
}

/**
 * The month/week grid, and the post it opens.
 *
 * A client component for exactly one reason: opening a post. Everything else —
 * which days are drawn, which posts are on them, which filter is applied — is
 * decided on the server and arrives as props, so this file holds no data logic
 * at all and cannot drift from the pure modules that do (lib/calendar/*).
 *
 * Clicking a post opens the REAL `GeneratedPostCard` in a modal rather than a
 * calendar-shaped copy of it. That card already owns editing, approval,
 * rejection, scheduling, publishing, image handling and the activity log, and
 * every one of those is a behaviour a second implementation would eventually get
 * subtly wrong. The calendar's whole job is deciding WHICH post to show it.
 */
export function PostCalendar({
  slug,
  view,
  days,
  anchor,
  today,
  entries,
  role,
  canDelete,
  bufferConnected,
  isGlobalAdmin = false,
}: Props) {
  const t = useTranslations("planner.calendar");
  const router = useRouter();
  const locale = dateLocaleFor(useLocale());

  const [openPostId, setOpenPostId] = useState<string | null>(null);
  const [expandedDays, setExpandedDays] = useState<ReadonlySet<string>>(new Set());

  const byDay = useMemo(() => groupEntriesByDay(entries, days), [entries, days]);

  const openEntry = entries.find((entry) => entry.post.id === openPostId) ?? null;

  // The weekday headings, read off the first seven cells — always a Monday-to-
  // Sunday run, so they are correct for both views and for either locale without
  // a hard-coded list of names.
  const weekdays = days.slice(0, 7).map((day) => formatWeekdayShort(middayOf(day), locale));

  function toggleExpanded(day: string) {
    setExpandedDays((prev) => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
  }

  /** A post changed underneath us — re-read the period so the grid agrees. */
  function handleChanged() {
    router.refresh();
  }

  /**
   * A post was edited in the modal.
   *
   * `router.refresh()` rather than a local patch, because this component
   * deliberately holds no post state at all — `entries` is decided on the server
   * and every cell chip draws `entry.post.text` straight from it. Refreshing IS
   * updating the source of truth here; patching would mean introducing the local
   * copy this file exists to avoid.
   *
   * The write has already committed by the time this runs, so the refresh brings
   * back the edited text, and the open card is showing that same text from its
   * own state in the meantime — there is no window in which the old value
   * returns.
   */
  function handleEdited() {
    router.refresh();
  }

  function handleDeleted() {
    setOpenPostId(null);
    router.refresh();
  }

  if (entries.length === 0) {
    return (
      <EmptyState
        icon={<CalendarDays className="h-5 w-5" />}
        title={t("emptyTitle")}
        description={t("emptyDesc")}
      />
    );
  }

  const isMonth = view === "month";

  return (
    <div className="space-y-3">
      {/* A month is always seven columns; on a narrow screen it scrolls rather
          than collapsing, because a month laid out as one long column stops
          being a month. A week collapses to a readable stack instead. */}
      <div className={isMonth ? "overflow-x-auto" : ""}>
        <div className={isMonth ? "min-w-[1000px]" : ""}>
          <div
            className={[
              "text-fg-faint mb-1 grid grid-cols-7 gap-2 text-xs font-semibold tracking-wide uppercase",
              isMonth ? "" : "hidden md:grid",
            ].join(" ")}
            aria-hidden="true"
          >
            {weekdays.map((label, index) => (
              <span key={index} className="px-1">
                {label}
              </span>
            ))}
          </div>

          <div
            className={["grid gap-2", isMonth ? "grid-cols-7" : "grid-cols-1 md:grid-cols-7"].join(
              " "
            )}
          >
            {days.map((day) => {
              const dayEntries = byDay.get(day) ?? [];
              const outsideMonth = isMonth && !isSameMonth(day, anchor);
              const isToday = day === today;
              const expanded = expandedDays.has(day);
              const shown =
                isMonth && !expanded ? dayEntries.slice(0, MONTH_CELL_LIMIT) : dayEntries;
              const hidden = dayEntries.length - shown.length;

              return (
                <div
                  key={day}
                  className={[
                    "rounded-control border-border border p-2",
                    isMonth ? "min-h-[132px]" : "min-h-[160px]",
                    outsideMonth ? "bg-surface-subtle/50" : "bg-surface",
                    isToday ? "border-accent" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  <div className="mb-1.5 flex items-baseline justify-between gap-1">
                    <span
                      className={[
                        "text-sm font-semibold tabular-nums",
                        isToday ? "text-accent" : outsideMonth ? "text-fg-faint" : "text-fg",
                      ].join(" ")}
                    >
                      {Number(day.slice(8, 10))}
                    </span>
                    {/* The week view's stacked mobile layout has no column
                        headings, so each cell names its own weekday. The
                        toolbar above already states which week it is. */}
                    <span
                      className={["text-fg-faint text-xs", isMonth ? "hidden" : "md:hidden"].join(
                        " "
                      )}
                    >
                      {formatWeekdayShort(middayOf(day), locale)}
                    </span>
                  </div>

                  <div className="space-y-1">
                    {shown.map((entry) => {
                      const channel = asChannelValue(entry.post.channel);
                      return (
                        <button
                          key={entry.post.id}
                          type="button"
                          onClick={() => setOpenPostId(entry.post.id)}
                          className="rounded-control border-border bg-surface-subtle duration-fast hover:border-border-strong focus-visible:outline-accent block w-full border px-2 py-1.5 text-left transition-colors outline-none focus-visible:outline-2"
                        >
                          <span className="flex flex-wrap items-center gap-1">
                            <span className="text-fg text-[11px] font-semibold tabular-nums">
                              {entry.time}
                            </span>
                            {channel ? (
                              <ChannelChip channel={channel} size="sm" />
                            ) : (
                              <span className="text-fg-muted text-[11px]">
                                {entry.post.channel}
                              </span>
                            )}
                            <StatusBadge
                              status={entry.post.status.toLowerCase() as PostStatusValue}
                            />
                          </span>
                          <span className="text-fg-muted mt-1 line-clamp-2 block text-xs leading-snug">
                            {preview(entry.post.text)}
                          </span>
                        </button>
                      );
                    })}

                    {hidden > 0 && (
                      <button
                        type="button"
                        onClick={() => toggleExpanded(day)}
                        className="text-fg-muted hover:text-fg focus-visible:outline-accent rounded-control w-full px-2 py-1 text-left text-xs font-medium transition-colors outline-none focus-visible:outline-2"
                      >
                        {t("moreOnDay", { count: hidden })}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {openEntry && (
        <Modal open onClose={() => setOpenPostId(null)} title={t("postDetail")} maxWidth="xl">
          <GeneratedPostCard
            slug={slug}
            // One post, not its content-group siblings: a calendar entry IS one
            // post on one channel at one time, and its siblings sit in their own
            // cells with their own times.
            posts={[openEntry.post]}
            canDelete={canDelete}
            role={role}
            bufferConnected={bufferConnected}
            onDelete={handleDeleted}
            onStatusChange={handleChanged}
            onEdited={handleEdited}
            isGlobalAdmin={isGlobalAdmin}
          />
        </Modal>
      )}
    </div>
  );
}
