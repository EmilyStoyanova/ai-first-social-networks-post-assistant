"use client";

import { slotOptions } from "@/lib/scheduling/time-slots";

interface Props {
  id?: string;
  /** `HH:mm`, business-zone wall clock. Empty when no time has been chosen yet. */
  value: string;
  /** Called with the chosen `HH:mm` — always one of the offered slots. */
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Marks the field when the time it holds is not usable, e.g. already past. */
  invalid?: boolean;
  /**
   * Shown while `value` is empty — the label for "no time chosen yet".
   *
   * Only the bulk editor needs it, and only for a channel with no posting
   * windows to seed from: there is no hour to pre-fill and the app will not
   * invent one, so the picker has to be able to say so. Callers that always hold
   * a real time leave it out and the option is never rendered.
   */
  placeholder?: string;
  "aria-label"?: string;
  /** Class for the `<select>` itself — its padding, text size and width. */
  className?: string;
}

/**
 * Picks a publish time, offering only the times the publishing sweep can hit —
 * 00:00, 00:30 … 23:30 (see lib/scheduling/time-slots.ts).
 *
 * A `<select>` rather than `<input type="time" step>`: `step` is only advisory,
 * so every browser still lets a 16:15 be typed in and merely marks the field
 * invalid afterwards. A select cannot hold a time that was not offered, which is
 * the whole point — and it needs no validation message of its own.
 *
 * An off-slot `value` — a post scheduled before this existed — is still shown as
 * itself rather than snapped or dropped, so nothing rewrites a time behind the
 * user's back. Whatever they pick instead is a slot.
 *
 * An EMPTY `value` is the other case the list has to be able to show: no time has
 * been chosen and the app has none to suggest. It renders as a disabled
 * placeholder — pickable out of, never back into, because "unset" is a state to
 * leave rather than a choice to make.
 */
export function TimeSlotSelect({
  id,
  value,
  onChange,
  disabled,
  invalid,
  placeholder,
  "aria-label": ariaLabel,
  className = "",
}: Props) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      aria-label={ariaLabel}
      className={[
        // Deliberately no padding or text size of its own: the two callers sit in
        // differently sized rows, and a base `px-2` that a caller has to override
        // with `px-3` is decided by stylesheet order rather than by the caller.
        "rounded-control bg-surface focus:ring-accent/20 border tabular-nums",
        "outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60",
        invalid
          ? "border-status-danger-fg text-status-danger-fg"
          : "border-border-strong focus:border-accent",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {value === "" && (
        <option value="" disabled>
          {placeholder ?? "--:--"}
        </option>
      )}
      {slotOptions(value).map((slot) => (
        <option key={slot} value={slot}>
          {slot}
        </option>
      ))}
    </select>
  );
}
