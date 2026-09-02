/**
 * Which top-level nav item a given pathname belongs to.
 *
 * Pure and Prisma/React-free so the rule is unit-testable on its own, matching
 * this directory's existing `company-switch-href.ts`.
 *
 * Most items are the obvious prefix match. Two are not, and both exceptions
 * exist because **Company Management (`/create`) is a resolver shim, not a
 * destination**: it looks up the active company and redirects into that
 * company's workspace under `/companies/{slug}`. So by the time the page has
 * painted, the pathname no longer contains `/create` at all — a plain prefix
 * match would leave the item the user just clicked unhighlighted, and would
 * instead light up "Companies", which is a different destination (the list of
 * every company).
 *
 * The split that keeps both honest:
 *
 *   Companies (`/companies`)        — the LIST, and creating a new one.
 *                                     `/companies` and `/companies/new` only.
 *   Company Management (`/create`)  — ONE company's workspace: `/create`,
 *                                     `/create/{slug}`, and every
 *                                     `/companies/{slug}/...` page.
 *
 * `/companies/new` is deliberately Companies rather than Company Management:
 * there is no company being managed yet, and it is reached from the list.
 */

/** The Company Management nav href — a shim that redirects into `COMPANIES_ROOT`. */
export const COMPANY_MANAGEMENT_HREF = "/create";

/** The Companies list nav href. */
export const COMPANIES_HREF = "/companies";

/** The one path under `/companies/` that is NOT a company workspace. */
const COMPANIES_NEW_PATH = "/companies/new";

/** True for `/companies/{slug}` and anything below it — i.e. a real company
 *  workspace, which is what Company Management lands on. */
function isCompanyWorkspacePath(pathname: string): boolean {
  if (!pathname.startsWith(`${COMPANIES_HREF}/`)) return false;
  return pathname !== COMPANIES_NEW_PATH && !pathname.startsWith(`${COMPANIES_NEW_PATH}/`);
}

export function isNavItemActive(pathname: string, href: string): boolean {
  if (href === COMPANIES_HREF) {
    return pathname === COMPANIES_HREF || pathname === COMPANIES_NEW_PATH;
  }

  if (href === COMPANY_MANAGEMENT_HREF) {
    if (pathname === COMPANY_MANAGEMENT_HREF) return true;
    if (pathname.startsWith(`${COMPANY_MANAGEMENT_HREF}/`)) return true;
    return isCompanyWorkspacePath(pathname);
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}
