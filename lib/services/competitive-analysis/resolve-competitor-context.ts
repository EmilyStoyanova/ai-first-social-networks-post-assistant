import { prisma } from "@/lib/db/client";

export interface CompetitiveAnalysisContext {
  companyId: string;
  isOwner: boolean;
}

export type ResolveCompetitiveAnalysisContextResult =
  | { ok: true; context: CompetitiveAnalysisContext }
  | { ok: false; code: "NOT_FOUND" | "FORBIDDEN" };

// ─── DI seam ────────────────────────────────────────────────────────────────
// Same shape as `resolveActiveCompany`'s `ResolveActiveCompanyDeps` — the real
// Prisma client satisfies this narrow interface, and a test injects a fake so
// the permission/isolation branching below is directly unit-testable with no
// database. See resolve-competitor-context.test.ts.

export interface ResolveCompetitiveAnalysisContextDeps {
  findCompanyBySlug: (slug: string) => Promise<{ id: string } | null>;
  findMembership: (
    slug: string,
    userId: string
  ) => Promise<{ companyId: string; role: "owner" | "editor" } | null>;
}

const DEFAULT_DEPS: ResolveCompetitiveAnalysisContextDeps = {
  findCompanyBySlug: (slug) => prisma.company.findUnique({ where: { slug }, select: { id: true } }),
  findMembership: (slug, userId) =>
    prisma.companyMember.findFirst({
      where: { company: { slug }, userId },
      select: { companyId: true, role: true },
    }),
};

/**
 * Shared access-control resolution for every Competitive Analysis service —
 * same shape as `resolveCompanyForMix` (get-content-mix.service.ts) and the
 * `resolveContext` pattern documented in CLAUDE.md. A global admin bypasses
 * membership; everyone else must be a member, and owner-only mutations
 * (competitor CRUD, Research Profile writes) pass `requireOwner: true`.
 *
 * Returning `NOT_FOUND` for "not a member" (never `FORBIDDEN`) avoids leaking
 * whether a company exists — matches `getCompany`'s own convention, and is
 * also what makes a competitor id lifted from another company's URL resolve
 * as NOT_FOUND rather than FORBIDDEN once paired with each service's own
 * `{ id, companyId }` scoped lookup.
 */
export async function resolveCompetitiveAnalysisContext(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean,
  requireOwner: boolean,
  deps: ResolveCompetitiveAnalysisContextDeps = DEFAULT_DEPS
): Promise<ResolveCompetitiveAnalysisContextResult> {
  if (isGlobalAdmin) {
    const company = await deps.findCompanyBySlug(slug);
    if (!company) return { ok: false, code: "NOT_FOUND" };
    return { ok: true, context: { companyId: company.id, isOwner: true } };
  }

  const membership = await deps.findMembership(slug, userId);
  if (!membership) return { ok: false, code: "NOT_FOUND" };
  if (requireOwner && membership.role !== "owner") return { ok: false, code: "FORBIDDEN" };

  return {
    ok: true,
    context: { companyId: membership.companyId, isOwner: membership.role === "owner" },
  };
}
