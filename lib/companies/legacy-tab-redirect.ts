/**
 * Translation of the pre-Phase-4a workspace URLs into their routes.
 *
 * The company workspace used to serve five of its tabs as `?tab=` query
 * parameters on a single page (`/companies/acme?tab=settings`). Phase 4a gave
 * each one a real route, but links already exist in bookmarks, browser history,
 * and any email a user has sent a colleague — so the old shape keeps working
 * and lands where it always did.
 *
 * Only `tab` is consumed. Every other parameter rides along to the new URL,
 * which matters most for `?tab=settings&buffer=connected`: the Buffer OAuth
 * result must survive the hop, or the user is told nothing about a connection
 * they just authorized.
 */

/** Where each retired `?tab=` value now lives, relative to the company. */
const LEGACY_TAB_ROUTES: Record<string, string> = {
  posts: "/posts",
  sources: "/sources",
  // Team's destination is Settings (§2.2), so the old link goes straight there
  // rather than to a `/team` route that would only exist to be removed in 4b.
  team: "/settings/team",
  settings: "/settings",
  // "overview" is this page. It still redirects, to drop the now-meaningless
  // parameter from the address bar — dropping it is what prevents a loop.
  overview: "",
};

type SearchParams = Record<string, string | string[] | undefined>;

function firstValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * The URL a legacy `?tab=` link should be sent to, or `null` to render the
 * overview as normal.
 *
 * An unrecognized tab returns `null` rather than a 404, matching the old
 * `resolveTab` fallback: a typo or a retired value showed the overview, and it
 * still does.
 */
export function resolveLegacyTabRedirect(slug: string, searchParams: SearchParams): string | null {
  const tab = firstValue(searchParams.tab);
  if (typeof tab !== "string") return null;

  const segment = LEGACY_TAB_ROUTES[tab.trim().toLowerCase()];
  if (segment === undefined) return null;

  const rest = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (key === "tab" || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) rest.append(key, entry);
    } else {
      rest.append(key, value);
    }
  }

  const query = rest.toString();
  return `/companies/${slug}${segment}${query ? `?${query}` : ""}`;
}
