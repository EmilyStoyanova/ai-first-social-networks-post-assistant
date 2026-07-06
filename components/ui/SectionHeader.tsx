interface Props {
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

// Micro overline section header — groups are separated by whitespace, not boxes (§6.5).
export function SectionHeader({ title, description, action, className }: Props) {
  return (
    <div
      className={["flex items-center justify-between gap-4", className ?? ""]
        .filter(Boolean)
        .join(" ")}
    >
      <div>
        <h2 className="text-micro text-fg-muted">{title}</h2>
        {description && <p className="text-small text-fg-muted mt-0.5">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
