"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { compactCount } from "@/lib/analytics/analytics-format";
import type { AnalyticsSeries } from "@/lib/services/analytics/get-channel-analytics.service";

interface Props {
  series: AnalyticsSeries[];
  /** Business-zone day strings, ascending — the x-axis. */
  days: string[];
}

/**
 * Viewbox units — proportions, not pixels. The SVG scales uniformly to its
 * container (the default `preserveAspectRatio`), so the 2.5:1 box is ~150px tall
 * on a phone and ~360px on a desktop column, and the axis text never stretches.
 */
const WIDTH = 1000;
const HEIGHT = 400;
const PAD_LEFT = 56;
const PAD_RIGHT = 12;
const PAD_TOP = 16;
const PAD_BOTTOM = 34;

const PLOT_W = WIDTH - PAD_LEFT - PAD_RIGHT;
const PLOT_H = HEIGHT - PAD_TOP - PAD_BOTTOM;

/**
 * Daily engagement over the selected period.
 *
 * ── Why the line breaks ──────────────────────────────────────────────────────
 *
 * A point is null when no pair of snapshots covers that day — a day the sync did
 * not reach, which is normal: the analytics cron works through a company's
 * backlog over several runs. Those days are drawn as GAPS, not as zeroes, and
 * the series is emitted as several `<polyline>` runs rather than one. Joining
 * across a gap would draw a straight line through days nobody observed, and
 * flooring it to zero would show engagement collapsing during a sync outage.
 * Both are claims the data does not make.
 *
 * The values themselves are deltas between consecutive cumulative snapshots,
 * spread across the days they cover — see `lib/analytics/analytics-series.ts`,
 * which owns every rule about the numbers. This component only draws them.
 *
 * A Client Component for one reason: the metric switcher. Every series for the
 * current period and channel is computed server-side and sent down together, so
 * switching metric is instant and costs no request; the period and the channel
 * stay in the URL, where they are shareable.
 */
export function AnalyticsTrendChart({ series, days }: Props) {
  const t = useTranslations("planner.analytics");
  const tMetric = useTranslations("analytics");

  const [metric, setMetric] = useState(series[0]?.metric);

  // The caller only renders this section when a series exists, so `active` is
  // present in practice; the null path keeps an unexpected empty list from
  // taking the whole page down with it.
  const active = series.find((s) => s.metric === metric) ?? series[0] ?? null;

  const geometry = useMemo(() => {
    if (!active) return null;
    const values = active.points.map((p) => p.value);
    const max = Math.max(1, ...values.filter((v): v is number => v !== null));

    const x = (index: number) =>
      PAD_LEFT + (days.length <= 1 ? PLOT_W / 2 : (index / (days.length - 1)) * PLOT_W);
    const y = (value: number) => PAD_TOP + PLOT_H - (value / max) * PLOT_H;

    // Consecutive non-null stretches. Each becomes its own polyline, which is
    // what puts a real gap where a day was never observed.
    const runs: Array<Array<{ x: number; y: number }>> = [];
    let run: Array<{ x: number; y: number }> = [];

    active.points.forEach((point, index) => {
      if (point.value === null) {
        if (run.length > 0) runs.push(run);
        run = [];
        return;
      }
      run.push({ x: x(index), y: y(point.value) });
    });
    if (run.length > 0) runs.push(run);

    return { max, runs, x };
  }, [active, days.length]);

  const labelFor = (day: string) => day.slice(8, 10) + "." + day.slice(5, 7);

  // Four evenly spaced x labels at most — a year of daily points cannot label
  // every column, and a crowded axis is less readable than a sparse one.
  const tickIndexes = useMemo(() => {
    const count = Math.min(4, days.length);
    if (count <= 1) return [0];
    return Array.from({ length: count }, (_, i) =>
      Math.round((i / (count - 1)) * (days.length - 1))
    );
  }, [days.length]);

  if (!active || !geometry) return null;

  return (
    <div>
      {series.length > 1 && (
        <div
          role="group"
          aria-label={t("chart.metricLabel")}
          className="border-border bg-surface rounded-control mb-4 inline-flex flex-wrap items-center gap-1 border p-1"
        >
          {series.map((option) => {
            const isActive = option.metric === active.metric;
            return (
              <button
                key={option.metric}
                type="button"
                onClick={() => setMetric(option.metric)}
                aria-pressed={isActive}
                className={[
                  "rounded-control duration-fast focus-visible:outline-accent inline-flex h-7 items-center px-2.5 text-sm font-medium whitespace-nowrap transition-colors outline-none first-letter:uppercase focus-visible:outline-2",
                  isActive
                    ? "bg-fg text-bg"
                    : "text-fg-muted hover:bg-surface-subtle hover:text-fg",
                ].join(" ")}
              >
                {tMetric(option.metric)}
              </button>
            );
          })}
        </div>
      )}

      <div className="rounded-card border-border bg-surface border p-3">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="h-auto w-full"
          role="img"
          aria-label={t("chart.imageLabel", { metric: tMetric(active.metric) })}
        >
          {/* Horizontal guides at 0, half and full scale. */}
          {[0, 0.5, 1].map((fraction) => {
            const y = PAD_TOP + PLOT_H - fraction * PLOT_H;
            return (
              <g key={fraction}>
                <line
                  x1={PAD_LEFT}
                  x2={WIDTH - PAD_RIGHT}
                  y1={y}
                  y2={y}
                  className="stroke-border"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
                <text
                  x={PAD_LEFT - 8}
                  y={y + 4}
                  textAnchor="end"
                  className="fill-fg-faint text-[11px]"
                >
                  {compactCount(Math.round(geometry.max * fraction))}
                </text>
              </g>
            );
          })}

          {geometry.runs.map((run, index) => (
            <g key={index}>
              <polyline
                points={run.map((p) => `${p.x},${p.y}`).join(" ")}
                fill="none"
                className="stroke-accent"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
              {/* A single observed day between two gaps has no line to be seen
                  as, so it is drawn as a dot instead of vanishing. */}
              {run.length === 1 && (
                <circle cx={run[0].x} cy={run[0].y} r={3} className="fill-accent" />
              )}
            </g>
          ))}

          {tickIndexes.map((index) => (
            <text
              key={index}
              x={geometry.x(index)}
              y={HEIGHT - 6}
              textAnchor={index === 0 ? "start" : index === days.length - 1 ? "end" : "middle"}
              className="fill-fg-faint text-[11px]"
            >
              {labelFor(days[index])}
            </text>
          ))}
        </svg>
      </div>

      <p className="text-fg-faint mt-2 text-xs leading-relaxed">{t("chart.note")}</p>
    </div>
  );
}
