type Variant = "success" | "error" | "warning" | "info";

interface Props {
  variant: Variant;
  children: React.ReactNode;
  role?: "alert" | "status";
  className?: string;
}

const STYLES: Record<Variant, { wrapper: string; text: string; iconColor: string }> = {
  success: {
    wrapper: "border-green-200 bg-green-50",
    text: "text-green-700",
    iconColor: "text-green-600",
  },
  error: {
    wrapper: "border-red-200 bg-red-50",
    text: "text-red-700",
    iconColor: "text-red-500",
  },
  warning: {
    wrapper: "border-yellow-200 bg-yellow-50",
    text: "text-yellow-700",
    iconColor: "text-yellow-500",
  },
  info: {
    wrapper: "border-blue-200 bg-blue-50",
    text: "text-blue-700",
    iconColor: "text-blue-500",
  },
};

const DEFAULT_ROLE: Record<Variant, "alert" | "status"> = {
  success: "status",
  error: "alert",
  warning: "alert",
  info: "alert",
};

function CheckIcon() {
  return (
    <svg
      className="mt-0.5 h-4 w-4 shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2.5}
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
    </svg>
  );
}

function TriangleIcon() {
  return (
    <svg
      className="mt-0.5 h-4 w-4 shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2.5}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
      />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg
      className="mt-0.5 h-4 w-4 shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2.5}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

function AlertIcon({ variant }: { variant: Variant }) {
  if (variant === "success") return <CheckIcon />;
  if (variant === "info") return <InfoIcon />;
  return <TriangleIcon />;
}

export function Alert({ variant, children, role, className }: Props) {
  const styles = STYLES[variant];
  return (
    <div
      role={role ?? DEFAULT_ROLE[variant]}
      className={[
        "flex items-start gap-3 rounded-xl border px-4 py-3",
        styles.wrapper,
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span className={styles.iconColor}>
        <AlertIcon variant={variant} />
      </span>
      <p className={["text-sm", styles.text].join(" ")}>{children}</p>
    </div>
  );
}
