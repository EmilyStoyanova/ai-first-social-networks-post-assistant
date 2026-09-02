"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";

/** The two locales this app ships. Kept here so the switcher UIs enumerate one
 *  list rather than each hard-coding their own. */
export const LOCALES = ["en", "bg"] as const;
export type AppLocale = (typeof LOCALES)[number];

/**
 * The app's ONE locale-switching mechanism, extracted from
 * `components/ui/LanguageSwitcher.tsx` unchanged so the header's account menu
 * and the auth pages' inline switcher share it instead of growing a second
 * implementation.
 *
 * Behaviour is deliberately identical to what `LanguageSwitcher` always did:
 * write the plain `NEXT_LOCALE` cookie that `i18n/request.ts` reads
 * server-side, then a full reload so every server-rendered string on the page
 * is re-fetched in the new locale. The write happens in an effect reacting to
 * state rather than inside the click handler — the pattern this repo already
 * uses here and in `CompanySelector`.
 *
 * No new locale state: `next-intl` remains the source of truth for the current
 * locale (`useLocale`), and the cookie remains the only persistence.
 */
export function useLocaleSwitch() {
  const locale = useLocale();
  const [pendingLocale, setPendingLocale] = useState<string | null>(null);

  useEffect(() => {
    if (pendingLocale === null) return;
    document.cookie = `NEXT_LOCALE=${pendingLocale}; path=/; max-age=31536000; SameSite=Lax`;
    window.location.reload();
  }, [pendingLocale]);

  return {
    /** The active locale, straight from next-intl. */
    locale,
    /** Request a switch. A no-op when it is already the active locale — the
     *  reload would otherwise be a visible cost for no change. */
    switchLocale: (next: AppLocale) => {
      if (next === locale) return;
      setPendingLocale(next);
    },
  };
}
