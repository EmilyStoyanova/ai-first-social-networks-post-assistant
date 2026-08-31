import { getCompany, type CompanyDetails } from "./get-company.service";
import { listCompanies, type CompanyListItem } from "./list-companies.service";

export type ActiveCompany = {
  id: string;
  slug: string;
  name: string;
  role: "OWNER" | "EDITOR" | null;
};

export interface ResolveActiveCompanyParams {
  /** The slug from the current page's own URL, if it has one (e.g. `/create/[slug]`). */
  routeSlug?: string | null;
  /** The `active_company` cookie's value, read by the caller — this service never touches `next/headers` itself, so it stays trivially testable. */
  cookieSlug?: string | null;
  userId: string;
  isGlobalAdmin: boolean;
}

export interface ResolveActiveCompanyDeps {
  getCompany: (
    slug: string,
    userId: string,
    isGlobalAdmin: boolean
  ) => Promise<CompanyDetails | null>;
  listCompanies: (userId: string, isGlobalAdmin: boolean) => Promise<CompanyListItem[]>;
}

const DEFAULT_DEPS: ResolveActiveCompanyDeps = { getCompany, listCompanies };

/**
 * The single source of truth for "which company is active", per the approved
 * plan's priority order: route slug → persisted cookie → first accessible
 * company → none. Every candidate is re-validated through `getCompany`, which
 * already returns null for a slug the caller isn't a member of — a stale or
 * foreign cookie/slug is never trusted blindly.
 *
 * A page that already fetches its own `company` (every `/companies/[slug]/...`
 * page, and this module's own `/create/[slug]` /
 * `/competitive-analysis/[slug]/...` pages) has no need to call this — it can
 * pass its own fetched company straight through as the header's active
 * company. This resolver exists for the slug-less pages (`/dashboard`,
 * `/companies`, `/admin`) and for the two module root pages that redirect to
 * a resolved slug.
 */
export async function resolveActiveCompany(
  params: ResolveActiveCompanyParams,
  deps: ResolveActiveCompanyDeps = DEFAULT_DEPS
): Promise<ActiveCompany | null> {
  const { routeSlug, cookieSlug, userId, isGlobalAdmin } = params;

  if (routeSlug) {
    const company = await deps.getCompany(routeSlug, userId, isGlobalAdmin);
    return company ? toActiveCompany(company) : null;
  }

  if (cookieSlug) {
    const company = await deps.getCompany(cookieSlug, userId, isGlobalAdmin);
    if (company) return toActiveCompany(company);
    // Falls through to the first-accessible fallback below — a stale/foreign
    // cookie must not dead-end the resolution, only be ignored.
  }

  const companies = await deps.listCompanies(userId, isGlobalAdmin);
  const first = companies[0];
  return first ? { id: first.id, slug: first.slug, name: first.name, role: first.role } : null;
}

function toActiveCompany(company: CompanyDetails): ActiveCompany {
  return { id: company.id, slug: company.slug, name: company.name, role: company.role };
}
