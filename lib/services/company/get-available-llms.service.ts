import type { LlmProvider } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getLlmProviderInfo } from "@/lib/ai/llm/llm-provider-factory";

/**
 * A configured LLM a company member may pick for a single generation (v2-5).
 * Deliberately narrow: it NEVER carries the API key, encrypted secret, base URL,
 * or creator — only what the generation dropdown needs to render and select.
 */
export interface AvailableLlm {
  id: string;
  displayName: string;
  provider: LlmProvider;
  model: string;
  /** True when this config's provider matches the env-var default (LLM_PROVIDER). */
  isDefault: boolean;
}

export type GetAvailableLlmsResult =
  { success: true; llms: AvailableLlm[] } | { success: false; code: "NOT_FOUND" };

/** Friendly, human-facing provider name for the dropdown display label. */
const PROVIDER_DISPLAY: Record<LlmProvider, string> = {
  claude: "Claude",
  openai: "OpenAI",
  grok: "Grok",
  text_worker: "Text Worker",
};

/**
 * Maps a configured provider enum to the uppercase label the env-var factory
 * reports via getLlmProviderInfo().provider, so `isDefault` compares like-for-like
 * ("claude" config ↔ "ANTHROPIC" env default).
 */
const PROVIDER_TO_ENV_LABEL: Record<LlmProvider, string> = {
  claude: "ANTHROPIC",
  openai: "OPENAI",
  grok: "GROQ",
  text_worker: "TEXT_WORKER",
};

/**
 * Lists the active LLM configs available to a company member for per-generation
 * selection. Any member (owner or editor) or a global admin may read this; the
 * response is scrubbed of every secret (see AvailableLlm).
 */
export async function getAvailableLlms(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<GetAvailableLlmsResult> {
  // RBAC — confirm the caller can see this company (mirrors listChannelConfigs).
  if (isGlobalAdmin) {
    const company = await prisma.company.findUnique({ where: { slug }, select: { id: true } });
    if (!company) return { success: false, code: "NOT_FOUND" };
  } else {
    const membership = await prisma.companyMember.findFirst({
      where: { company: { slug }, userId },
      select: { companyId: true },
    });
    if (!membership) return { success: false, code: "NOT_FOUND" };
  }

  const rows = await prisma.llmConfig.findMany({
    where: { isActive: true },
    // Explicit select — the encrypted key and base URL must never leave this layer.
    select: { id: true, provider: true, modelName: true },
    orderBy: { createdAt: "asc" },
  });

  const defaultEnvLabel = getLlmProviderInfo().provider;

  const llms: AvailableLlm[] = rows.map((row) => ({
    id: row.id,
    displayName: `${PROVIDER_DISPLAY[row.provider]} · ${row.modelName}`,
    provider: row.provider,
    model: row.modelName,
    isDefault: PROVIDER_TO_ENV_LABEL[row.provider] === defaultEnvLabel,
  }));

  return { success: true, llms };
}
