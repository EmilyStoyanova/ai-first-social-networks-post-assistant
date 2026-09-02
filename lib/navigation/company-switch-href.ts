/**
 * The route roots that carry an active-company slug as their first path
 * segment. Content Creation, Competitive Analysis, and company management all
 * share this exact shape (`/{root}/{slug}[/rest...]`), which is what lets one
 * small function handle all three instead of three near-duplicates.
 */
const SLUG_ROOTS = ["create", "competitive-analysis", "companies"] as const;

/**
 * Where switching the active company should navigate to from the current
 * page, preserving the sub-route where practical (e.g.
 * `/competitive-analysis/domestico/trends` -> `/competitive-analysis/travelnest/trends`).
 *
 * Returns `null` when the current page has no company-slug segment to swap
 * (Dashboard, Admin, a bare module root) — switching there only updates the
 * persisted preference, no navigation.
 */
export function companySwitchHref(pathname: string, newSlug: string): string | null {
  // `/companies/new` is the only path under a slug root whose second segment is
  // not a company slug — it is the create-company form. Swapping it would both
  // navigate somewhere unrelated and silently discard a half-filled form, so it
  // is treated like Dashboard: update the preference, stay put. Kept in step
  // with `nav-active.ts`, which excludes the same path from the company
  // workspace for the same reason.
  if (pathname === "/companies/new" || pathname.startsWith("/companies/new/")) return null;

  for (const root of SLUG_ROOTS) {
    const prefix = `/${root}/`;
    if (!pathname.startsWith(prefix)) continue;

    const rest = pathname.slice(prefix.length);
    const slashIndex = rest.indexOf("/");
    const tail = slashIndex === -1 ? "" : rest.slice(slashIndex);
    return `${prefix}${newSlug}${tail}`;
  }

  return null;
}
