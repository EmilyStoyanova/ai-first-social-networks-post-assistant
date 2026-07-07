"use client";

import { useTranslations } from "next-intl";
import { logoutAction } from "@/lib/actions/auth";
import { Button } from "@/components/ui/Button";

export function LogoutButton() {
  const t = useTranslations("header");

  return (
    <form action={logoutAction}>
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        fullWidth
        aria-label={t("signOut")}
        className="justify-start"
      >
        {t("logout")}
      </Button>
    </form>
  );
}
