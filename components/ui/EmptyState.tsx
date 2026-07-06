interface Props {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}

// §6.6: centered — muted icon, one title line, one body line, one button. Never more.
export function EmptyState({ icon, title, description, action }: Props) {
  return (
    <div className="rounded-card border-border-strong bg-surface border border-dashed px-8 py-16 text-center">
      {icon && (
        <div className="text-fg-faint mb-3 flex justify-center" aria-hidden="true">
          {icon}
        </div>
      )}
      <p className="text-title text-fg">{title}</p>
      {description && <p className="text-body text-fg-muted mt-1">{description}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
