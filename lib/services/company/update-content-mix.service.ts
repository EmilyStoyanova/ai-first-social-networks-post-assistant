import { prisma } from "@/lib/db/client";
import {
  findUnknownSourceId,
  projectMixSources,
  validateContentMix,
  type MixValidationCode,
} from "@/lib/scheduling/content-mix";
import type { ContentMixInput } from "@/lib/validators/content-mix.schema";
import { createAuditLog, AUDIT_ACTIONS } from "@/lib/services/audit/audit-log.service";
import {
  loadContentMix,
  resolveCompanyForMix,
  type ContentMixDTO,
} from "./get-content-mix.service";

export type UpdateContentMixResult =
  | { success: true; mix: ContentMixDTO }
  | {
      success: false;
      code: "NOT_FOUND" | "FORBIDDEN" | "UNKNOWN_SOURCE" | MixValidationCode;
      message?: string;
    };

/**
 * Saves the whole distribution atomically (v2-8).
 *
 * The mix is validated on the SERVER against the sources and channel budgets as
 * they exist right now — never against what the client believed. The UI performs
 * the same check for immediate feedback, but this is the authority: a client can
 * be stale (a channel budget changed in another tab) or simply bypassed.
 *
 * All writes go in one transaction so a rejected or crashed save can never leave
 * a half-applied distribution whose total is nonsense.
 */
export async function updateContentMix(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean,
  data: ContentMixInput
): Promise<UpdateContentMixResult> {
  const resolved = await resolveCompanyForMix(slug, userId, isGlobalAdmin, true);
  if (!resolved.ok) return { success: false, code: resolved.code };
  const { companyId } = resolved;

  const [existingSources, channels] = await Promise.all([
    prisma.contentSource.findMany({
      where: { companyId },
      select: { id: true, name: true, enabled: true, postsPerWeek: true, fallbackPolicy: true },
    }),
    prisma.channelConfig.findMany({
      where: { companyId, enabled: true, postsPerWeek: { gt: 0 } },
      select: { channel: true, postsPerWeek: true },
    }),
  ]);

  const unknown = findUnknownSourceId(
    existingSources,
    data.sources.map((s) => s.sourceId)
  );
  if (unknown) {
    return {
      success: false,
      code: "UNKNOWN_SOURCE",
      message: `Content source ${unknown} does not belong to this company.`,
    };
  }

  const projected = projectMixSources(
    existingSources,
    new Map(data.sources.map((s) => [s.sourceId, s.postsPerWeek]))
  );

  const validation = validateContentMix({
    sources: projected,
    companyContentPostsPerWeek: data.companyContentPostsPerWeek,
    channelTargets: channels,
  });
  if (!validation.valid) {
    return { success: false, code: validation.error.code, message: validation.error.message };
  }

  await prisma.$transaction([
    ...data.sources.map((s) =>
      prisma.contentSource.update({
        where: { id: s.sourceId },
        data: { postsPerWeek: s.postsPerWeek },
      })
    ),
    prisma.company.update({
      where: { id: companyId },
      data: { companyContentPostsPerWeek: data.companyContentPostsPerWeek },
    }),
  ]);

  await createAuditLog({
    companyId,
    userId,
    action: AUDIT_ACTIONS.CONTENT_MIX_UPDATED,
    entityType: "company",
    entityId: companyId,
    metadata: {
      companyContentPostsPerWeek: data.companyContentPostsPerWeek,
      sources: data.sources.map((s) => ({ sourceId: s.sourceId, postsPerWeek: s.postsPerWeek })),
    },
  });

  return { success: true, mix: await loadContentMix(companyId) };
}
