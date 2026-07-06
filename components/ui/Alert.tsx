import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";

type Variant = "success" | "error" | "warning" | "info";

interface Props {
  variant: Variant;
  children: React.ReactNode;
  role?: "alert" | "status";
  className?: string;
}

// §6.6: status tint background + hairline border in the dot color.
const STYLES: Record<Variant, { wrapper: string; text: string; iconColor: string }> = {
  success: {
    wrapper: "border-status-success-dot/40 bg-status-success-bg",
    text: "text-status-success-fg",
    iconColor: "text-status-success-dot",
  },
  error: {
    wrapper: "border-status-danger-dot/40 bg-status-danger-bg",
    text: "text-status-danger-fg",
    iconColor: "text-status-danger-dot",
  },
  warning: {
    wrapper: "border-status-warning-dot/40 bg-status-warning-bg",
    text: "text-status-warning-fg",
    iconColor: "text-status-warning-dot",
  },
  info: {
    wrapper: "border-status-info-dot/40 bg-status-info-bg",
    text: "text-status-info-fg",
    iconColor: "text-status-info-dot",
  },
};

const DEFAULT_ROLE: Record<Variant, "alert" | "status"> = {
  success: "status",
  error: "alert",
  warning: "alert",
  info: "alert",
};

const ICONS: Record<
  Variant,
  React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>
> = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

export function Alert({ variant, children, role, className }: Props) {
  const styles = STYLES[variant];
  const Icon = ICONS[variant];
  return (
    <div
      role={role ?? DEFAULT_ROLE[variant]}
      className={[
        "rounded-card flex items-start gap-3 border px-4 py-3",
        styles.wrapper,
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span className={styles.iconColor}>
        <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      </span>
      <p className={["text-small", styles.text].join(" ")}>{children}</p>
    </div>
  );
}
