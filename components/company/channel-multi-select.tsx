"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";
import {
  channelLabel,
  isAllChannelsSelected,
  toggleAllChannels,
  toggleChannelSelection,
} from "@/lib/posts/channel-selection";

interface Props {
  /** Uppercase channels this company can actually publish to, in display order. */
  available: readonly string[];
  /** The current selection — always a subset of `available`, never empty. */
  selected: readonly string[];
  onChange: (channels: string[]) => void;
  disabled?: boolean;
}

/**
 * Which channels a topic is written for.
 *
 * A checklist rather than a multi-select `<select multiple>` or a combobox: the
 * list is at most four items and every one of them is worth showing at a glance,
 * so a control that hides its options behind a click — or that needs ctrl-click
 * to be operated at all — would be strictly worse. No new dependency either;
 * this is four checkboxes and the rules in `lib/posts/channel-selection.ts`.
 *
 * "All channels" is a derived checkbox, not a stored flag. It reads as ticked
 * exactly when every AVAILABLE channel is selected, so connecting a fifth
 * profile unticks it by itself rather than leaving it claiming something that is
 * no longer true.
 *
 * The last selected channel's checkbox is disabled. Generation needs at least
 * one channel, and enforcing that on the control — rather than by letting the
 * list empty and greying out the submit button — means the constraint is visible
 * where it applies instead of being announced after the fact.
 */
export function ChannelMultiSelect({ available, selected, onChange, disabled = false }: Props) {
  const t = useTranslations("posts.generate");
  const groupId = useId();

  const allSelected = isAllChannelsSelected(selected, available);
  const isLastSelected = (channel: string) => selected.length === 1 && selected[0] === channel;

  return (
    <fieldset className="min-w-[220px] flex-1" disabled={disabled}>
      <legend className="text-fg-muted mb-1.5 block text-sm font-medium">{t("channels")}</legend>

      <div
        role="group"
        aria-describedby={`${groupId}-hint`}
        className="rounded-control border-border-strong bg-surface flex flex-wrap items-center gap-x-4 gap-y-2 border px-3.5 py-2.5"
      >
        {available.length > 1 && (
          <>
            <label className="flex cursor-pointer items-center gap-2 text-sm select-none">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() => onChange(toggleAllChannels(selected, available))}
                disabled={disabled}
                className="accent-accent h-4 w-4 cursor-pointer disabled:cursor-not-allowed"
              />
              <span className="text-fg font-medium">{t("channelsAll")}</span>
            </label>
            <span aria-hidden className="bg-border h-4 w-px" />
          </>
        )}

        {available.map((channel) => {
          const checked = selected.includes(channel);
          // Ticked and alone: unticking it is refused, so the box says so rather
          // than swallowing the click.
          const locked = checked && isLastSelected(channel);
          return (
            <label
              key={channel}
              className={`flex items-center gap-2 text-sm select-none ${
                locked || disabled ? "cursor-not-allowed" : "cursor-pointer"
              }`}
              title={locked ? t("channelsAtLeastOne") : undefined}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled || locked}
                onChange={() => onChange(toggleChannelSelection(selected, channel, available))}
                className="accent-accent h-4 w-4 disabled:cursor-not-allowed"
              />
              <span className={checked ? "text-fg" : "text-fg-muted"}>{channelLabel(channel)}</span>
            </label>
          );
        })}
      </div>

      {/* Said once, plainly: several channels is several posts, and the whole
          point is that they are not copies of each other. */}
      <p id={`${groupId}-hint`} className="text-fg-faint mt-1.5 text-xs">
        {selected.length > 1
          ? t("channelsMultiHint", { count: selected.length })
          : t("channelsHint")}
      </p>
    </fieldset>
  );
}
