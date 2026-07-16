import type { LlmProvider } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getSupportedProviderInfo } from "@/lib/ai/llm/supported-providers";
import type { LlmProviderItem } from "./list-llm-providers.service";

export interface SetLlmProviderStateInput {
  isActive?: boolean;
  isDefault?: boolean;
}

export type SetLlmProviderStateResult =
  | { success: true; provider: LlmProviderItem }
  | { success: false; code: "FORBIDDEN" | "NOT_FOUND" | "PROVIDER_NOT_AVAILABLE" };

export interface SetLlmProviderStateDb {
  llmConfig: {
    findUnique: (args: {
      where: { provider: LlmProvider };
      select: { isActive: true; isDefault: true };
    }) => Promise<{ isActive: boolean; isDefault: boolean } | null>;
    updateMany: (args: {
      where: { provider: { not: LlmProvider } };
      data: { isDefault: false };
    }) => Promise<{ count: number }>;
    upsert: (args: {
      where: { provider: LlmProvider };
      create: { provider: LlmProvider; isActive: boolean; isDefault: boolean };
      update: { isActive: boolean; isDefault: boolean };
      select: { isActive: true; isDefault: true };
    }) => Promise<{ isActive: boolean; isDefault: boolean }>;
  };
}

/**
 * Sets the active/default runtime state for a supported provider. The row is
 * created on demand (one per provider). Rules:
 *   • only supported providers can be managed (unsupported → NOT_FOUND)
 *   • a provider can be activated / made default only when it is AVAILABLE (its
 *     required env config exists) — otherwise PROVIDER_NOT_AVAILABLE
 *   • a default is always active, and promoting one clears the previous default
 *   • deactivating a provider also clears its default flag
 * Credentials are never touched — this only flips runtime flags.
 */
export async function setLlmProviderStateCore(
  isGlobalAdmin: boolean,
  provider: LlmProvider,
  input: SetLlmProviderStateInput,
  db: SetLlmProviderStateDb
): Promise<SetLlmProviderStateResult> {
  if (!isGlobalAdmin) return { success: false, code: "FORBIDDEN" };

  const info = getSupportedProviderInfo(provider);
  if (!info) return { success: false, code: "NOT_FOUND" };

  const existing = await db.llmConfig.findUnique({
    where: { provider },
    select: { isActive: true, isDefault: true },
  });

  // Resolve the target state. A default implies active; deactivating clears default.
  let nextActive = input.isActive ?? existing?.isActive ?? false;
  let nextDefault = existing?.isDefault ?? false;
  if (input.isDefault === true) {
    nextDefault = true;
    nextActive = true;
  } else if (input.isDefault === false) {
    nextDefault = false;
  }
  if (nextActive === false) nextDefault = false;

  // Availability gate — an unavailable provider can never be active or default.
  if (nextActive && info.status !== "available") {
    return { success: false, code: "PROVIDER_NOT_AVAILABLE" };
  }

  // Exclusive default — clear the previous default before promoting this one.
  if (nextDefault) {
    await db.llmConfig.updateMany({
      where: { provider: { not: provider } },
      data: { isDefault: false },
    });
  }

  const row = await db.llmConfig.upsert({
    where: { provider },
    create: { provider, isActive: nextActive, isDefault: nextDefault },
    update: { isActive: nextActive, isDefault: nextDefault },
    select: { isActive: true, isDefault: true },
  });

  return {
    success: true,
    provider: { ...info, isActive: row.isActive, isDefault: row.isDefault },
  };
}

// ─── Public API (uses real Prisma) ────────────────────────────────────────────

export async function setLlmProviderState(
  isGlobalAdmin: boolean,
  provider: LlmProvider,
  input: SetLlmProviderStateInput
): Promise<SetLlmProviderStateResult> {
  return setLlmProviderStateCore(isGlobalAdmin, provider, input, prisma);
}
