"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Layers } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { ContentMixDTO } from "@/lib/services/company/get-content-mix.service";
import type { GenerationSourceOption } from "@/lib/services/company/list-generation-sources.service";
import { BATCH_MIX_COMPANY_KEY, batchMixTotal, clampMixCount } from "@/lib/posts/bulk-form";
import { contentMixSettingsHref } from "@/lib/posts/bulk-draft";
import { MAX_BULK_POSTS } from "@/lib/scheduling/bulk-schedule";

interface Props {
  slug: string;
  /** The company's saved mix — the default this panel starts from. */
  mix: ContentMixDTO;
  /** Posts per source for THIS batch, keyed by source id (company content: the sentinel). */
  counts: Record<string, number>;
  onChange: (counts: Record<string, number>) => void;
  /** False once the user has changed anything — drives the badge and the reset. */
  isDefault: boolean;
  onReset: () => void;
  /** What the counts must add up to: the batch's own number of posts. */
  numberOfPosts: number;
  /**
   * The generation dropdown's view of the same sources, used only to say that
   * one currently has nothing to write from. Advisory: a source that is dry now
   * may not be by the time the run reaches it, and an exhausted source hands its
   * posts to the others anyway.
   */
  sources: GenerationSourceOption[];
  disabled: boolean;
  /**
   * Called just before either link navigates away, so the parent can snapshot
   * the half-filled form. Synchronous on purpose: the write has to land before
   * the router leaves.
   */
  onLeaveForSettings: () => void;
}

/**
 * "Where do these posts come from?" — the batch's own content mix.
 *
 * The company already answers this once, in Settings → Channels, as a weekly
 * distribution the scheduler follows. Almost nobody found it there, and manual
 * generation ignored it entirely: a batch of five was five posts from whatever
 * surfaced. So the saved mix is brought to the place the decision is actually
 * being made, pre-filled and scaled to the batch's size.
 *
 * What it deliberately is NOT is a second place to configure the company. Every
 * number here belongs to one run: nothing is saved, the saved default is stated
 * as untouched, and the way to change that default is a link out to where it
 * lives. Two ideas, kept apart on purpose —
 *
 *   • the default mix — configuration, edited in settings, followed every week;
 *   • this panel      — an instruction for the batch about to be generated.
 */
export function BatchContentMixFields({
  slug,
  mix,
  counts,
  onChange,
  isDefault,
  onReset,
  numberOfPosts,
  sources,
  disabled,
  onLeaveForSettings,
}: Props) {
  const t = useTranslations("posts.generate.bulk");
  const tSource = useTranslations("posts.generate");

  // Straight to the editor, not to the top of a settings page the user then has
  // to search — and marked as a round trip, so that page offers the way back.
  const settingsHref = contentMixSettingsHref(slug, true);

  // An unconfigured company gets an invitation, not an empty editor: generation
  // keeps the pooled behaviour it has always had, and the panel says where the
  // default would be set. Nothing here forces a mix to exist first.
  if (!mix.configured) {
    return (
      <div className="border-border bg-surface-subtle rounded-card mt-4 border p-4">
        <div className="text-fg flex items-center gap-1.5 text-sm font-medium">
          <Layers className="h-4 w-4" aria-hidden />
          {t("contentMixTitle")}
        </div>
        <p className="text-fg-muted mt-2 text-xs">{t("contentMixUnconfigured")}</p>
        <Link
          href={settingsHref}
          onClick={onLeaveForSettings}
          className="text-accent mt-2 inline-block text-xs font-semibold underline underline-offset-2"
        >
          {t("contentMixSetUp")}
        </Link>
      </div>
    );
  }

  const availability = new Map(sources.map((s) => [s.id, s]));

  // Only enabled sources carry a quota — the stored mix drops disabled ones, and
  // so does the run. Company content sits last, as it does in settings.
  const rows: Array<{ key: string; label: string; hint?: string; unavailable?: string }> = [
    ...mix.sources
      .filter((source) => source.enabled)
      .map((source) => {
        const option = availability.get(source.id);
        return {
          key: source.id,
          label: source.name,
          unavailable:
            option && !option.available
              ? tSource(
                  option.unavailableReason === "no_content"
                    ? "contentSourceNoContent"
                    : "contentSourceNoArticles"
                )
              : undefined,
        };
      }),
    {
      key: BATCH_MIX_COMPANY_KEY,
      label: t("contentMixCompanyContent"),
      hint: t("contentMixCompanyContentHint"),
    },
  ];

  const assigned = batchMixTotal(counts);
  const balanced = assigned === numberOfPosts;

  function setCount(key: string, raw: string) {
    onChange({ ...counts, [key]: clampMixCount(raw) });
  }

  return (
    <div className="border-border bg-surface-subtle rounded-card mt-4 border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-fg flex items-center gap-1.5 text-sm font-medium">
          <Layers className="h-4 w-4" aria-hidden />
          {t("contentMixTitle")}
          <span
            className={`rounded-control border px-1.5 py-0.5 text-[11px] font-semibold ${
              isDefault
                ? "border-border text-fg-muted"
                : "border-accent/40 bg-accent/10 text-accent"
            }`}
          >
            {isDefault ? t("contentMixDefaultBadge") : t("contentMixAdjustedBadge")}
          </span>
        </div>

        <div className="flex items-center gap-3">
          {!isDefault && (
            <Button variant="secondary" size="sm" disabled={disabled} onClick={onReset}>
              {t("contentMixReset")}
            </Button>
          )}
          <Link
            href={settingsHref}
            onClick={onLeaveForSettings}
            className="text-fg-muted hover:text-fg text-xs underline underline-offset-2"
          >
            {t("contentMixEditDefault")}
          </Link>
        </div>
      </div>

      <p className="text-fg-faint mt-2 text-xs">{t("contentMixHint")}</p>

      <div className="mt-3 space-y-2">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <label htmlFor={`batch-mix-${row.key}`} className="text-fg block truncate text-sm">
                {row.label}
              </label>
              {row.hint && <span className="text-fg-faint block text-xs">{row.hint}</span>}
              {row.unavailable && (
                <span className="text-fg-faint block text-xs">{row.unavailable}</span>
              )}
            </div>
            {/* Dotted leader, matching the settings editor this mirrors. */}
            <span
              aria-hidden="true"
              className="border-border min-w-6 flex-1 border-b border-dotted"
            />
            <input
              id={`batch-mix-${row.key}`}
              type="number"
              min={0}
              max={MAX_BULK_POSTS}
              inputMode="numeric"
              value={counts[row.key] ?? 0}
              onChange={(e) => setCount(row.key, e.target.value)}
              disabled={disabled}
              className="rounded-control border-border-strong bg-surface focus:border-accent focus:ring-accent/20 w-20 border px-2 py-1 text-right text-sm outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </div>
        ))}
      </div>

      {/* The same running sum the settings editor shows, against this batch's
          number of posts rather than the weekly target. */}
      <div className="border-border mt-3 flex items-baseline justify-between border-t pt-2">
        <span className="text-fg-muted text-xs font-medium">
          {t("contentMixAssigned", { assigned, requested: numberOfPosts })}
        </span>
        {!balanced && (
          <span className="text-status-danger-fg text-xs">
            {t("contentMixMismatch", { requested: numberOfPosts })}
          </span>
        )}
      </div>

      <p className="text-fg-faint mt-2 text-xs">{t("contentMixExhaustedNote")}</p>
    </div>
  );
}
