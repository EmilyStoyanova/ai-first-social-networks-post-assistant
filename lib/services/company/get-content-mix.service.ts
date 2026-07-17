import { prisma } from "@/lib/db/client";
import {
  COMPANY_CONTENT_SOURCE_ID,
  contentMixTotal,
  MAX_POSTS_PER_CHANNEL_PER_WEEK,
  resolveContentMix,
  validateContentMix,
  type MixValidationCode,
} from "@/lib/scheduling/content-mix";

export interface ContentMixSourceDTO {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  /** null = no quota assigned yet. */
  postsPerWeek: number | null;
}

export interface ContentMixDTO {
  sources: ContentMixSourceDTO[];
  companyContentPostsPerWeek: number | null;
  /**
   * The weekly target every enabled channel must add up to, or null when no
   * channel is enabled yet (nothing to validate against).
   */
  weeklyTarget: number | null;
  /** Sum of the configured quotas; 0 when the mix is unconfigured. */
  total: number;
  /** weeklyTarget − total, or null when there is no target. Negative = over-allocated. */
  remaining: number | null;
  /** False = this company uses the pre-v2-8 pooled behaviour. */
  configured: boolean;
  maxPostsPerWeek: number;
  /** Enabled channels and their weekly budgets, for explaining a mismatch in the UI. */
  channelTargets: Array<{ channel: string; postsPerWeek: number }>;
  /** Why the CURRENT stored mix is invalid, if it is. Null when valid. */
  validationError: { code: MixValidationCode; message: string } | null;
}

export type GetContentMixResult =
  { success: true; mix: ContentMixDTO } | { success: false; code: "NOT_FOUND" };

/** Shared by the read and the write path so both see one company id resolution. */
export async function resolveCompanyForMix(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean,
  requireOwner: boolean
): Promise<{ ok: true; companyId: string } | { ok: false; code: "NOT_FOUND" | "FORBIDDEN" }> {
  if (isGlobalAdmin) {
    const company = await prisma.company.findUnique({ where: { slug }, select: { id: true } });
    if (!company) return { ok: false, code: "NOT_FOUND" };
    return { ok: true, companyId: company.id };
  }

  const membership = await prisma.companyMember.findFirst({
    where: { company: { slug }, userId },
    select: { companyId: true, role: true },
  });
  if (!membership) return { ok: false, code: "NOT_FOUND" };
  // Editors may read the mix but only owners may change the posting budget —
  // same split as content sources and channel configs.
  if (requireOwner && membership.role !== "owner") return { ok: false, code: "FORBIDDEN" };
  return { ok: true, companyId: membership.companyId };
}

/** Loads everything the mix UI needs: quotas, the target they must hit, and the gap. */
export async function getContentMix(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<GetContentMixResult> {
  const resolved = await resolveCompanyForMix(slug, userId, isGlobalAdmin, false);
  if (!resolved.ok) return { success: false, code: "NOT_FOUND" };

  const mix = await loadContentMix(resolved.companyId);
  return { success: true, mix };
}

// ─── Minimal DB interface for testability ─────────────────────────────────────
// Same pattern as ToggleFeedItemDb: the real Prisma client satisfies this narrow
// shape and unit tests inject a fake. `mock.module` is unavailable under
// `npx tsx --test`, so injection is the only way to test the read model.

export interface LoadContentMixDb {
  company: {
    findUnique: (args: {
      where: { id: string };
      select: { companyContentPostsPerWeek: true };
    }) => Promise<{ companyContentPostsPerWeek: number | null } | null>;
  };
  contentSource: {
    findMany: (args: {
      where: { companyId: string };
      orderBy: { createdAt: "asc" };
      select: {
        id: true;
        name: true;
        type: true;
        enabled: true;
        postsPerWeek: true;
      };
    }) => Promise<
      Array<{
        id: string;
        name: string;
        type: string;
        enabled: boolean;
        postsPerWeek: number | null;
      }>
    >;
  };
  channelConfig: {
    findMany: (args: {
      where: { companyId: string; enabled: true; postsPerWeek: { gt: number } };
      select: { channel: true; postsPerWeek: true };
    }) => Promise<Array<{ channel: string; postsPerWeek: number }>>;
  };
}

/** Read model shared by the GET route and the save path's post-write response. */
export async function loadContentMix(companyId: string): Promise<ContentMixDTO> {
  return loadContentMixCore(prisma, companyId);
}

export async function loadContentMixCore(
  db: LoadContentMixDb,
  companyId: string
): Promise<ContentMixDTO> {
  const [company, sources, channels] = await Promise.all([
    db.company.findUnique({
      where: { id: companyId },
      select: { companyContentPostsPerWeek: true },
    }),
    db.contentSource.findMany({
      where: { companyId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        type: true,
        enabled: true,
        postsPerWeek: true,
      },
    }),
    db.channelConfig.findMany({
      where: { companyId, enabled: true, postsPerWeek: { gt: 0 } },
      select: { channel: true, postsPerWeek: true },
    }),
  ]);

  const companyContentPostsPerWeek = company?.companyContentPostsPerWeek ?? null;
  const quotas = resolveContentMix({ sources, companyContentPostsPerWeek });
  const total = quotas === null ? 0 : contentMixTotal(quotas);

  // The target is only well-defined when every enabled channel agrees — a mix is
  // one recipe shared by all of them. When they disagree there is no single
  // number to show, and validation surfaces MIX_CHANNEL_TARGETS_DIFFER instead.
  const distinctTargets = [...new Set(channels.map((c) => c.postsPerWeek))];
  const weeklyTarget = distinctTargets.length === 1 ? distinctTargets[0] : null;

  const validation = validateContentMix({
    sources,
    companyContentPostsPerWeek,
    channelTargets: channels,
  });

  return {
    sources: sources.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      enabled: s.enabled,
      postsPerWeek: s.postsPerWeek,
    })),
    companyContentPostsPerWeek,
    weeklyTarget,
    total,
    remaining: weeklyTarget === null ? null : weeklyTarget - total,
    configured: quotas !== null,
    maxPostsPerWeek: MAX_POSTS_PER_CHANNEL_PER_WEEK,
    channelTargets: channels,
    validationError: validation.valid ? null : validation.error,
  };
}

export { COMPANY_CONTENT_SOURCE_ID };
