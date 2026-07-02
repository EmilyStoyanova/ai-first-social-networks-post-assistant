import { prisma } from "@/lib/db/client";
import { encrypt } from "@/lib/security/encryption";
import type { CreateLlmConfigInput } from "@/lib/validators/llm-config.schema";
import {
  CONFIG_SELECT,
  PROVIDER_TO_DB,
  toLlmConfigItem,
  type LlmConfigItem,
} from "./list-llm-configs.service";

export type CreateLlmConfigResult =
  { success: true; config: LlmConfigItem } | { success: false; code: "FORBIDDEN" };

export async function createLlmConfig(
  isGlobalAdmin: boolean,
  createdBy: string,
  data: CreateLlmConfigInput
): Promise<CreateLlmConfigResult> {
  if (!isGlobalAdmin) return { success: false, code: "FORBIDDEN" };

  const apiKeyEnc = encrypt(data.apiKey);
  const provider = PROVIDER_TO_DB[data.provider];

  // Deactivate all others first, then create — sequential operations are safe
  // here since this is an admin-only action with no concurrent usage expected.
  // PrismaNeon's HTTP driver does not support interactive transactions.
  if (data.isActive) {
    await prisma.llmConfig.updateMany({ data: { isActive: false } });
  }

  const row = await prisma.llmConfig.create({
    data: { provider, modelName: data.model, apiKeyEnc, isActive: data.isActive, createdBy },
    select: CONFIG_SELECT,
  });

  return { success: true, config: toLlmConfigItem(row) };
}
