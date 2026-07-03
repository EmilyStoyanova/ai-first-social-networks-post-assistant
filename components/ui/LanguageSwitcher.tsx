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
            "rounded px-2 py-0.5 text-xs font-semibold uppercase transition-colors",
            l === locale
              ? "bg-green-500 text-white"
              : "text-gray-400 hover:bg-gray-100 hover:text-gray-700",
          ].join(" ")}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
