const CHANNEL_STYLES: Record<string, { initial: string; className: string; label: string }> = {
  FACEBOOK: { initial: "F", className: "bg-tile-info-bg text-tile-info-fg", label: "Facebook" },
  LINKEDIN: {
    initial: "in",
    className: "bg-tile-accent-bg text-tile-accent-fg",
    label: "LinkedIn",
  },
  INSTAGRAM: {
    initial: "IG",
    className: "bg-tile-warning-bg text-tile-warning-fg",
    label: "Instagram",
  },
  TIKTOK: { initial: "TT", className: "bg-tile-neutral-bg text-tile-neutral-fg", label: "TikTok" },
};

interface Props {
  channel: string;
  className?: string;
}

/**
 * A small round channel marker for dense list rows.
 *
 * A monogram rather than a brand icon, and uniform across all four channels on
 * purpose: Lucide ships marks for Facebook, Instagram and LinkedIn but none for
 * TikTok, so an icon set would render three channels one way and the fourth
 * another — the "same element never looks two different ways" rule broken
 * inside a single list. Colours come from the existing tile tints, so no new
 * hue enters the palette and nothing here imitates another company's mark.
 *
 * This is a scanning aid beside the text, never a replacement for it: rows
 * still carry the channel name, and the monogram is hidden from assistive tech.
 */
export function ChannelMonogram({ channel, className }: Props) {
  const style = CHANNEL_STYLES[channel.toUpperCase()] ?? {
    initial: channel.slice(0, 2).toUpperCase(),
    className: "bg-tile-neutral-bg text-tile-neutral-fg",
    label: channel,
  };

  return (
    <span
      aria-hidden="true"
      title={style.label}
      className={[
        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] leading-none font-bold",
        style.className,
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {style.initial}
    </span>
  );
}
