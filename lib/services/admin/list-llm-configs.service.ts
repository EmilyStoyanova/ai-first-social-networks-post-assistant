import { prisma } from "@/lib/db/client";

// ─── Shared types ─────────────────────────────────────────────────────────────

export type LlmProvider = "CLAUDE" | "OPENAI" | "GROK" | "TEXT_WORKER";

export type LlmConfigItem = {
  id: string;
  provider: LlmProvider;
  model: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

// ─── Shared helpers (imported by create / update services) ────────────────────

export const CONFIG_SELECT = {
  id: true,
  provider: true,
  modelName: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;

const PROVIDER_FROM_DB: Record<string, LlmProvider> = {
  claude: "CLAUDE",
  openai: "OPENAI",
  grok: "GROK",
  text_worker: "TEXT_WORKER",
};

export const PROVIDER_TO_DB: Record<LlmProvider, "claude" | "openai" | "grok" | "text_worker"> = {
  CLAUDE: "claude",
  OPENAI: "openai",
  GROK: "grok",
  TEXT_WORKER: "text_worker",
};

export function toLlmConfigItem(row: {
  id: string;
  provider: string;
  modelName: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}): LlmConfigItem {
  return {
    id: row.id,
    provider: PROVIDER_FROM_DB[row.provider] ?? "CLAUDE",
    model: row.modelName,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ─── Service ──────────────────────────────────────────────────────────────────

export type ListLlmConfigsResult =
  { success: true; configs: LlmConfigItem[] } | { success: false; code: "FORBIDDEN" };

export async function listLlmConfigs(isGlobalAdmin: boolean): Promise<ListLlmConfigsResult> {
  if (!isGlobalAdmin) return { success: false, code: "FORBIDDEN" };

  const rows = await prisma.llmConfig.findMany({
    orderBy: { createdAt: "asc" },
    select: CONFIG_SELECT,
  });

  return { success: true, configs: rows.map(toLlmConfigItem) };
}
