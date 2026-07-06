"use client";

import { useState } from "react";

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

interface Props {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  disabled?: boolean;
}

/**
 * Combined color picker + HEX text input.
 *
 * The text field is the canonical value passed to `onChange`. The picker
 * tracks the last valid hex so it doesn't snap to black while the user is
 * mid-edit (e.g. they've typed "#22C5" but haven't finished yet).
 */
export function ColorField({ id, label, value, onChange, error, disabled }: Props) {
  // `pickerColor` always holds a valid hex — updated only in event handlers,
  // never during render (satisfies react-hooks/refs and avoids stale-closure issues).
  const [pickerColor, setPickerColor] = useState<string>(HEX_RE.test(value) ? value : "#000000");

  function handlePickerChange(e: React.ChangeEvent<HTMLInputElement>) {
    const color = e.target.value; // <input type="color"> always emits valid 6-digit hex
    setPickerColor(color);
    onChange(color);
  }

  function handleTextChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    onChange(v);
    // Only advance the picker when the text is a complete, valid hex.
    if (HEX_RE.test(v)) setPickerColor(v);
  }

  const hasError = Boolean(error);
  const errorId = `${id}-error`;
  const pickerId = `${id}-picker`;

  const wrapperCls = [
    "flex overflow-hidden rounded-control border bg-surface transition-colors duration-fast",
    "focus-within:outline-2 focus-within:outline-offset-0 focus-within:outline-accent",
    hasError ? "border-status-danger-dot" : "border-border",
    disabled ? "opacity-45" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div>
      <label htmlFor={id} className="text-small mb-label text-fg block font-semibold">
        {label}
      </label>

      <div className={wrapperCls}>
        {/* Color swatch — keyboard-accessible, opens the native color dialog */}
        <input
          type="color"
          id={pickerId}
          value={pickerColor}
          onChange={handlePickerChange}
          disabled={disabled}
          aria-label={`${label} color picker`}
          title={`Pick ${label}`}
          className="h-9 w-9 shrink-0 cursor-pointer border-0 bg-transparent p-1 disabled:cursor-not-allowed"
        />

        {/* Visual separator */}
        <div className="bg-border my-2 w-px shrink-0" aria-hidden="true" />

        {/* Canonical HEX text — this value is what gets validated and saved */}
        <input
          type="text"
          id={id}
          value={value}
          onChange={handleTextChange}
          placeholder="#22C55E"
          disabled={disabled}
          aria-invalid={hasError ? true : undefined}
          aria-describedby={hasError ? errorId : undefined}
          className="text-body text-fg placeholder:text-fg-faint flex-1 bg-transparent px-3 py-1.5 outline-none disabled:cursor-not-allowed"
        />
      </div>

      {hasError && (
        <p id={errorId} className="text-small text-status-danger-fg mt-1.5">
          {error}
        </p>
      )}
    </div>
  );
}
