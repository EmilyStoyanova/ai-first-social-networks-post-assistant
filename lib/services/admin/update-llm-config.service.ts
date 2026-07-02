import { prisma } from "@/lib/db/client";
import { encrypt } from "@/lib/security/encryption";
import type { UpdateLlmConfigInput } from "@/lib/validators/llm-config.schema";
import { CONFIG_SELECT, toLlmConfigItem, type LlmConfigItem } from "./list-llm-configs.service";

export type UpdateLlmConfigResult =
  { success: true; config: LlmConfigItem } | { success: false; code: "FORBIDDEN" | "NOT_FOUND" };

export async function updateLlmConfig(
  isGlobalAdmin: boolean,
  id: string,
  data: UpdateLlmConfigInput
): Promise<UpdateLlmConfigResult> {
  if (!isGlobalAdmin) return { success: false, code: "FORBIDDEN" };

  const existing = await prisma.llmConfig.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return { success: false, code: "NOT_FOUND" };

  // Sequential operations — PrismaNeon's HTTP driver does not support interactive transactions.
  if (data.isActive === true) {
    await prisma.llmConfig.updateMany({ where: { id: { not: id } }, data: { isActive: false } });
  }

  const patch: { modelName?: string; apiKeyEnc?: string; isActive?: boolean } = {};
  if (data.model !== undefined) patch.modelName = data.model;
  if (data.apiKey !== undefined) patch.apiKeyEnc = encrypt(data.apiKey);
  if (data.isActive !== undefined) patch.isActive = data.isActive;

  const row = await prisma.llmConfig.update({ where: { id }, data: patch, select: CONFIG_SELECT });

  return { success: true, config: toLlmConfigItem(row) };
}
