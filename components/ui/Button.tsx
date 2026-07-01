import Link from "next/link";

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
  primary:
    "bg-green-500 text-white hover:bg-green-600 disabled:cursor-not-allowed disabled:opacity-60",
  secondary:
    "bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-60",
  ghost: "text-gray-600 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60",
  danger: "bg-red-500 text-white hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-60",
};

const SIZE_CLASSES: Record<Size, string> = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
  lg: "px-5 py-2.5 text-sm",
};

function buildClass(variant: Variant, size: Size, fullWidth: boolean, extra?: string): string {
  return [
    "inline-flex items-center justify-center gap-2 rounded-lg font-semibold",
    "transition-colors duration-200",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2",
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

  const content = (
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
      className={cls}
    >
      {content}
    </button>
  );
}
