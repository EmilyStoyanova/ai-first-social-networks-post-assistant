type Variant =
  "owner" | "editor" | "comingSoon" | "success" | "warning" | "danger" | "neutral" | "readonly";

interface Props {
  variant: Variant;
  children: React.ReactNode;
  className?: string;
}

// Generic badge — role/meta labels. Post/run statuses use StatusBadge (§6.2),
// which owns the canonical status→color map.
const VARIANT_CLASSES: Record<Variant, string> = {
  owner: "bg-status-success-bg text-status-success-fg",
  editor: "bg-surface-subtle text-fg-muted",
  comingSoon: "bg-surface-subtle text-fg-faint",
  success: "bg-status-success-bg text-status-success-fg",
  warning: "bg-status-warning-bg text-status-warning-fg",
  danger: "bg-status-danger-bg text-status-danger-fg",
  neutral: "bg-status-neutral-bg text-status-neutral-fg",
  readonly: "bg-surface-subtle text-fg-faint",
};

export function Badge({ variant, children, className }: Props) {
  return (
    <span
      className={[
        "text-micro inline-flex h-[22px] items-center rounded-full px-2.5",
        VARIANT_CLASSES[variant],
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </span>
  );
}
