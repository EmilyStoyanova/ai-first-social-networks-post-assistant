import { prisma } from "@/lib/db/client";
import { createAuditLog, AUDIT_ACTIONS } from "@/lib/services/audit/audit-log.service";
import { enqueueJob } from "@/lib/services/queue/enqueue-job.service";
import { COMPETITOR_RELEVANCE_JOB_TYPE, competitorRelevanceDedupeKey } from "@/lib/queue/job-types";
import { resolveCompetitiveAnalysisContext } from "./resolve-competitor-context";
import {
  computeNextProfileVersion,
  shouldRecomputeRelevanceOnSave,
  versionWasBumped,
} from "./research-profile-versioning";
import type { UpdateResearchProfileInput } from "@/lib/validators/research-profile.schema";
import type { ResearchProfileDTO } from "./get-research-profile-or-defaults.service";

export type UpdateResearchProfileResult =
  | { success: true; profile: ResearchProfileDTO }
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" };

/**
 * Owner-only. The only writer of `CompetitorResearchProfile` — an upsert, so
 * the first Save creates the row and every Save after that updates it. From
 * that first Save on, the profile is independent of BrandGuidelines: later
 * Brand changes are never synced in (§3.2).
 *
 * `profileVersion` starts at 1 and increments ONLY when `researchTopics` or
 * `markets` actually changed (order-independent) — never for an
 * `analysisPeriodDays`-only save (§12). When a save DOES bump the version,
 * this best-effort enqueues the bounded relevance-recompute drain
 * (`recompute-stale-relevance.service.ts`) for this company — it re-evaluates
 * already-extracted content against the new profile; it never re-runs
 * extraction, and a period-only save never reaches this enqueue at all.
 */
export async function updateResearchProfile(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean,
  data: UpdateResearchProfileInput
): Promise<UpdateResearchProfileResult> {
  const resolved = await resolveCompetitiveAnalysisContext(slug, userId, isGlobalAdmin, true);
  if (!resolved.ok) return { success: false, code: resolved.code };

  const { companyId } = resolved.context;

  const existing = await prisma.competitorResearchProfile.findUnique({
    where: { companyId },
    select: { researchTopics: true, markets: true, profileVersion: true },
  });

  const nextVersion = computeNextProfileVersion(existing, data);
  const versionBumped = versionWasBumped(existing, nextVersion);
  // Verification pass (§1) — see `shouldRecomputeRelevanceOnSave`'s own
  // comment for why the first-ever save needs its own trigger condition, not
  // just `versionBumped`, and why no version sentinel is needed to make that
  // safe.
  const isFirstSave = existing === null;
  const shouldRecomputeRelevance = shouldRecomputeRelevanceOnSave(existing, versionBumped);

  const row = await prisma.competitorResearchProfile.upsert({
    where: { companyId },
    create: {
      companyId,
      researchTopics: data.researchTopics,
      markets: data.markets,
      analysisPeriodDays: data.analysisPeriodDays,
      profileVersion: nextVersion,
    },
    update: {
      researchTopics: data.researchTopics,
      markets: data.markets,
      analysisPeriodDays: data.analysisPeriodDays,
      profileVersion: nextVersion,
    },
    select: {
      researchTopics: true,
      markets: true,
      analysisPeriodDays: true,
      profileVersion: true,
    },
  });

  await createAuditLog({
    companyId,
    userId,
    action: AUDIT_ACTIONS.RESEARCH_PROFILE_UPDATED,
    entityType: "competitor_research_profile",
    metadata: { profileVersion: row.profileVersion, versionBumped, isFirstSave },
  });

  // Relevance recompute — on the first-ever save, or whenever a later save
  // actually moves the version (§12); never for a period-only save on an
  // existing row (that leaves both `isFirstSave` and `versionBumped` false).
  // Never re-runs extraction; see recompute-stale-relevance.service.ts.
  // Best-effort: a failed enqueue must not fail the Save, and stale rows
  // simply wait for the next Save or a future manual trigger.
  if (shouldRecomputeRelevance) {
    try {
      await enqueueJob({
        type: COMPETITOR_RELEVANCE_JOB_TYPE,
        // companyId travels in the PAYLOAD, not only the job row's companyId
        // column — JobRecord (what a handler actually receives) exposes
        // payload but not the row's other columns; see worker/src/job-store.ts.
        payload: { companyId },
        dedupeKey: competitorRelevanceDedupeKey(companyId),
        companyId,
        createdBy: userId,
      });
    } catch (err) {
      console.error("[research-profile] relevance recompute enqueue failed (ignored):", err);
    }
  }

  return {
    success: true,
    profile: {
      researchTopics: row.researchTopics,
      markets: row.markets,
      analysisPeriodDays: row.analysisPeriodDays as 30 | 90 | 180,
      profileVersion: row.profileVersion,
      persisted: true,
    },
  };
}
