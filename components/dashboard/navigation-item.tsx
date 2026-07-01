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
        className="flex cursor-not-allowed items-center justify-between rounded-lg px-3 py-2.5 text-sm text-gray-400 select-none"
      >
        {label}
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-400">
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
        "group flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200",
        isActive
          ? "bg-green-50 text-green-700"
          : "text-gray-600 hover:bg-gray-50 hover:text-gray-900",
      ].join(" ")}
    >
      {/* Active indicator dot */}
      <span
        className={[
          "h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-200",
          isActive ? "bg-green-500" : "bg-transparent group-hover:bg-gray-300",
        ].join(" ")}
        aria-hidden="true"
      />
      {label}
    </Link>
  );
}
