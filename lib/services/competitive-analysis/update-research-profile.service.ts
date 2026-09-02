import { prisma } from "@/lib/db/client";
import { createAuditLog, AUDIT_ACTIONS } from "@/lib/services/audit/audit-log.service";
import { enqueueJob } from "@/lib/services/queue/enqueue-job.service";
import { COMPETITOR_RELEVANCE_JOB_TYPE, competitorRelevanceDedupeKey } from "@/lib/queue/job-types";
import { resolveCompetitiveAnalysisContext } from "./resolve-competitor-context";
import {
  computeNextProfileVersion,
  shouldRecomputeRelevanceOnSave,
  shouldReopenStaleAnalysisOnSave,
  versionWasBumped,
} from "./research-profile-versioning";
import { triggerStaleAnalysisRecoveryForCompany } from "./reopen-stale-analysis.service";
import { resolveAnalysisLanguage } from "@/lib/i18n/analysis-language";
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
 * `analysisPeriodDays`-only save, and never for an `analysisLanguage`-only
 * save (§12; see `CompetitorResearchProfile.analysisLanguage`'s own schema
 * comment for why). When a save DOES bump the version, this best-effort
 * enqueues the bounded relevance-recompute drain
 * (`recompute-stale-relevance.service.ts`) for this company — it re-evaluates
 * already-extracted content against the new profile; it never re-runs
 * extraction, and a period-only or language-only save never reaches this
 * enqueue at all.
 *
 * `analysisLanguage` changing (or being set for the first time) is a SEPARATE
 * trigger (2026-09-02 ownership-boundary fix), handled independently of
 * `profileVersion`: it best-effort runs the bounded, hash-driven stale-analysis
 * recovery sweep (`reopenStaleAnalysisForCompany`) scoped to just this company,
 * right here in the request rather than waiting for the next worker restart —
 * see `shouldReopenStaleAnalysisOnSave`'s own comment for exactly when. That
 * sweep only ever recomputes a cheap hash and flips rows to `pending`; it never
 * calls a model, so it stays fast enough to run inline. Re-extraction then
 * naturally re-triggers relevance for any row it actually re-analyzes (see
 * `extractCompetitorIntelligence`'s `relevanceProfileVersion: null` write and
 * `runCompetitorIntelligenceExtraction`'s own post-extraction relevance
 * enqueue) — so a language change never needs its own separate relevance
 * trigger here.
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
    select: { researchTopics: true, markets: true, profileVersion: true, analysisLanguage: true },
  });

  const nextVersion = computeNextProfileVersion(existing, data);
  const versionBumped = versionWasBumped(existing, nextVersion);
  // Verification pass (§1) — see `shouldRecomputeRelevanceOnSave`'s own
  // comment for why the first-ever save needs its own trigger condition, not
  // just `versionBumped`, and why no version sentinel is needed to make that
  // safe.
  const isFirstSave = existing === null;
  const shouldRecomputeRelevance = shouldRecomputeRelevanceOnSave(existing, versionBumped);

  // 2026-09-02 ownership-boundary fix — see `shouldReopenStaleAnalysisOnSave`'s
  // own comment. Computed from the RAW stored value, not the normalized one:
  // a stray legacy value normalizing to the same AnalysisLanguage as what's
  // being saved is still, honestly, "the stored value changed."
  const languageChanged = existing !== null && existing.analysisLanguage !== data.analysisLanguage;
  const shouldReopenStaleAnalysis = shouldReopenStaleAnalysisOnSave(existing, languageChanged);

  const row = await prisma.competitorResearchProfile.upsert({
    where: { companyId },
    create: {
      companyId,
      researchTopics: data.researchTopics,
      markets: data.markets,
      analysisPeriodDays: data.analysisPeriodDays,
      profileVersion: nextVersion,
      analysisLanguage: data.analysisLanguage,
    },
    update: {
      researchTopics: data.researchTopics,
      markets: data.markets,
      analysisPeriodDays: data.analysisPeriodDays,
      profileVersion: nextVersion,
      analysisLanguage: data.analysisLanguage,
    },
    select: {
      researchTopics: true,
      markets: true,
      analysisPeriodDays: true,
      profileVersion: true,
      analysisLanguage: true,
    },
  });

  await createAuditLog({
    companyId,
    userId,
    action: AUDIT_ACTIONS.RESEARCH_PROFILE_UPDATED,
    entityType: "competitor_research_profile",
    metadata: {
      profileVersion: row.profileVersion,
      versionBumped,
      isFirstSave,
      languageChanged,
    },
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

  // Stale-analysis recovery, scoped to just this company (2026-09-02
  // ownership-boundary fix) — on the first-ever save, or whenever a later
  // save actually changes `analysisLanguage`; never for a topics/markets/
  // period-only save. Bounded and hash-driven — see
  // `reopenStaleAnalysisForCompany`'s own module comment — and best-effort for
  // the identical reason the relevance enqueue above is: a failure here must
  // not fail the Save, and any row left behind is picked up by the next
  // worker-boot sweep regardless.
  if (shouldReopenStaleAnalysis) {
    try {
      await triggerStaleAnalysisRecoveryForCompany(
        companyId,
        resolveAnalysisLanguage(row.analysisLanguage)
      );
    } catch (err) {
      console.error("[research-profile] stale-analysis recovery failed (ignored):", err);
    }
  }

  return {
    success: true,
    profile: {
      researchTopics: row.researchTopics,
      markets: row.markets,
      analysisPeriodDays: row.analysisPeriodDays as 30 | 90 | 180,
      profileVersion: row.profileVersion,
      analysisLanguage: resolveAnalysisLanguage(row.analysisLanguage),
      persisted: true,
    },
  };
}
