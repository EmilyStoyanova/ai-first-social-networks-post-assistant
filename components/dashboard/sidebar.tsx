"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { Navigation } from "./navigation";
import { LogoutButton } from "./logout-button";

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export function Sidebar({ isOpen, onClose }: Props) {
  const pathname = usePathname();

  // Close the mobile sidebar whenever the route changes.
  // onClose is memoised in DashboardLayout so this only fires on navigation.
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

      {/* Sidebar panel
          Mobile: hidden by default, shown when isOpen.
          Desktop (lg+): always visible via lg:flex. */}
      <aside
        className={[
          "fixed inset-y-0 left-0 z-50 w-64 flex-col border-r border-gray-200 bg-white",
          isOpen ? "flex" : "hidden",
          "lg:flex",
        ].join(" ")}
      >
        {/* Logo */}
        <div className="flex h-16 shrink-0 items-center gap-3 border-b border-gray-100 px-5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-green-500">
            <span className="text-sm font-bold text-white">AI</span>
          </div>
          <div>
            <p className="text-sm leading-tight font-bold tracking-tight text-gray-900">AI-First</p>
            <p className="text-xs leading-tight text-gray-400">Post Assistant</p>
          </div>
        </div>

        {/* Navigation */}
        <div className="flex-1 overflow-y-auto px-3 py-5">
          <Navigation />
        </div>

        {/* Logout */}
        <div className="shrink-0 border-t border-gray-100 px-4 py-4">
          <LogoutButton />
        </div>
      </aside>
    </>
  );
}
