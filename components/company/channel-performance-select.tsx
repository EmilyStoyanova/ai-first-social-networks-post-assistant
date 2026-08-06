"use client";

import { useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { ChevronDown } from "lucide-react";
import { buildPerformanceChannelQuery, channelLabel } from "@/lib/analytics/performance-channels";
import { ChannelMonogram } from "./channel-monogram";

interface Props {
  /** Eligible channels, already filtered and ordered by the service. */
  channels: string[];
  /** The channel currently summarised, always one of `channels`. */
  selected: string;
}

/**
 * The channel this panel is reporting on — a switcher when there is a choice,
 * the plain badge when there is not.
 *
 * One eligible channel means the badge is a label, not a control: a dropdown
 * whose only option is the thing already on screen invites a click that cannot
 * change anything. Most companies publish to one network, so this is the common
 * case rather than a corner of it.
 *
 * A native <select> under a transparent overlay, not a custom menu: §6.5 rules
 * out bespoke dropdowns, and the native control brings keyboard support, the
 * platform's own list rendering and mobile pickers for free. The visible badge
 * keeps the monogram — which a native <option> cannot hold — and is inert, so
 * every interaction lands on the real control.
 *
 * The selection lives in `?channel=`, read by the server component that
 * computes the figures. That keeps one source of truth for "which channel"
 * (shareable, survives a reload) and means the numbers below are recomputed
 * rather than filtered client-side from data the page never loaded.
 */
export function ChannelPerformanceSelect({ channels, selected }: Props) {
  const t = useTranslations("overview.performance");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const badge = (
    <>
      <ChannelMonogram channel={selected} className="h-5 w-5 text-[9px]" />
      {channelLabel(selected)}
    </>
  );

  const shell =
    "bg-surface-subtle text-fg-muted rounded-control inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium";

  if (channels.length < 2) {
    return <span className={shell}>{badge}</span>;
  }

  return (
    <span
      className={[
        shell,
        "duration-fast focus-within:outline-accent relative transition-colors outline-none focus-within:outline-2",
        isPending ? "opacity-60" : "hover:text-fg",
      ].join(" ")}
    >
      {badge}
      <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <select
        aria-label={t("channelSelector")}
        value={selected}
        disabled={isPending}
        onChange={(event) => {
          const query = buildPerformanceChannelQuery(searchParams.toString(), event.target.value);
          // Replace, not push: switching channels refines the view rather than
          // moving on, so Back should leave the overview, not step through
          // every channel the user glanced at. Scrolling is suppressed because
          // the panel is well down the page and the numbers change in place.
          startTransition(() => router.replace(`${pathname}?${query}`, { scroll: false }));
        }}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-wait"
      >
        {channels.map((channel) => (
          <option key={channel} value={channel}>
            {channelLabel(channel)}
          </option>
        ))}
      </select>
    </span>
  );
}
