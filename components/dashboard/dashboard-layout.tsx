"use client";

import { useState, useCallback } from "react";
import { DashboardHeader } from "./dashboard-header";
import { Sidebar } from "./sidebar";

interface SessionUser {
  name?: string | null;
  email?: string | null;
  isGlobalAdmin?: boolean;
}

export type BreadcrumbItem = { label: string; href?: string };

interface Props {
  user: SessionUser;
  children: React.ReactNode;
  breadcrumb?: BreadcrumbItem[];
}

export function DashboardLayout({ user, children, breadcrumb }: Props) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // Memoised so Sidebar's useEffect([pathname, onClose]) only re-runs on
  // route changes, not on every DashboardLayout render.
  const closeSidebar = useCallback(() => setIsSidebarOpen(false), []);

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      <Sidebar
        isOpen={isSidebarOpen}
        onClose={closeSidebar}
        isGlobalAdmin={user.isGlobalAdmin ?? false}
      />

      {/* Content area: offset by sidebar width on desktop */}
      <div className="flex flex-1 flex-col overflow-hidden lg:pl-64">
        <DashboardHeader
          user={user}
          onMenuClick={() => setIsSidebarOpen(true)}
          breadcrumb={breadcrumb}
        />
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
