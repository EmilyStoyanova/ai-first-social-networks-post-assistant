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
    "flex overflow-hidden rounded-lg border transition-all duration-200",
    "focus-within:ring-2 focus-within:ring-offset-0",
    hasError
      ? "border-red-400 bg-red-50 focus-within:border-red-500 focus-within:ring-red-200"
      : "border-gray-300 bg-white focus-within:border-green-500 focus-within:ring-green-100",
    disabled ? "opacity-60" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-gray-700">
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
          className="h-10 w-10 shrink-0 cursor-pointer border-0 bg-transparent p-1 disabled:cursor-not-allowed"
        />

        {/* Visual separator */}
        <div className="my-2 w-px shrink-0 bg-gray-200" aria-hidden="true" />

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
          className="flex-1 bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-gray-400 disabled:cursor-not-allowed"
        />
      </div>

      {hasError && (
        <p id={errorId} className="mt-1.5 text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
