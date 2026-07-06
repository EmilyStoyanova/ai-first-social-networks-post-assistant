import Link from "next/link";
import { Loader2 } from "lucide-react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

interface Props {
  variant?: Variant;
  size?: Size;
  fullWidth?: boolean;
  loading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  // Link mode — renders as Next.js Link when provided
  href?: string;
  // Button mode
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  "aria-label"?: string;
}

const VARIANT_CLASSES: Record<Variant, string> = {
  // Ink primary — the strongest neutral on the page (§6.5); never accent-colored.
  primary: "bg-fg text-bg hover:bg-fg/90 disabled:cursor-not-allowed disabled:opacity-45",
  secondary:
    "border border-border bg-surface text-fg hover:bg-surface-subtle disabled:cursor-not-allowed disabled:opacity-45",
  ghost:
    "text-fg-muted hover:bg-surface-subtle hover:text-fg disabled:cursor-not-allowed disabled:opacity-45",
  // Only inside ConfirmDialog and the danger zone.
  danger: "bg-danger text-white hover:bg-danger/90 disabled:cursor-not-allowed disabled:opacity-45",
};

// Heights per §6.5: 36 default / 32 compact / 40 auth.
const SIZE_CLASSES: Record<Size, string> = {
  sm: "h-8 px-3",
  md: "h-9 px-4",
  lg: "h-10 px-5",
};

function buildClass(variant: Variant, size: Size, fullWidth: boolean, extra?: string): string {
  return [
    "relative inline-flex items-center justify-center gap-2 rounded-control text-sm font-semibold",
    "transition-colors duration-fast focus-ring",
    VARIANT_CLASSES[variant],
    SIZE_CLASSES[size],
    fullWidth ? "w-full" : "",
    extra ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function Button({
  variant = "primary",
  size = "md",
  fullWidth = false,
  loading = false,
  leftIcon,
  rightIcon,
  children,
  className,
  href,
  type = "button",
  disabled,
  onClick,
  "aria-label": ariaLabel,
}: Props) {
  const cls = buildClass(variant, size, fullWidth, className);

  // Loading: spinner replaces the label, width stays locked (§6.5).
  const content = loading ? (
    <>
      <span className="invisible inline-flex items-center gap-2">
        {leftIcon}
        {children}
        {rightIcon}
      </span>
      <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
        <Loader2 className="h-4 w-4 animate-spin" />
      </span>
    </>
  ) : (
    <>
      {leftIcon}
      {children}
      {rightIcon}
    </>
  );

  if (href) {
    return (
      <Link href={href} className={cls} aria-label={ariaLabel}>
        {content}
      </Link>
    );
  }

  return (
    <button
      type={type}
      disabled={disabled || loading}
      onClick={onClick}
      aria-label={ariaLabel}
      aria-busy={loading || undefined}
      className={cls}
    >
      {content}
    </button>
  );
}
