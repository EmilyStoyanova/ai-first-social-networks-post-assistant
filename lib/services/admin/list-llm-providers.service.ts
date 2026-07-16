import type { LlmProvider } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { listSupportedProviderInfo, type ProviderStatus } from "@/lib/ai/llm/supported-providers";

/**
 * A supported provider merged with its admin-managed runtime state. Provider name,
 * model, and availability come from code/env (never the DB); active/default come
 * from the llm_configs runtime-state row (absent row = inactive, non-default).
 */
export interface LlmProviderItem {
  provider: LlmProvider;
  displayName: string;
  model: string;
  status: ProviderStatus;
  isActive: boolean;
  isDefault: boolean;
}

export type ListLlmProvidersResult =
  { success: true; providers: LlmProviderItem[] } | { success: false; code: "FORBIDDEN" };

export interface ListLlmProvidersDb {
  llmConfig: {
    findMany: (args: {
      select: { provider: true; isActive: true; isDefault: true };
    }) => Promise<Array<{ provider: LlmProvider; isActive: boolean; isDefault: boolean }>>;
  };
}

export async function listLlmProvidersCore(
  isGlobalAdmin: boolean,
  db: ListLlmProvidersDb
): Promise<ListLlmProvidersResult> {
  if (!isGlobalAdmin) return { success: false, code: "FORBIDDEN" };

  const rows = await db.llmConfig.findMany({
    select: { provider: true, isActive: true, isDefault: true },
  });
  const stateByProvider = new Map(rows.map((r) => [r.provider, r]));

  const providers: LlmProviderItem[] = listSupportedProviderInfo().map((info) => {
    const state = stateByProvider.get(info.provider);
    return {
      ...info,
      isActive: state?.isActive ?? false,
      isDefault: state?.isDefault ?? false,
    };
  });

  return { success: true, providers };
}

// ─── Public API (uses real Prisma) ────────────────────────────────────────────

export async function listLlmProviders(isGlobalAdmin: boolean): Promise<ListLlmProvidersResult> {
  return listLlmProvidersCore(isGlobalAdmin, prisma);
}
