import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { ANALYTICS_PERIODS, type AnalyticsPeriod } from "@/lib/analytics/analytics-period";
import { APP_TIME_ZONE, dateLocaleFor, formatDate } from "@/lib/i18n/format-date";

interface Props {
  /** Where every option links, e.g. `/companies/acme/channels/all/analytics`. */
  basePath: string;
  period: AnalyticsPeriod;
  /** The range the current period resolved to, for the caption underneath. */
  startDay: string;
  endDay: string;
}

/**
 * Midday UTC on a calendar day — the instant a day string is FORMATTED through.
 *
 * Midday rather than midnight because the formatter renders in the business
 * zone: 00:00 UTC would land on the previous day for any zone behind UTC, and a
 * caption that disagrees with the data by one day is the whole problem this page
 * is trying not to have. Same trick, same reason, as the calendar toolbar.
 */
function middayOf(day: string): string {
  return `${day}T12:00:00.000Z`;
}

/**
 * The period filter: 7 days / 30 days / 3 months / 1 year.
 *
 * Links rather than buttons, and the page is server rendered from the URL —
 * matching the calendar toolbar exactly. A period is then shareable, the back
 * button walks back through the periods someone looked at, and a reload lands on
 * the same screen. The pill treatment is the channel switcher's, because this
 * narrows what is shown rather than moving to a different page.
 */
export async function AnalyticsPeriodFilter({ basePath, period, startDay, endDay }: Props) {
  const t = await getTranslations("planner.analytics");
  const locale = dateLocaleFor(await getLocale());

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <nav
        aria-label={t("period.label")}
        className="border-border bg-surface rounded-control flex flex-wrap items-center gap-1 border p-1"
      >
        {ANALYTICS_PERIODS.map((option) => {
          const isActive = option === period;
          return (
            <Link
              key={option}
              href={`${basePath}?period=${option}`}
              aria-current={isActive ? "page" : undefined}
              className={[
                "rounded-control duration-fast focus-visible:outline-accent inline-flex h-7 items-center px-2.5 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:outline-2",
                isActive ? "bg-fg text-bg" : "text-fg-muted hover:bg-surface-subtle hover:text-fg",
              ].join(" ")}
            >
              {t(`period.${option}`)}
            </Link>
          );
        })}
      </nav>

      <p className="text-fg-faint text-xs">
        {formatDate(middayOf(startDay), locale)} – {formatDate(middayOf(endDay), locale)} ·{" "}
        {t("timeZoneNote", { zone: APP_TIME_ZONE })}
      </p>
    </div>
  );
}
