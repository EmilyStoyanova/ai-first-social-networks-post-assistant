interface Props {
  id: string;
  name: string;
  label: string;
  type?: React.HTMLInputTypeAttribute;
  placeholder?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  helperText?: string;
  /** Outer wrapper class — use for field spacing, e.g. "mb-4" or "mb-6" */
  className?: string;
}

export function Input({
  id,
  name,
  label,
  type = "text",
  placeholder,
  autoComplete,
  autoFocus,
  required,
  disabled,
  error,
  helperText,
  className,
}: Props) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-gray-700">
        {label}
        {required && (
          <span className="ml-1 text-red-500" aria-hidden="true">
            *
          </span>
        )}
      </label>

      <input
        id={id}
        name={name}
        type={type}
        placeholder={placeholder}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        required={required}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : helperText ? hintId : undefined}
        className={[
          "w-full rounded-lg border px-3.5 py-2.5 text-sm transition-all duration-200 outline-none",
          "focus:ring-2 focus:ring-offset-0",
          error
            ? "border-red-400 bg-red-50 focus:border-red-500 focus:ring-red-200"
            : "border-gray-300 bg-white focus:border-green-500 focus:ring-green-100",
          disabled ? "cursor-not-allowed opacity-60" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      />

      {error ? (
        <p id={errorId} className="mt-1.5 text-xs text-red-600">
          {error}
        </p>
      ) : helperText ? (
        <p id={hintId} className="mt-1.5 text-xs text-gray-400">
          {helperText}
        </p>
      ) : null}
    </div>
  );
}
