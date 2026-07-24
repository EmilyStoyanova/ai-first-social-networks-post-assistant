"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Navigation } from "./navigation";
import { LogoutButton } from "./logout-button";
import { Logo } from "@/components/ui/Logo";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  isGlobalAdmin: boolean;
}

export function Sidebar({ isOpen, onClose, isGlobalAdmin }: Props) {
  const pathname = usePathname();
  const t = useTranslations("sidebar");

  // Close the mobile sidebar whenever the route changes.
  useEffect(() => {
    onClose();
  }, [pathname, onClose]);

  return (
    <>
      {/* Mobile overlay — tap outside to close */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          aria-hidden="true"
          onClick={onClose}
        />
      )}

      <aside
        className={[
          "border-border bg-surface fixed inset-y-0 left-0 z-50 w-64 flex-col border-r",
          isOpen ? "flex" : "hidden",
          "lg:flex",
        ].join(" ")}
      >
        {/* Logo */}
        <div className="border-border flex h-14 shrink-0 flex-col justify-center gap-0.5 border-b px-4">
          <Logo size="sm" />
          <p className="text-fg-faint text-[11px] leading-tight">{t("logoTagline")}</p>
        </div>

        {/* Navigation */}
        <div className="flex-1 overflow-y-auto px-3 py-4">
          <Navigation isGlobalAdmin={isGlobalAdmin} />
        </div>

        {/* Logout */}
        <div className="border-border shrink-0 border-t px-3 py-3">
          <LogoutButton />
        </div>
      </aside>
    </>
  );
}
