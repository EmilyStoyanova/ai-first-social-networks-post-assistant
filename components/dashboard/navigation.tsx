"use client";

import { NavigationItem } from "./navigation-item";

type NavItem = {
  label: string;
  href: string;
  disabled?: boolean;
};

const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "Companies", href: "/companies" },
  { label: "Posts", href: "/posts", disabled: true },
  { label: "Media Gallery", href: "/media", disabled: true },
  { label: "Analytics", href: "/analytics", disabled: true },
  { label: "Settings", href: "/settings", disabled: true },
];

interface Props {
  isGlobalAdmin: boolean;
}

export function Navigation({ isGlobalAdmin }: Props) {
  return (
    <nav aria-label="Main navigation" className="space-y-4">
      <ul role="list" className="space-y-1">
        {NAV_ITEMS.map((item) => (
          <li key={item.href}>
            <NavigationItem href={item.href} label={item.label} disabled={item.disabled} />
          </li>
        ))}
      </ul>

      {isGlobalAdmin && (
        <div className="border-t border-gray-100 pt-4">
          <p className="mb-1 px-3 text-xs font-semibold tracking-widest text-gray-400 uppercase">
            Admin
          </p>
          <ul role="list" className="space-y-1">
            <li>
              <NavigationItem href="/admin" label="Admin Panel" />
            </li>
          </ul>
        </div>
      )}
    </nav>
  );
}
