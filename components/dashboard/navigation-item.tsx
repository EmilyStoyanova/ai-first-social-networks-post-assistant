"use client";

import type { ElementType } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { isNavItemActive } from "@/lib/navigation/nav-active";

interface Props {
  href: string;
  label: string;
  icon?: ElementType;
  disabled?: boolean;
  /** Vertical (the pre-redesign sidebar list) or horizontal (the global top bar). */
  variant?: "vertical" | "horizontal";
}

export function NavigationItem({
  href,
  label,
  icon: Icon,
  disabled = false,
  variant = "vertical",
}: Props) {
  const pathname = usePathname();
  // The rule itself lives in a pure module — Company Management redirects into
  // `/companies/{slug}`, so "which item owns this pathname" is not a plain
  // prefix match. See `lib/navigation/nav-active.ts`.
  const isActive = !disabled && isNavItemActive(pathname, href);

  const base =
    variant === "horizontal"
      ? "group rounded-control duration-fast flex items-center gap-2 px-3 py-1.5 text-sm transition-all"
      : "group rounded-control duration-fast flex items-center gap-2.5 px-3 py-2 text-sm transition-all";

  if (disabled) {
    return (
      <span
        aria-disabled="true"
        className={[base, "cursor-not-allowed opacity-35 select-none"].join(" ")}
      >
        {Icon && <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />}
        {label}
      </span>
    );
  }

  return (
    <Link
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={[
        base,
        isActive
          ? "bg-surface-subtle text-fg font-semibold"
          : "text-fg-muted hover:bg-surface-subtle hover:text-fg font-medium",
      ].join(" ")}
    >
      {Icon && (
        <Icon
          className={[
            "duration-fast h-4 w-4 shrink-0 transition-colors",
            isActive ? "text-fg" : "text-fg-faint group-hover:text-fg-muted",
          ].join(" ")}
          aria-hidden="true"
        />
      )}
      {label}
    </Link>
  );
}
