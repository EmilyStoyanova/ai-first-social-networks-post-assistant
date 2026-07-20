"use client";

import { useTranslations } from "next-intl";
import type { PostMetricsView } from "@/lib/services/analytics/get-post-metrics.service";

interface Props {
  metrics: PostMetricsView;
  /** Owners see the "add a key" nudge; editors just see analytics as unavailable. */
  canManageKey: boolean;
  slug: string;
}

/**
 * Engagement figures on a post card, in the spirit of Buffer's own display:
 * reactions, comments, and engagement rate up front, with whatever secondary
 * metrics the network actually reported alongside.
 *
 * Two rules from the live API shape this component:
 *
 *  1. A null metric is NOT rendered as 0. Buffer omits metrics a network does not
 *     report, and showing "0 reactions" for something Facebook never measured
 *     would read as a real result. Nulls are simply left out.
 *  2. The engagement rate carries its denominator. Buffer computes it against
 *     impressions on Facebook and reach on Instagram, so the two numbers are not
 *     comparable — the label says which basis was used rather than presenting a
 *     bare percentage that invites a false comparison.
 */
export function PostMetricsStrip({ metrics, canManageKey, slug }: Props) {
  const t = useTranslations("analytics");

  // ── Non-ready states ──────────────────────────────────────────────────────
  if (metrics.state !== "ready") {
    return (
      <div className="border-border mt-3 border-t pt-3">
        <p className="text-fg-muted text-xs">
          {metrics.state === "disabled" && (
            <>
              {t("disabledOnCard")}
              {canManageKey && (
                <>
                  {" "}
                  <a
                    href={`/companies/${slug}#analytics`}
                    className="text-fg underline underline-offset-2"
                  >
                    {t("disabledOnCardAction")}
                  </a>
                </>
              )}
            </>
          )}
          {metrics.state === "pending" && t("pendingOnCard")}
          {metrics.state === "no_data" && t("noDataOnCard")}
          {metrics.state === "forbidden" && t("forbiddenOnCard")}
        </p>
      </div>
    );
  }

  // ── Ready ─────────────────────────────────────────────────────────────────
  // Primary trio first (requirement 7), then whatever else the network reported.
  const primary: Array<{ label: string; value: string }> = [];

  if (metrics.reactions !== null) {
    primary.push({ label: t("reactions"), value: formatCount(metrics.reactions) });
  }
  if (metrics.comments !== null) {
    primary.push({ label: t("comments"), value: formatCount(metrics.comments) });
  }
  if (metrics.engagementRate !== null) {
    primary.push({ label: t("engagementRate"), value: formatRate(metrics.engagementRate) });
  }

  const secondary: Array<{ label: string; value: string }> = [];
  const optional = [
    ["shares", metrics.shares],
    ["impressions", metrics.impressions],
    ["reach", metrics.reach],
    ["clicks", metrics.clicks],
    ["views", metrics.views],
    ["saves", metrics.saves],
  ] as const;

  for (const [key, value] of optional) {
    if (value !== null) secondary.push({ label: t(key), value: formatCount(value) });
  }

  // Buffer answered but every metric was absent — say so rather than render an
  // empty bar that looks like a rendering bug.
  if (primary.length === 0 && secondary.length === 0) {
    return (
      <div className="border-border mt-3 border-t pt-3">
        <p className="text-fg-muted text-xs">{t("noDataOnCard")}</p>
      </div>
    );
  }

  return (
    <div className="border-border mt-3 border-t pt-3">
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
        {primary.map((m) => (
          <div key={m.label} className="flex items-baseline gap-1.5">
            <span className="text-fg text-sm font-semibold tabular-nums">{m.value}</span>
            <span className="text-fg-muted text-xs">{m.label}</span>
          </div>
        ))}

        {secondary.length > 0 && (
          <div className="text-fg-muted flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
            {secondary.map((m) => (
              <span key={m.label} className="tabular-nums">
                {m.value} {m.label}
              </span>
            ))}
          </div>
        )}
      </div>

      <p className="text-fg-muted mt-1.5 text-[11px]">
        {metrics.engagementRateDenominator
          ? t("rateBasis", { basis: t(metrics.engagementRateDenominator) })
          : null}
        {metrics.engagementRateDenominator && metrics.metricsUpdatedAt ? " · " : null}
        {/* Buffer ingests once daily, so a figure can lag the network by ~24h.
            Saying so pre-empts "why doesn't this match Facebook?". */}
        {metrics.metricsUpdatedAt ? t("bufferLagNote") : null}
      </p>
    </div>
  );
}

function formatCount(n: number): string {
  return new Intl.NumberFormat().format(n);
}

/** Buffer sends a percentage already (12.5 means 12.5%). */
function formatRate(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return `${rounded}%`;
}
