import { ChevronDown } from "lucide-react";

interface Props {
  id: string;
  name?: string;
  label?: string;
  value?: string;
  defaultValue?: string;
  onChange?: React.ChangeEventHandler<HTMLSelectElement>;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  helperText?: string;
  children: React.ReactNode;
  className?: string;
}

// Styled native <select> — no custom dropdown in v1 (§6.5).
export function Select({
  id,
  name,
  label,
  value,
  defaultValue,
  onChange,
  required,
  disabled,
  error,
  helperText,
  children,
  className,
}: Props) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  return (
    <div className={className}>
      {label && (
        <label htmlFor={id} className="text-small mb-label text-fg block font-semibold">
          {label}
          {required && (
            <span className="text-status-danger-dot ml-1" aria-hidden="true">
              *
            </span>
          )}
        </label>
      )}

      <div className="relative">
        <select
          id={id}
          name={name}
          value={value}
          defaultValue={defaultValue}
          onChange={onChange}
          required={required}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : helperText ? hintId : undefined}
          className={[
            "text-body rounded-control bg-surface text-fg h-9 w-full appearance-none border pr-9 pl-3 outline-none",
            "duration-fast transition-colors",
            "focus-visible:outline-accent focus-visible:outline-2 focus-visible:outline-offset-0",
            error ? "border-status-danger-dot" : "border-border",
            disabled ? "cursor-not-allowed opacity-45" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {children}
        </select>
        <ChevronDown
          className="text-fg-muted pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2"
          aria-hidden
        />
      </div>

      {error ? (
        <p id={errorId} className="text-small text-status-danger-fg mt-1.5">
          {error}
        </p>
      ) : helperText ? (
        <p id={hintId} className="text-small text-fg-muted mt-1.5">
          {helperText}
        </p>
      ) : null}
    </div>
  );
}
