import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  buildCalendarQuery,
  shiftCalendarAnchor,
  CALENDAR_VIEWS,
  type CalendarRange,
  type CalendarView,
} from "@/lib/calendar/calendar-range";
import {
  CALENDAR_STATUS_FILTERS,
  buildCalendarStatusQuery,
  type CalendarStatusFilter,
} from "@/lib/calendar/calendar-status-filter";
import { APP_TIME_ZONE, dateLocaleFor, formatDate, formatMonthYear } from "@/lib/i18n/format-date";

interface Props {
  /** Where every control links back to, e.g. `/companies/acme/channels/all/calendar`. */
  basePath: string;
  /** The current query string without the leading "?" — everything is preserved across a click. */
  query: string;
  range: CalendarRange;
  /** Business-zone today, so "Today" and the disabled-looking state agree with the grid. */
  today: string;
  status: CalendarStatusFilter;
  counts: Record<CalendarStatusFilter, number>;
}

/**
 * Midday UTC on a calendar day.
 *
 * The instant a day string is FORMATTED through. Midday rather than midnight
 * because the formatter renders in the business zone: 00:00 UTC on 2026-08-18 is
 * 03:00 on the 18th in Sofia today, but would be 23:00 on the 17th for a zone
 * behind UTC, and a heading that disagrees with the grid by one day is the
 * single worst bug a calendar can have. Midday is safely inside the day for
 * every zone on earth. Same trick the bulk generation form already uses.
 */
function middayOf(day: string): string {
  return `${day}T12:00:00.000Z`;
}

/**
 * The calendar's controls: period, Previous / Today / Next, Week / Month, and
 * the status filter.
 *
 * Every control is a LINK, not a button, and the whole calendar is server
 * rendered from the URL. That is the simplest thing that satisfies what a
 * calendar has to do: a week is shareable, the back button walks back through
 * the weeks a person looked at, and a reload lands on the same screen. The
 * alternative — client state plus a fetch per arrow press — would buy a faster
 * paint at the cost of all three.
 */
export async function CalendarToolbar({ basePath, query, range, today, status, counts }: Props) {
  const t = await getTranslations("planner.calendar");
  const locale = dateLocaleFor(await getLocale());

  const href = (next: { view?: CalendarView; date?: string }) =>
    `${basePath}?${buildCalendarQuery(query, next)}`;

  const periodLabel =
    range.view === "month"
      ? formatMonthYear(middayOf(range.anchor), locale)
      : `${formatDate(middayOf(range.periodStart), locale)} – ${formatDate(
          middayOf(range.periodEnd),
          locale
        )}`;

  const arrowClasses =
    "rounded-control border-border bg-surface text-fg-muted duration-fast hover:border-border-strong hover:text-fg focus-visible:outline-accent inline-flex h-8 w-8 items-center justify-center border transition-colors outline-none focus-visible:outline-2";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link
            href={href({ date: shiftCalendarAnchor(range.view, range.anchor, -1) })}
            aria-label={t("previous")}
            className={arrowClasses}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </Link>
          <Link
            href={href({ date: shiftCalendarAnchor(range.view, range.anchor, 1) })}
            aria-label={t("next")}
            className={arrowClasses}
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Link>
          <Link
            href={href({ date: today })}
            className="rounded-control border-border bg-surface text-fg-muted duration-fast hover:border-border-strong hover:text-fg focus-visible:outline-accent inline-flex h-8 items-center border px-3 text-sm font-medium transition-colors outline-none focus-visible:outline-2"
          >
            {t("today")}
          </Link>

          {/* The heading is the period, in the data role — it is the one thing on
              this bar that changes with every click. */}
          <h2 className="text-title text-fg ml-1" aria-label={t("periodLabel")}>
            {periodLabel}
          </h2>
        </div>

        <nav
          aria-label={t("viewLabel")}
          className="border-border bg-surface rounded-control flex items-center gap-1 border p-1"
        >
          {CALENDAR_VIEWS.map((view) => {
            const isActive = view === range.view;
            return (
              <Link
                key={view}
                href={href({ view, date: range.anchor })}
                aria-current={isActive ? "page" : undefined}
                className={[
                  "rounded-control duration-fast focus-visible:outline-accent inline-flex h-7 items-center px-2.5 text-sm font-medium transition-colors outline-none focus-visible:outline-2",
                  isActive
                    ? "bg-fg text-bg"
                    : "text-fg-muted hover:bg-surface-subtle hover:text-fg",
                ].join(" ")}
              >
                {t(view)}
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav
          aria-label={t("filterLabel")}
          className="border-border bg-surface rounded-control flex flex-wrap items-center gap-1 border p-1"
        >
          {CALENDAR_STATUS_FILTERS.map((filter) => {
            const isActive = filter === status;
            return (
              <Link
                key={filter}
                href={`${basePath}?${buildCalendarStatusQuery(query, filter)}`}
                aria-current={isActive ? "page" : undefined}
                className={[
                  "rounded-control duration-fast focus-visible:outline-accent inline-flex h-7 items-center gap-1.5 px-2.5 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:outline-2",
                  isActive
                    ? "bg-fg text-bg"
                    : "text-fg-muted hover:bg-surface-subtle hover:text-fg",
                ].join(" ")}
              >
                {t(`filters.${filter}`)}
                <span
                  className={[
                    "text-xs tabular-nums",
                    isActive ? "text-bg/70" : "text-fg-faint",
                  ].join(" ")}
                >
                  {counts[filter]}
                </span>
              </Link>
            );
          })}
        </nav>

        <p className="text-fg-faint text-xs">{t("timeZoneNote", { zone: APP_TIME_ZONE })}</p>
      </div>
    </div>
  );
}
