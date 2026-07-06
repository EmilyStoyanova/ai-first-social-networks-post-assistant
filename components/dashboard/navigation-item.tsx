"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface Props {
  href: string;
  label: string;
  disabled?: boolean;
}

export function NavigationItem({ href, label, disabled = false }: Props) {
  const pathname = usePathname();
  const isActive = !disabled && (pathname === href || pathname.startsWith(`${href}/`));

  if (disabled) {
    return (
      <span
        aria-disabled="true"
        className="rounded-control text-fg-faint flex cursor-not-allowed items-center justify-between px-3 py-2.5 text-sm select-none"
      >
        {label}
        <span className="bg-surface-subtle text-fg-faint rounded-full px-2 py-0.5 text-xs">
          Coming soon
        </span>
      </span>
    );
  }

  return (
    <Link
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={[
        "group rounded-control duration-fast flex items-center gap-2.5 px-3 py-2.5 text-sm font-medium transition-all",
        isActive
          ? "bg-status-success-bg text-status-success-fg"
          : "text-fg-muted hover:bg-surface-subtle hover:text-fg",
      ].join(" ")}
    >
      {/* Active indicator dot */}
      <span
        className={[
          "duration-fast h-1.5 w-1.5 shrink-0 rounded-full transition-colors",
          isActive ? "bg-fg" : "group-hover:bg-border-strong bg-transparent",
        ].join(" ")}
        aria-hidden="true"
      />
      {label}
    </Link>
  );
}
