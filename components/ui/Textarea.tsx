interface Props {
  id: string;
  name?: string;
  label?: string;
  value?: string;
  defaultValue?: string;
  onChange?: React.ChangeEventHandler<HTMLTextAreaElement>;
  placeholder?: string;
  rows?: number;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  helperText?: string;
  /** Post-content editing renders in the reading role (§6.5) — the text stays the visual center. */
  reading?: boolean;
  maxLength?: number;
  className?: string;
}

export function Textarea({
  id,
  name,
  label,
  value,
  defaultValue,
  onChange,
  placeholder,
  rows = 4,
  required,
  disabled,
  error,
  helperText,
  reading = false,
  maxLength,
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

      <textarea
        id={id}
        name={name}
        value={value}
        defaultValue={defaultValue}
        onChange={onChange}
        placeholder={placeholder}
        rows={rows}
        required={required}
        disabled={disabled}
        maxLength={maxLength}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : helperText ? hintId : undefined}
        className={[
          reading ? "text-reading" : "text-body",
          "rounded-control bg-surface text-fg w-full border px-3 py-2 outline-none",
          "duration-fast placeholder:text-fg-faint transition-colors",
          "focus-visible:outline-accent focus-visible:outline-2 focus-visible:outline-offset-0",
          error ? "border-status-danger-dot" : "border-border",
          disabled ? "cursor-not-allowed opacity-45" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      />

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
