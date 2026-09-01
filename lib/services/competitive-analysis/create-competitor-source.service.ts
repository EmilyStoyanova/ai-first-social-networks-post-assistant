import { prisma } from "@/lib/db/client";
import { createAuditLog, AUDIT_ACTIONS } from "@/lib/services/audit/audit-log.service";
import { resolveCompetitiveAnalysisContext } from "./resolve-competitor-context";
import { resolveCompetitorInCompany } from "./resolve-competitor";
import {
  COMPETITOR_SOURCE_SELECT,
  toCompetitorSourceItem,
  type CompetitorSourceItem,
} from "./competitor-source-dto";
import type { CompetitorSourceInput } from "@/lib/validators/competitor-source.schema";

export type CreateCompetitorSourceResult =
  | { success: true; source: CompetitorSourceItem }
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" };

/**
 * Creates one labeled RSS feed for a competitor (Part 3B §2). Owner-only.
 * `companyId` is always the resolved, authenticated company — never accepted
 * from the request — and `competitorId` is verified to belong to it before
 * anything is written. A competitor may hold several of these; there is no
 * uniqueness constraint on the URL, matching the plan's "multiple RSS feeds
 * per competitor" requirement.
 *
 * Deliberately a SEPARATE service from `create-content-source.service.ts` —
 * never exposes `competitorId` through the generic Content Source API (§2's
 * isolation requirement; see that service's own rejection test).
 */
export async function createCompetitorSource(
  slug: string,
  competitorId: string,
  userId: string,
  isGlobalAdmin: boolean,
  data: CompetitorSourceInput
): Promise<CreateCompetitorSourceResult> {
  const resolved = await resolveCompetitiveAnalysisContext(slug, userId, isGlobalAdmin, true);
  if (!resolved.ok) return { success: false, code: resolved.code };
  const { companyId } = resolved.context;

  const competitor = await resolveCompetitorInCompany(competitorId, companyId);
  if (!competitor) return { success: false, code: "NOT_FOUND" };

  const row = await prisma.contentSource.create({
    data: {
      companyId,
      competitorId,
      type: "competitor_rss",
      name: data.label,
      config: { url: data.url },
      enabled: data.enabled ?? true,
    },
    select: COMPETITOR_SOURCE_SELECT,
  });

  await createAuditLog({
    companyId,
    userId,
    action: AUDIT_ACTIONS.COMPETITOR_SOURCE_ADDED,
    entityType: "competitor_source",
    entityId: row.id,
    metadata: { competitorId, label: row.name, url: data.url },
  });

  return { success: true, source: toCompetitorSourceItem(row) };
}
