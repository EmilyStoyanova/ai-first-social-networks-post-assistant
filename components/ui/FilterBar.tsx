"use client";

import { X } from "lucide-react";
import { Select } from "./Select";

export interface FilterConfig {
  id: string;
  label: string;
  options: { value: string; label: string }[];
  /** Label of the "all" option, shown when the filter is inactive. */
  allLabel: string;
}

interface Props {
  filters: FilterConfig[];
  /** Current values keyed by filter id; "" (or absent) = inactive. */
  value: Record<string, string>;
  onChange: (id: string, value: string) => void;
  /** Label for the clear-all control, shown when any filter is active. */
  clearLabel: string;
  onClear: () => void;
  /** Right-aligned slot — typically the page's primary action. */
  actions?: React.ReactNode;
  className?: string;
}

// Horizontal filter controls + clear (§7 #11). Spatial stability: filters live
// in the same place on every list page.
export function FilterBar({
  filters,
  value,
  onChange,
  clearLabel,
  onClear,
  actions,
  className,
}: Props) {
  const anyActive = filters.some((f) => (value[f.id] ?? "") !== "");

  return (
    <div
      className={["flex flex-wrap items-center gap-2", className ?? ""].filter(Boolean).join(" ")}
    >
      {filters.map((filter) => (
        <Select
          key={filter.id}
          id={`filter-${filter.id}`}
          value={value[filter.id] ?? ""}
          onChange={(e) => onChange(filter.id, e.target.value)}
          className="w-44"
        >
          <option value="">{filter.allLabel}</option>
          {filter.options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </Select>
      ))}

      {anyActive && (
        <button
          type="button"
          onClick={onClear}
          className="text-small rounded-control focus-ring text-fg-muted duration-fast hover:bg-surface-subtle hover:text-fg inline-flex items-center gap-1 px-2 py-1 transition-colors"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
          {clearLabel}
        </button>
      )}

      {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
