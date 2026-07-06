"use client";

import { useTranslations } from "next-intl";
import { logoutAction } from "@/lib/actions/auth";

export function LogoutButton() {
  const t = useTranslations("header");

  return (
    <form action={logoutAction}>
      <button
        type="submit"
        aria-label={t("signOut")}
        className="border-border text-fg-muted hover:border-border-strong hover:bg-surface-subtle hover:text-fg rounded-md border px-3 py-1.5 text-sm font-medium transition-colors"
      >
        {t("logout")}
      </button>
    </form>
  );
}
