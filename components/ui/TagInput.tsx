"use client";

import { useState } from "react";
import { X } from "lucide-react";

interface Props {
  id: string;
  label: string;
  /** Muted text after the label, e.g. what the list is used for. */
  hint?: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Server-side / form-level error, shown under the field. */
  error?: string;
  /**
   * Vets a candidate before it becomes a tag. Return a message to refuse it,
   * or null to accept. The caller owns the rules — this component only asks.
   */
  validate?: (candidate: string) => string | null;
  /** Applied to an accepted candidate before it is stored. */
  normalize?: (raw: string) => string;
  addLabel: string;
  /** Accessible name of a tag's remove button, e.g. `Remove "paints"`. */
  removeLabel: (tag: string) => string;
  emptyText: string;
  className?: string;
}

/**
 * A list of short strings, edited as chips.
 *
 * Enter or comma commits what is typed; Backspace on an empty box removes the
 * last chip. Rejection is immediate and inline: a refused candidate stays in the
 * box with the reason under it, so nothing the user typed is lost and nothing
 * invalid can reach the list.
 */
export function TagInput({
  id,
  label,
  hint,
  values,
  onChange,
  placeholder,
  disabled,
  error,
  validate,
  normalize,
  addLabel,
  removeLabel,
  emptyText,
  className,
}: Props) {
  const [draft, setDraft] = useState("");
  const [rejection, setRejection] = useState<string | null>(null);

  const errorId = `${id}-error`;
  const message = rejection ?? error;

  function commit() {
    const candidate = normalize ? normalize(draft) : draft.trim();
    if (!candidate) {
      // An empty box is how the user leaves the field, not a mistake worth a
      // message — only a non-empty draft can be refused.
      setDraft("");
      setRejection(null);
      return;
    }

    const refusal = validate?.(candidate) ?? null;
    if (refusal) {
      setRejection(refusal);
      return;
    }

    onChange([...values, candidate]);
    setDraft("");
    setRejection(null);
  }

  function remove(index: number) {
    onChange(values.filter((_, i) => i !== index));
    setRejection(null);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      // Enter inside a form would submit it; committing a tag is what the key
      // means here.
      e.preventDefault();
      commit();
      return;
    }
    if (e.key === "Backspace" && draft === "" && values.length > 0) {
      e.preventDefault();
      remove(values.length - 1);
    }
  }

  return (
    <div className={className}>
      <label htmlFor={id} className="text-small mb-label text-fg block font-semibold">
        {label}
        {hint && <span className="text-fg-faint ml-1.5 font-normal">{hint}</span>}
      </label>

      <div className="mb-2 flex flex-wrap gap-1.5" aria-live="polite">
        {values.length === 0 ? (
          <p className="text-small text-fg-faint">{emptyText}</p>
        ) : (
          values.map((tag, index) => (
            <span
              key={`${tag}-${index}`}
              className="bg-surface-subtle text-fg text-small inline-flex items-center gap-1 rounded-full py-1 pr-1 pl-2.5"
            >
              {tag}
              {!disabled && (
                <button
                  type="button"
                  onClick={() => remove(index)}
                  aria-label={removeLabel(tag)}
                  className="text-fg-faint hover:text-status-danger-fg duration-fast focus-visible:outline-accent rounded-full p-0.5 transition-colors focus-visible:outline-2"
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </span>
          ))
        )}
      </div>

      <div className="flex gap-2">
        <input
          id={id}
          type="text"
          value={draft}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => {
            setDraft(e.target.value);
            if (rejection) setRejection(null);
          }}
          onKeyDown={handleKeyDown}
          onBlur={commit}
          aria-invalid={message ? true : undefined}
          aria-describedby={message ? errorId : undefined}
          className={[
            "text-body rounded-control bg-surface text-fg h-9 w-full border px-3 outline-none",
            "duration-fast placeholder:text-fg-faint transition-colors",
            "focus-visible:outline-accent focus-visible:outline-2 focus-visible:outline-offset-0",
            message ? "border-status-danger-dot" : "border-border",
            disabled ? "cursor-not-allowed opacity-45" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        />
        <button
          type="button"
          onClick={commit}
          disabled={disabled}
          className="text-small rounded-control border-border text-fg-muted hover:bg-surface-subtle duration-fast focus-visible:outline-accent h-9 shrink-0 border px-3 font-medium transition-colors focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {addLabel}
        </button>
      </div>

      {message && (
        <p id={errorId} className="text-small text-status-danger-fg mt-1.5">
          {message}
        </p>
      )}
    </div>
  );
}
