import { prisma } from "@/lib/db/client";
import { decrypt } from "@/lib/security/encryption";
import type { ILlmProvider } from "./types";
import { ClaudeProvider } from "./providers/claude";
import { OpenAIProvider } from "./providers/openai";
import { GrokProvider } from "./providers/grok";

export interface ActiveLlmInfo {
  provider: string;
  model: string;
}

export class NoActiveProviderError extends Error {
  readonly code = "NO_ACTIVE_PROVIDER" as const;
  constructor() {
    super("No active LLM provider is configured.");
  }
}

async function loadActiveConfig(): Promise<{
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string | null;
}> {
  const row = await prisma.llmConfig.findFirst({
    where: { isActive: true },
    select: { provider: true, modelName: true, apiKeyEnc: true, baseUrl: true },
  });
  if (!row) throw new NoActiveProviderError();

  // Decrypt here — key never leaves this function
  const apiKey = decrypt(row.apiKeyEnc);
  return { provider: row.provider, model: row.modelName, apiKey, baseUrl: row.baseUrl };
}

/**
 * Returns the active LLM provider (name + model) without the API key.
 * Safe to use for preview / context building.
 */
export async function getActiveLlmInfo(): Promise<ActiveLlmInfo> {
  const row = await prisma.llmConfig.findFirst({
    where: { isActive: true },
    select: { provider: true, modelName: true },
  });
  if (!row) throw new NoActiveProviderError();
  return { provider: row.provider.toUpperCase(), model: row.modelName };
}

/**
 * Returns a ready-to-use provider instance with the decrypted API key.
 * Call only when an actual LLM request will be made.
 */
export async function getLlmProvider(): Promise<{ provider: ILlmProvider; info: ActiveLlmInfo }> {
  const { provider, model, apiKey, baseUrl } = await loadActiveConfig();

  let instance: ILlmProvider;
  switch (provider) {
    case "claude":
      instance = new ClaudeProvider(apiKey, model, baseUrl);
      break;
    case "openai":
      instance = new OpenAIProvider(apiKey, model, baseUrl);
      break;
    case "grok":
      instance = new GrokProvider(apiKey, model, baseUrl);
      break;
    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }

  return { provider: instance, info: { provider: provider.toUpperCase(), model } };
}
