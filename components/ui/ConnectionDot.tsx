export type ConnectionState = "connected" | "reconnect" | "disconnected";

// Dot-variant status language for integration states (§6.2).
const STATE_STYLES: Record<ConnectionState, { dot: string; text: string }> = {
  connected: { dot: "bg-status-success-dot", text: "text-status-success-fg" },
  reconnect: { dot: "bg-status-warning-dot", text: "text-status-warning-fg" },
  disconnected: { dot: "bg-status-danger-dot", text: "text-status-danger-fg" },
};

interface Props {
  state: ConnectionState;
  /** Visible label — color is never the only signal (§6.2). */
  label: string;
  className?: string;
}

export function ConnectionDot({ state, label, className }: Props) {
  const styles = STATE_STYLES[state];

  return (
    <span
      className={["text-small inline-flex items-center gap-1.5", styles.text, className ?? ""]
        .filter(Boolean)
        .join(" ")}
    >
      <span className={["h-2 w-2 shrink-0 rounded-full", styles.dot].join(" ")} aria-hidden />
      {label}
    </span>
  );
}
