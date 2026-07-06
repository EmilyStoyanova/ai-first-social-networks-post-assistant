export type ChannelValue = "facebook" | "linkedin" | "instagram" | "tiktok";

// Brand names are not translated. Text-only — in this identity typography
// carries meaning, not pictographs (§6.8), and Lucide ships no brand icons.
const CHANNEL_LABELS: Record<ChannelValue, string> = {
  facebook: "Facebook",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  tiktok: "TikTok",
};

interface Props {
  channel: ChannelValue;
  size?: "sm" | "md";
  className?: string;
}

export function ChannelChip({ channel, size = "md", className }: Props) {
  return (
    <span
      className={[
        "text-small bg-surface-subtle text-fg-muted inline-flex items-center rounded-full font-semibold",
        size === "sm" ? "px-2 py-0.5" : "px-2.5 py-0.5",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {CHANNEL_LABELS[channel]}
    </span>
  );
}
