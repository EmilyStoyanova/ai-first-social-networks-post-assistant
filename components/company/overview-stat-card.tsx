import Link from "next/link";
import { ArrowDown, ArrowUp, type LucideIcon } from "lucide-react";

type Tone = "accent" | "warning" | "success" | "info" | "neutral";

const TILE: Record<Tone, string> = {
  accent: "bg-tile-accent-bg text-tile-accent-fg",
  warning: "bg-tile-warning-bg text-tile-warning-fg",
  success: "bg-tile-success-bg text-tile-success-fg",
  info: "bg-tile-info-bg text-tile-info-fg",
  neutral: "bg-tile-neutral-bg text-tile-neutral-fg",
};

interface Props {
  icon: LucideIcon;
  tone: Tone;
  label: string;
  value: number | string;
  /** Percentage change vs the previous period. Null hides the chip entirely. */
  delta?: number | null;
  /** One short line under the value — what the number means or what to do next. */
  hint?: string;
  /** Makes the whole card a link. Stat cards route into filtered work (§9.3). */
  href?: string;
}

/**
 * One KPI tile in the Overview stat row.
 *
 * The tile colour identifies the metric so the row is scannable by shape and
 * position; it deliberately does not encode state — a red tile would compete
 * with the StatusBadge language, which is the only thing in the product allowed
 * to mean "something is wrong" (§6.2). The delta chip is the exception: up and
 * down are facts about the number, not statuses.
 */
export function OverviewStatCard({ icon: Icon, tone, label, value, delta, hint, href }: Props) {
  const rising = delta != null && delta >= 0;

  const body = (
    <div className="rounded-card border-border bg-surface shadow-card group-hover:border-border-strong flex h-full flex-col border px-5 py-5 transition-all duration-[--duration-fast] group-hover:shadow-sm">
      <div className="flex items-start gap-3">
        <span
          className={`rounded-control flex h-10 w-10 shrink-0 items-center justify-center ${TILE[tone]}`}
          aria-hidden="true"
        >
          <Icon className="h-5 w-5" />
        </span>
        <p className="text-fg-muted min-w-0 pt-0.5 text-sm leading-snug font-medium">{label}</p>
      </div>

      <div className="mt-4 flex items-baseline gap-2">
        <span className="text-fg text-3xl leading-none font-semibold tabular-nums">{value}</span>
        {delta != null && (
          <span
            className={`inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums ${
              rising ? "text-status-success-fg" : "text-status-danger-fg"
            }`}
          >
            {rising ? (
              <ArrowUp className="h-3 w-3" aria-hidden="true" />
            ) : (
              <ArrowDown className="h-3 w-3" aria-hidden="true" />
            )}
            {Math.abs(delta)}%
          </span>
        )}
      </div>

      {hint && <p className="text-fg-faint mt-1.5 text-xs leading-snug">{hint}</p>}
    </div>
  );

  if (!href) return <div className="h-full">{body}</div>;

  return (
    <Link href={href} className="group block h-full">
      {body}
    </Link>
  );
}
