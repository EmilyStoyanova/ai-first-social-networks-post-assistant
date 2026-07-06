import { Skeleton } from "./Skeleton";

export interface DataTableColumn<T> {
  key: string;
  header: string;
  /** data role (right-aligned tabular numerals) for timestamps/counts (§6.6). */
  align?: "left" | "right";
  render: (row: T) => React.ReactNode;
}

interface Props<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  skeletonRows?: number;
  /** Rendered when rows is empty and not loading. */
  emptyState?: React.ReactNode;
  className?: string;
}

// §6.6: micro-uppercase header above a hairline, horizontal hairlines only,
// hover surface-subtle, sticky header. Compact density comes from a
// data-density="compact" ancestor (§6.10), not from per-table styling.
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  skeletonRows = 5,
  emptyState,
  className,
}: Props<T>) {
  if (!loading && rows.length === 0 && emptyState) {
    return <>{emptyState}</>;
  }

  return (
    <div className={["overflow-x-auto", className ?? ""].filter(Boolean).join(" ")}>
      <table className="w-full border-collapse">
        <thead className="bg-bg sticky top-0">
          <tr className="border-border border-b">
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={[
                  "text-micro text-fg-muted px-4 py-2",
                  col.align === "right" ? "text-right" : "text-left",
                ].join(" ")}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: skeletonRows }).map((_, i) => (
                <tr key={i} className="border-border border-b">
                  {columns.map((col) => (
                    <td key={col.key} className="px-4 py-3">
                      <Skeleton variant="line" />
                    </td>
                  ))}
                </tr>
              ))
            : rows.map((row) => (
                <tr
                  key={rowKey(row)}
                  className="border-border duration-fast hover:bg-surface-subtle h-12 border-b transition-colors"
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={[
                        "text-body text-fg px-4 py-2",
                        col.align === "right" ? "text-data text-right" : "text-left",
                      ].join(" ")}
                    >
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
        </tbody>
      </table>
    </div>
  );
}
