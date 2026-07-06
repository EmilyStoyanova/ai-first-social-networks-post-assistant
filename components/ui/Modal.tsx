"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { X } from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  maxWidth?: "sm" | "md" | "lg" | "xl";
}

const MAX_WIDTH_CLASS: Record<string, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-xl",
};

export function Modal({ open, onClose, title, children, maxWidth = "lg" }: Props) {
  const t = useTranslations("common");
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      prev?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {/* Backdrop */}
      <div
        className="animate-fade-in bg-fg/40 absolute inset-0"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel — §6.4: radius 10, shadow-lg; §6.9: fade + 4px rise */}
      <div
        ref={panelRef}
        tabIndex={-1}
        className={[
          "rounded-panel animate-panel-in border-border bg-surface relative z-10 w-full border shadow-lg outline-none",
          MAX_WIDTH_CLASS[maxWidth] ?? MAX_WIDTH_CLASS.lg,
        ].join(" ")}
      >
        {/* Header */}
        <div className="border-border flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-title text-fg">{title}</h2>
          <button
            onClick={onClose}
            className="rounded-control focus-ring text-fg-faint duration-fast hover:bg-surface-subtle hover:text-fg p-1 transition-colors"
            aria-label={t("close")}
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[80vh] overflow-y-auto px-6 py-5">{children}</div>
      </div>
    </div>
  );
}
