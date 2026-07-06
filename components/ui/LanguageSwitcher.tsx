"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";

export function LanguageSwitcher() {
  const locale = useLocale();
  const [pendingLocale, setPendingLocale] = useState<string | null>(null);

  useEffect(() => {
    if (pendingLocale === null) return;
    document.cookie = `NEXT_LOCALE=${pendingLocale}; path=/; max-age=31536000; SameSite=Lax`;
    window.location.reload();
  }, [pendingLocale]);

  return (
    <div className="flex gap-1">
      {(["en", "bg"] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setPendingLocale(l)}
          className={[
            "text-micro rounded-control focus-ring duration-fast px-2 py-0.5 transition-colors",
            l === locale
              ? "bg-surface-subtle text-fg"
              : "text-fg-faint hover:bg-surface-subtle hover:text-fg",
          ].join(" ")}
          aria-pressed={l === locale}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
