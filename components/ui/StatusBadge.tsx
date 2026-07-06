import { useTranslations } from "next-intl";

// Canonical status→color map (§6.2). Callers never pass colors — the map
// lives here and only here. No per-page status styling anywhere.
export type PostStatusValue =
  | "draft"
  | "pending_approval"
  | "approved"
  | "sent_to_buffer"
  | "published"
  | "failed"
  | "rejected";

type BadgeVariant = "tint" | "outline";

const STATUS_STYLES: Record<
  PostStatusValue,
  { variant: BadgeVariant; badge: string; dot: string }
> = {
  draft: {
    variant: "tint",
    badge: "bg-status-neutral-bg text-status-neutral-fg",
    dot: "bg-status-neutral-dot",
  },
  pending_approval: {
    variant: "tint",
    badge: "bg-status-warning-bg text-status-warning-fg",
    dot: "bg-status-warning-dot",
  },
  approved: {
    variant: "outline",
    badge: "border border-status-success-dot/50 bg-surface text-status-success-fg",
    dot: "bg-status-success-dot",
  },
  sent_to_buffer: {
    variant: "tint",
    badge: "bg-status-info-bg text-status-info-fg",
    dot: "bg-status-info-dot",
  },
  published: {
    variant: "tint",
    badge: "bg-status-success-bg text-status-success-fg-deep",
    dot: "bg-status-success-dot",
  },
  failed: {
    variant: "tint",
    badge: "bg-status-danger-bg text-status-danger-fg",
    dot: "bg-status-danger-dot",
  },
  rejected: {
    variant: "outline",
    badge: "border border-status-danger-dot/50 bg-surface text-status-danger-fg",
    dot: "bg-status-danger-dot",
  },
};

interface Props {
  status: PostStatusValue;
  /** Override the default translated label (e.g. "Failed · 2/3"). */
  label?: string;
  className?: string;
}

export function StatusBadge({ status, label, className }: Props) {
  const t = useTranslations("posts.statuses");
  const styles = STATUS_STYLES[status];
  const text = label ?? t(status.toUpperCase());

  return (
    <span
      className={[
        "text-micro inline-flex h-[22px] items-center gap-1.5 rounded-full px-2.5",
        styles.badge,
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span className={["h-1.5 w-1.5 shrink-0 rounded-full", styles.dot].join(" ")} aria-hidden />
      {text}
    </span>
  );
}
