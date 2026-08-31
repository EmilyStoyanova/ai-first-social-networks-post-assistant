"use client";

import { useTranslations } from "next-intl";
import { VISIBLE_POST_STATUS_FILTERS, type PostStatusFilter } from "@/lib/posts/post-status-filter";

interface Props {
  value: PostStatusFilter;
  onChange: (filter: PostStatusFilter) => void;
  /** How many posts each filter would show, for the count beside its label. */
  counts: Record<PostStatusFilter, number>;
}

/**
 * Compact segmented control above the posts grid.
 *
 * Deliberately not the underlined tab treatment used by CompanyWorkspaceNav:
 * that styling means "you are on a different page", and these buttons do not
 * navigate — they narrow the list in place. A pill group reads as a control
 * rather than a second row of tabs competing with the workspace nav directly
 * above it.
 *
 * Buttons, not links: the filtering is client-side over posts already loaded,
 * so a link would imply a page load that does not happen.
 */
export function PostStatusFilterBar({ value, onChange, counts }: Props) {
  const t = useTranslations("posts.filters");

  return (
    <div
      role="group"
      aria-label={t("label")}
      className="border-border bg-surface rounded-control flex flex-wrap items-center gap-1 border p-1"
    >
      {VISIBLE_POST_STATUS_FILTERS.map((filter) => {
        const isActive = filter === value;
        return (
          <button
            key={filter}
            type="button"
            onClick={() => onChange(filter)}
            aria-pressed={isActive}
            className={[
              "rounded-control duration-fast focus-visible:outline-accent inline-flex h-7 items-center gap-1.5 px-2.5 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:outline-2",
              isActive ? "bg-fg text-bg" : "text-fg-muted hover:bg-surface-subtle hover:text-fg",
            ].join(" ")}
          >
            {t(filter)}
            {/* Tabular figures so the labels do not shift as counts change. */}
            <span
              className={["text-xs tabular-nums", isActive ? "text-bg/70" : "text-fg-faint"].join(
                " "
              )}
            >
              {counts[filter]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
