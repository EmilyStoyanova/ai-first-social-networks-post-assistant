"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Navigation } from "./navigation";
import { LogoutButton } from "./logout-button";

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
        <div className="border-border flex h-14 shrink-0 items-center gap-3 border-b px-4">
          <div className="rounded-control bg-fg flex h-7 w-7 shrink-0 items-center justify-center">
            <span className="text-xs font-bold text-white">AI</span>
          </div>
          <div>
            <p className="text-fg text-sm leading-tight font-bold tracking-tight">
              {t("logoName")}
            </p>
            <p className="text-fg-faint text-[11px] leading-tight">{t("logoTagline")}</p>
          </div>
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
