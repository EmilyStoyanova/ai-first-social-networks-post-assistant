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
        className="rounded-md border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-600 transition-colors hover:border-gray-300 hover:bg-gray-100 hover:text-gray-900"
      >
        {t("logout")}
      </button>
    </form>
  );
}
