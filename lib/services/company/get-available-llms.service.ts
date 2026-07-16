import type { LlmProvider } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getSupportedProviderInfo } from "@/lib/ai/llm/supported-providers";

/**
 * A provider a user may pick for a single generation, or save as a preference.
 * Deliberately narrow: it NEVER carries credentials — only what the dropdown
 * needs. The model/name come from the code registry (env), not the DB.
 */
export interface AvailableLlm {
  id: string;
  displayName: string;
  provider: LlmProvider;
  model: string;
  /** True for the single system default config that "Auto" resolves to. */
  isDefault: boolean;
  /** True for the caller's saved preferred config (only when it is still active). */
  isPreferred: boolean;
}

export type GetAvailableLlmsResult =
  { success: true; llms: AvailableLlm[] } | { success: false; code: "NOT_FOUND" };

/**
 * Maps an active runtime-state row to an AvailableLlm, flagging default/preferred.
 * Display name and model come from the supported-providers registry (env/code).
 */
export function toAvailableLlm(
  row: { id: string; provider: LlmProvider; isDefault: boolean },
  preferredLlmConfigId: string | null
): AvailableLlm {
  const info = getSupportedProviderInfo(row.provider);
  const model = info?.model ?? "";
  return {
    id: row.id,
    displayName: info ? `${info.displayName} · ${model}` : row.provider,
    provider: row.provider,
    model,
    isDefault: row.isDefault,
    isPreferred: row.id === preferredLlmConfigId,
  };
}

// ─── Minimal DB interface for testability ─────────────────────────────────────

export interface AvailableLlmsDb {
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
  user: {
    findUnique: (args: {
      where: { id: string };
      select: { preferredLlmConfigId: true };
    }) => Promise<{ preferredLlmConfigId: string | null } | null>;
  };
  llmConfig: {
    findMany: (args: {
      where: { isActive: true };
      select: { id: true; provider: true; isDefault: true };
      orderBy: { createdAt: "asc" };
    }) => Promise<Array<{ id: string; provider: LlmProvider; isDefault: boolean }>>;
  };
}

/**
 * Lists the active LLM configs available to a company member for per-generation
 * selection. Any member (owner or editor) or a global admin may read this; the
 * response is scrubbed of every secret (see AvailableLlm). ALL active configs are
 * returned — activation is no longer exclusive — the single default is marked
 * (what "Auto" resolves to) and the caller's saved preference is flagged so the
 * generation form can preselect it.
 */
export async function getAvailableLlmsCore(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean,
  db: AvailableLlmsDb
): Promise<GetAvailableLlmsResult> {
  // RBAC — confirm the caller can see this company (mirrors listChannelConfigs).
  if (isGlobalAdmin) {
    const company = await db.company.findUnique({ where: { slug }, select: { id: true } });
    if (!company) return { success: false, code: "NOT_FOUND" };
  } else {
    const membership = await db.companyMember.findFirst({
      where: { company: { slug }, userId },
      select: { companyId: true },
    });
    if (!membership) return { success: false, code: "NOT_FOUND" };
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { preferredLlmConfigId: true },
  });
  const preferredLlmConfigId = user?.preferredLlmConfigId ?? null;

  const rows = await db.llmConfig.findMany({
    where: { isActive: true },
    select: { id: true, provider: true, isDefault: true },
    orderBy: { createdAt: "asc" },
  });

  const llms = rows.map((row) => toAvailableLlm(row, preferredLlmConfigId));

  return { success: true, llms };
}

// ─── Public API (uses real Prisma) ────────────────────────────────────────────

export async function getAvailableLlms(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<GetAvailableLlmsResult> {
  return getAvailableLlmsCore(slug, userId, isGlobalAdmin, prisma);
}
