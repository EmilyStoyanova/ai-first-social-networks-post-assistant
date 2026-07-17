import { prisma } from "@/lib/db/client";
import type { ContentSourceType } from "@prisma/client";

/**
 * An RSS source offered in the manual "Content source" dropdown.
 *
 * A source with no unused articles is still returned: the dropdown shows it
 * disabled rather than hiding it, so an owner can see that the feed exists and
 * is simply dry, instead of wondering where it went.
 */
export interface GenerationSourceOption {
  id: string;
  name: string;
  /** False when every article is already used — the option renders disabled. */
  hasAvailableArticles: boolean;
}

export type ListGenerationSourcesResult =
  { success: true; sources: GenerationSourceOption[] } | { success: false; code: "NOT_FOUND" };

// ─── Minimal DB interface for testability ─────────────────────────────────────
// Mirrors get-available-llms.service.ts: the real Prisma client satisfies this
// narrow shape, and unit tests inject a fake.

export interface GenerationSourcesDb {
  company: {
    findUnique: (args: {
      where: { slug: string };
      select: { id: true };
    }) => Promise<{ id: string } | null>;
  };
  companyMember: {
    findFirst: (args: {
      where: { company: { slug: string }; userId: string };
      select: { companyId: true };
    }) => Promise<{ companyId: string } | null>;
  };
  contentSource: {
    findMany: (args: {
      where: { companyId: string; enabled: true; type: ContentSourceType };
      orderBy: { createdAt: "asc" };
      select: { id: true; name: true };
    }) => Promise<Array<{ id: string; name: string }>>;
  };
  feedItem: {
    findMany: (args: {
      where: { sourceId: { in: string[] }; enabled: true; usedInPost: false };
      select: { sourceId: true };
      distinct: ["sourceId"];
    }) => Promise<Array<{ sourceId: string }>>;
  };
}

/**
 * Lists the enabled RSS sources a member may generate from, flagging which ones
 * still have an article left to write about.
 *
 * Any member (owner or editor) or a global admin may read this — the same bar as
 * triggering generation itself.
 */
export async function listGenerationSourcesCore(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean,
  db: GenerationSourcesDb
): Promise<ListGenerationSourcesResult> {
  // RBAC — confirm the caller can see this company (mirrors getAvailableLlmsCore).
  let companyId: string;
  if (isGlobalAdmin) {
    const company = await db.company.findUnique({ where: { slug }, select: { id: true } });
    if (!company) return { success: false, code: "NOT_FOUND" };
    companyId = company.id;
  } else {
    const membership = await db.companyMember.findFirst({
      where: { company: { slug }, userId },
      select: { companyId: true },
    });
    if (!membership) return { success: false, code: "NOT_FOUND" };
    companyId = membership.companyId;
  }

  // A disabled source is switched off, not dry — it is left out entirely rather
  // than shown greyed out, which would imply articles are all that is missing.
  const rows = await db.contentSource.findMany({
    where: { companyId, enabled: true, type: "rss" },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });
  if (rows.length === 0) return { success: true, sources: [] };

  // The availability predicate must match the article window the generation
  // context builds (enabled + unused, from an enabled source of this company) —
  // otherwise the dropdown would offer a source generation then refuses. The
  // company/source-enabled halves are already covered by `rows` above.
  const withArticles = await db.feedItem.findMany({
    where: { sourceId: { in: rows.map((r) => r.id) }, enabled: true, usedInPost: false },
    select: { sourceId: true },
    distinct: ["sourceId"],
  });
  const available = new Set(withArticles.map((r) => r.sourceId));

  return {
    success: true,
    sources: rows.map((r) => ({
      id: r.id,
      name: r.name,
      hasAvailableArticles: available.has(r.id),
    })),
  };
}

// ─── Public API (uses real Prisma) ────────────────────────────────────────────

export async function listGenerationSources(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<ListGenerationSourcesResult> {
  return listGenerationSourcesCore(slug, userId, isGlobalAdmin, prisma);
}
