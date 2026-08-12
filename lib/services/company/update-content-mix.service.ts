import { prisma } from "@/lib/db/client";
import {
  findUnknownSourceId,
  projectMixSources,
  validateContentMix,
  type MixSourceInput,
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

/** The submitted quotas, in the shape projectMixSources applies them. */
function quotasFor(data: ContentMixInput): Map<string, number | null> {
  return new Map(data.sources.map((s) => [s.sourceId, s.postsPerWeek]));
}

/**
 * The source rows a save must write, and with what values.
 *
 * Exported as the seam this decision can be unit-tested at: it is the whole of
 * "what gets persisted", with none of the Prisma surface around it.
 *
 * Only submitted sources are written — a source the client omitted keeps its
 * stored row untouched rather than being rewritten with the value it already
 * has. `fallback_policy` is never written: quota transfer is unconditional, so
 * the column is legacy and this path leaves whatever is in it alone.
 */
export function planSourceWrites(
  existing: readonly MixSourceInput[],
  data: ContentMixInput
): Array<{ id: string; postsPerWeek: number | null }> {
  const submitted = new Set(data.sources.map((s) => s.sourceId));
  return projectMixSources(existing, quotasFor(data))
    .filter((source) => submitted.has(source.id))
    .map((source) => ({ id: source.id, postsPerWeek: source.postsPerWeek }));
}

/**
 * Saves the whole distribution atomically (v2-8).
 *
 * The mix is validated on the SERVER against the sources as they exist right now
 * — never against what the client believed. The UI performs the same check for
 * immediate feedback, but this is the authority: a client can be stale (a source
 * was added in another tab) or simply bypassed.
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

  const existingSources = await prisma.contentSource.findMany({
    where: { companyId },
    select: { id: true, name: true, enabled: true, postsPerWeek: true },
  });

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

  const projected = projectMixSources(existingSources, quotasFor(data));

  const validation = validateContentMix({
    sources: projected,
    companyContentPostsPerWeek: data.companyContentPostsPerWeek,
  });
  if (!validation.valid) {
    return { success: false, code: validation.error.code, message: validation.error.message };
  }

  const writes = planSourceWrites(existingSources, data);

  await prisma.$transaction([
    ...writes.map((write) =>
      prisma.contentSource.update({
        where: { id: write.id },
        data: { postsPerWeek: write.postsPerWeek },
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
      // The rows actually written, so the log reads as what changed.
      sources: writes.map((write) => ({
        sourceId: write.id,
        postsPerWeek: write.postsPerWeek,
      })),
    },
  });

  return { success: true, mix: await loadContentMix(companyId) };
}
