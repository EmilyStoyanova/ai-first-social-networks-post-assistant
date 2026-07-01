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

export function Navigation() {
  return (
    <nav aria-label="Main navigation">
      <ul role="list" className="space-y-1">
        {NAV_ITEMS.map((item) => (
          <li key={item.href}>
            <NavigationItem href={item.href} label={item.label} disabled={item.disabled} />
          </li>
        ))}
      </ul>
    </nav>
  );
}
