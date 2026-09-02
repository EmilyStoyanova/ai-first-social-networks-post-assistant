"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, User as UserIcon } from "lucide-react";
import { logoutAction } from "@/lib/actions/auth";
import { LOCALES, useLocaleSwitch, type AppLocale } from "@/lib/i18n/use-locale-switch";
import { userInitials } from "@/lib/user/user-initials";

interface Props {
  name?: string | null;
  email?: string | null;
}

/** Endonyms, deliberately not translated — a language is listed in its own
 *  language in every locale, so a user who cannot read the current one can
 *  still find theirs. */
const LOCALE_LABELS: Record<AppLocale, string> = {
  en: "English",
  bg: "Български",
};

/**
 * The header's single account control — replaces the user name, the EN/BG
 * switcher and the Logout button, which together took roughly a third of the
 * bar's width for three rarely-used controls.
 *
 * Everything inside is the existing mechanism, not a reimplementation:
 * `useLocaleSwitch` is the same `NEXT_LOCALE` cookie write `LanguageSwitcher`
 * has always done, and logout is the same `logoutAction` server action the old
 * `LogoutButton` submitted to.
 *
 * The open/close behaviour (outside click + Escape, listeners registered once)
 * mirrors `CompanySelector` deliberately — the two sit next to each other and
 * dismissing one should not feel different from dismissing the other.
 */
export function UserMenu({ name, email }: Props) {
  const t = useTranslations("header");
  const { locale, switchLocale } = useLocaleSwitch();
  const containerRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    function onClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    function onEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setIsOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, []);

  const displayName = name?.trim() || email?.trim() || t("userFallback");
  const initials = userInitials(name, email);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        // The avatar carries no visible text label, so the accessible name has
        // to say both what this opens and whose account it is.
        aria-label={t("accountMenu.open", { name: displayName })}
        className="bg-surface-subtle text-fg-muted border-border-strong hover:bg-surface hover:text-fg duration-fast focus-visible:outline-accent flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {initials ?? <UserIcon className="h-4 w-4" aria-hidden="true" />}
      </button>

      {isOpen && (
        <div
          role="menu"
          aria-label={t("accountMenu.label")}
          className="rounded-control border-border bg-surface absolute right-0 z-50 mt-1.5 w-56 border py-1 shadow-lg"
        >
          {/* Identity — text, not a menu item: there is nothing to activate. */}
          <div className="px-3 py-2">
            <p className="text-fg truncate text-sm font-semibold">{displayName}</p>
            {/* Only when it isn't already the line above, so an account with no
                name doesn't print the same email twice. */}
            {email && email.trim() !== displayName && (
              <p className="text-fg-faint truncate text-xs">{email}</p>
            )}
          </div>

          <div className="border-border my-1 border-t" />

          <p className="text-fg-faint text-micro px-3 py-1 font-medium tracking-wide uppercase">
            {t("accountMenu.language")}
          </p>
          {LOCALES.map((l) => (
            <button
              key={l}
              type="button"
              role="menuitemradio"
              aria-checked={l === locale}
              onClick={() => {
                setIsOpen(false);
                switchLocale(l);
              }}
              className="hover:bg-surface-subtle duration-fast flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors"
            >
              <span className={l === locale ? "text-fg font-medium" : "text-fg-muted"}>
                {LOCALE_LABELS[l]}
              </span>
              {l === locale && (
                <Check className="text-accent h-4 w-4 shrink-0" aria-hidden="true" />
              )}
            </button>
          ))}

          <div className="border-border my-1 border-t" />

          {/* Still a real form POST to the same server action the standalone
              LogoutButton used — the session teardown path is unchanged. */}
          <form action={logoutAction}>
            <button
              type="submit"
              role="menuitem"
              aria-label={t("signOut")}
              className="text-fg-muted hover:bg-surface-subtle hover:text-fg duration-fast w-full px-3 py-2 text-left text-sm transition-colors"
            >
              {t("logout")}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
