"use client";

import type { ElementType } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

interface Props {
  href: string;
  label: string;
  icon?: ElementType;
  disabled?: boolean;
}

export function NavigationItem({ href, label, icon: Icon, disabled = false }: Props) {
  const pathname = usePathname();
  const isActive = !disabled && (pathname === href || pathname.startsWith(`${href}/`));

  if (disabled) {
    return (
      <span
        aria-disabled="true"
        className="rounded-control flex cursor-not-allowed items-center gap-2.5 px-3 py-2 text-sm opacity-35 select-none"
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
        "group rounded-control duration-fast flex items-center gap-2.5 px-3 py-2 text-sm transition-all",
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
