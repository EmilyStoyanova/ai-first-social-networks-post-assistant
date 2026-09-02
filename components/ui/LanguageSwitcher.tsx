"use client";

import { LOCALES, useLocaleSwitch } from "@/lib/i18n/use-locale-switch";

/**
 * The compact inline EN/BG toggle. Since the header's account menu took over
 * language switching for the dashboard, this remains in use on the auth pages
 * (`app/(auth)/layout.tsx`), which have no account menu to put it in.
 *
 * The cookie write and reload live in `useLocaleSwitch` so this and the account
 * menu share one mechanism rather than two copies of it.
 */
export function LanguageSwitcher() {
  const { locale, switchLocale } = useLocaleSwitch();

  return (
    <div className="flex gap-1">
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => switchLocale(l)}
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
