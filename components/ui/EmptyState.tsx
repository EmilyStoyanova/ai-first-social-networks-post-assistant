interface Props {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}

export function EmptyState({ icon, title, description, action }: Props) {
  return (
    <div className="rounded-2xl border border-dashed border-gray-300 bg-white px-8 py-16 text-center">
      {icon && (
        <div className="mb-3 flex justify-center">
          <span className="text-3xl" aria-hidden="true">
            {icon}
          </span>
        </div>
      )}
      <p className="text-sm font-medium text-gray-500">{title}</p>
      {description && <p className="mt-1 text-sm text-gray-400">{description}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
