import { prisma } from "@/lib/db/client";
import { createAuditLog, AUDIT_ACTIONS } from "@/lib/services/audit/audit-log.service";
import { enqueueJob } from "@/lib/services/queue/enqueue-job.service";
import {
  COMPETITOR_INTELLIGENCE_EXTRACTION_JOB_TYPE,
  COMPETITOR_INTELLIGENCE_EXTRACTION_DEDUPE_KEY,
} from "@/lib/queue/job-types";
import { resolveCompetitiveAnalysisContext } from "./resolve-competitor-context";
import { resolveCompetitorInCompany } from "./resolve-competitor";
import type { CompetitorManualEntryInput } from "@/lib/validators/competitor-manual-entry.schema";

export interface ManualEntryItem {
  id: string;
  competitorId: string;
  sourceType: string;
  postType: string;
  url: string | null;
  content: string;
  capturedAt: string | null;
  createdAt: string;
  intelligenceId: string | null;
}

export type CreateManualEntryResult =
  | { success: true; entry: ManualEntryItem }
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" | "ARCHIVED" };

/**
 * Manual competitor content import (Part 3B §5). Owner-only — Part 3A's
 * established permission policy (§3.14 of the approved plan: "Owner-only: ...
 * add manual entries") is unchanged here; editor permissions are not broadened.
 *
 * `companyId` is always derived server-side from the resolved competitor —
 * never accepted from the request body (§5). `url`, when given, is stored as
 * reference metadata only: no code path in this service, or anywhere else in
 * `lib/services/competitive-analysis/`, fetches it (§21;
 * `no-social-fetch.test.ts` pins this down structurally). `capturedAt` is left
 * NULL, never substituted with `createdAt`, when the caller does not supply it
 * (§6).
 */
export async function createManualEntry(
  slug: string,
  competitorId: string,
  userId: string,
  isGlobalAdmin: boolean,
  data: CompetitorManualEntryInput
): Promise<CreateManualEntryResult> {
  const resolved = await resolveCompetitiveAnalysisContext(slug, userId, isGlobalAdmin, true);
  if (!resolved.ok) return { success: false, code: resolved.code };
  const { companyId } = resolved.context;

  const competitor = await resolveCompetitorInCompany(competitorId, companyId);
  if (!competitor) return { success: false, code: "NOT_FOUND" };
  if (competitor.archivedAt) return { success: false, code: "ARCHIVED" };

  const row = await prisma.competitorManualEntry.create({
    data: {
      competitorId,
      companyId,
      sourceType: data.sourceType,
      postType: data.postType,
      url: data.url || null,
      content: data.content,
      capturedAt: data.capturedAt ? new Date(data.capturedAt) : null,
      createdBy: userId,
      // One pending CompetitorIntelligence row per manual entry — the
      // extraction drain's claimable unit (§7).
      intelligence: { create: { companyId, competitorId, status: "pending" } },
    },
    select: {
      id: true,
      competitorId: true,
      sourceType: true,
      postType: true,
      url: true,
      content: true,
      capturedAt: true,
      createdAt: true,
      intelligence: { select: { id: true } },
    },
  });

  await createAuditLog({
    companyId,
    userId,
    action: AUDIT_ACTIONS.COMPETITOR_MANUAL_ENTRY_ADDED,
    entityType: "competitor_manual_entry",
    entityId: row.id,
    metadata: { competitorId, sourceType: row.sourceType, postType: row.postType },
  });

  // Best-effort — a successful save must not fail because the queue is
  // briefly unavailable; the extraction drain also self-continues, so a
  // missed signal only costs latency, not correctness.
  try {
    await enqueueJob({
      type: COMPETITOR_INTELLIGENCE_EXTRACTION_JOB_TYPE,
      dedupeKey: COMPETITOR_INTELLIGENCE_EXTRACTION_DEDUPE_KEY,
      companyId,
      createdBy: userId,
    });
  } catch (err) {
    console.error("[manual-entry] extraction enqueue failed (ignored):", err);
  }

  return {
    success: true,
    entry: {
      id: row.id,
      competitorId: row.competitorId,
      sourceType: row.sourceType,
      postType: row.postType,
      url: row.url,
      content: row.content,
      capturedAt: row.capturedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      intelligenceId: row.intelligence?.id ?? null,
    },
  };
}
