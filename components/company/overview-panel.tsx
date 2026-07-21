import Link from "next/link";
import { ArrowRight, type LucideIcon } from "lucide-react";

interface Props {
  icon: LucideIcon;
  title: string;
  /** Rendered right of the title — a channel switch, a "view all" link, a count. */
  action?: React.ReactNode;
  /** Footer link. Every panel exits somewhere useful rather than dead-ending (§9.4). */
  footerHref?: string;
  footerLabel?: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * The shared container for the four Overview dashboard blocks.
 *
 * One component so the blocks cannot drift apart: identical header height,
 * identical padding, identical footer treatment. The Overview's job is to be
 * scanned in a few seconds, which only works if the eye can rely on the same
 * furniture appearing in the same place in all four quadrants.
 */
export function OverviewPanel({
  icon: Icon,
  title,
  action,
  footerHref,
  footerLabel,
  children,
  className,
}: Props) {
  return (
    <section
      className={[
        "rounded-card border-border bg-surface shadow-card flex flex-col border",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <header className="flex items-center justify-between gap-3 px-5 pt-5 pb-4">
        <h2 className="text-fg flex min-w-0 items-center gap-2.5 text-sm font-semibold">
          <Icon className="text-fg-muted h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{title}</span>
        </h2>
        {action}
      </header>

      <div className="flex-1 px-5 pb-2">{children}</div>

      {footerHref && footerLabel && (
        <footer className="border-border mt-2 border-t px-5 py-3">
          <Link
            href={footerHref}
            className="text-fg-muted hover:text-fg duration-fast inline-flex items-center gap-1.5 text-xs font-medium transition-colors"
          >
            {footerLabel}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </footer>
      )}
    </section>
  );
}
