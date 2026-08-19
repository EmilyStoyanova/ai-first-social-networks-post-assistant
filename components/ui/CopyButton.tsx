"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Copy } from "lucide-react";

interface Props {
  /** The text put on the clipboard. Never truncated for display reasons. */
  value: string;
  /** Accessible name; falls back to the generic "Copy". */
  label?: string;
  className?: string;
}

/**
 * Copy-to-clipboard, for values that are meant to leave the page.
 *
 * A prompt, a raw model reply or a context snapshot is read by pasting it
 * somewhere else — a diff, a ticket, another model — so the copy is of the WHOLE
 * value even when the panel shows a shortened version of it.
 *
 * `navigator.clipboard` is unavailable over plain HTTP and in some embedded
 * webviews. Rather than fail silently, the button falls back to selecting the
 * text through a hidden textarea, which works everywhere the app runs.
 */
export function CopyButton({ value, label, className }: Props) {
  const t = useTranslations("generationTrace");
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  async function handleCopy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const area = document.createElement("textarea");
        area.value = value;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
      }
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      // Nothing useful to say — the value is still on screen and selectable.
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={label ?? t("copy")}
      className={[
        "rounded-control focus-ring border-border text-fg-faint hover:text-fg hover:bg-surface-subtle",
        "duration-fast inline-flex shrink-0 items-center gap-1 border px-2 py-1 text-xs transition-colors",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {copied ? (
        <Check className="h-3 w-3" aria-hidden />
      ) : (
        <Copy className="h-3 w-3" aria-hidden />
      )}
      {copied ? t("copied") : t("copy")}
    </button>
  );
}
