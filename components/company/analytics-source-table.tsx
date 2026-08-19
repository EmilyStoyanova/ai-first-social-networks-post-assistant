import { getTranslations } from "next-intl/server";
import { formatAverage } from "@/lib/analytics/analytics-format";
import type { SourcePerformanceView } from "@/lib/services/analytics/get-channel-analytics.service";
import type { CountMetric } from "@/lib/analytics/analytics-metrics";

interface Props {
  sources: SourcePerformanceView[];
  /** The metric columns, in the order the KPI row uses. */
  metrics: CountMetric[];
}

/**
 * Which content sources produce posts that perform.
 *
 * Every metric column is an AVERAGE PER POST THAT REPORTED IT, never per post.
 * If 4 of a source's 10 posts report reach, the average divides by 4 — treating
 * the other six as zeroes would invent six measurements Instagram never made and
 * more than halve a real figure. The "reported" count is rendered beside any
 * average drawn from fewer posts than the source published, so the denominator
 * is never something the reader has to assume.
 *
 * Attribution is `Post.contentSourceId` first and the frozen origin snapshot
 * second — see `lib/analytics/analytics-source.ts`. A source deleted last month
 * still has its posts filed under its own name rather than collapsing into
 * "Company content".
 *
 * A plain table rather than `DataTable`: the numeric cells carry a second line
 * (the denominator) that the shared component has no shape for, and the mobile
 * treatment here is horizontal scroll inside the card rather than the page.
 */
export async function AnalyticsSourceTable({ sources, metrics }: Props) {
  const t = await getTranslations("planner.analytics");
  const tMetric = await getTranslations("analytics");

  return (
    <div className="rounded-card border-border bg-surface shadow-card border">
      {/* The scroll container is the CARD, so a wide metric row never makes the
          page itself scroll sideways on a phone. */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-border border-b">
              <th
                scope="col"
                className="text-fg-muted px-4 py-2.5 text-left text-xs font-semibold whitespace-nowrap"
              >
                {t("sources.source")}
              </th>
              <th
                scope="col"
                className="text-fg-muted px-4 py-2.5 text-right text-xs font-semibold whitespace-nowrap"
              >
                {t("sources.posts")}
              </th>
              {metrics.map((metric) => (
                <th
                  key={metric}
                  scope="col"
                  className="text-fg-muted px-4 py-2.5 text-right text-xs font-semibold whitespace-nowrap"
                >
                  {t("sources.avg", { metric: tMetric(metric) })}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sources.map((source) => (
              <tr key={source.key} className="border-border border-b last:border-0">
                <th scope="row" className="text-fg px-4 py-3 text-left font-medium">
                  {/* Clamped: a long RSS source name must not push the metric
                      columns off the card on a narrow screen. */}
                  <span className="line-clamp-2 block max-w-[14rem] break-words">
                    {source.name ?? t("sources.companyContent")}
                  </span>
                </th>
                <td className="text-fg px-4 py-3 text-right tabular-nums">{source.posts}</td>
                {source.averages.map((average) => (
                  <td key={average.metric} className="px-4 py-3 text-right whitespace-nowrap">
                    <span className="text-fg tabular-nums">{formatAverage(average.value)}</span>
                    {average.value !== null && average.reported < source.posts && (
                      <span className="text-fg-faint block text-[11px] tabular-nums">
                        {t("sources.reportedBy", { reported: average.reported })}
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-fg-faint border-border border-t px-4 py-2.5 text-xs leading-relaxed">
        {t("sources.averageNote")}
      </p>
    </div>
  );
}
