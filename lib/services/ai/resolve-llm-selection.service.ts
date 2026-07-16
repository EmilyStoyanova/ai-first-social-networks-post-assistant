import type { LlmProvider } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { LLM_PROVIDER_LABEL } from "@/lib/ai/llm/llm-provider-factory";
import { getSupportedProviderInfo } from "@/lib/ai/llm/supported-providers";

/**
 * Single source of truth for "which LLM does this generation use?".
 *
 * Shared by real generation and the prompt preview so a preview can never report
 * a different provider than the one that would actually run. Selection comes only
 * from LlmConfig rows (admin-managed runtime state) — never from LLM_PROVIDER or
 * any other env var. Env holds credentials/models/URLs only.
 */

export interface LlmSelection {
  provider: LlmProvider;
  /** The LlmConfig row actually used; recorded on the post for provenance. */
  llmConfigId: string | null;
  /** Uppercase provenance label, e.g. "GROQ". */
  providerLabel: string;
  /** Model resolved from env (or a code default), e.g. "llama-3.3-70b-versatile". */
  model: string;
}

export type ResolveLlmSelectionResult =
  | { success: true; selection: LlmSelection }
  | { success: false; code: "NO_ACTIVE_PROVIDER" | "LLM_CONFIG_NOT_FOUND"; message?: string };

export interface ResolveLlmSelectionOptions {
  /** An explicit per-generation choice from the form. Never silently swapped. */
  llmConfigId?: string | null;
  /** The acting user's saved preference. Used only when still active. */
  preferredLlmConfigId?: string | null;
}

export interface ResolveLlmSelectionDeps {
  loadLlmConfig?: (id: string) => Promise<{ provider: LlmProvider } | null>;
  loadDefaultLlmConfig?: () => Promise<{ id: string; provider: LlmProvider } | null>;
}

/**
 * Precedence:
 *   1. options.llmConfigId      — an explicit one-time choice; if it is no longer
 *      active this is a hard LLM_CONFIG_NOT_FOUND, never a silent fallback.
 *   2. options.preferredLlmConfigId — the user's saved preference, used only if
 *      still active; an unavailable preference falls through (not an error).
 *   3. the admin default        — isActive && isDefault.
 * Cron/scheduled generation passes neither id, so it requires the admin default.
 */
export async function resolveLlmSelection(
  options: ResolveLlmSelectionOptions = {},
  deps: ResolveLlmSelectionDeps = {}
): Promise<ResolveLlmSelectionResult> {
  const loadLlmConfig =
    deps.loadLlmConfig ??
    ((id: string) =>
      prisma.llmConfig.findFirst({
        where: { id, isActive: true },
        select: { provider: true },
      }));
  const loadDefaultLlmConfig =
    deps.loadDefaultLlmConfig ??
    (() =>
      prisma.llmConfig.findFirst({
        where: { isActive: true, isDefault: true },
        select: { id: true, provider: true },
      }));

  let selectedConfig: { provider: LlmProvider } | null = null;
  let resolvedLlmConfigId: string | null = null;

  if (options.llmConfigId) {
    // An explicit choice is never silently swapped: an inactive/deleted id errors.
    selectedConfig = await loadLlmConfig(options.llmConfigId);
    if (!selectedConfig) {
      return { success: false, code: "LLM_CONFIG_NOT_FOUND" };
    }
    resolvedLlmConfigId = options.llmConfigId;
  } else {
    if (options.preferredLlmConfigId) {
      const preferred = await loadLlmConfig(options.preferredLlmConfigId);
      if (preferred) {
        selectedConfig = preferred;
        resolvedLlmConfigId = options.preferredLlmConfigId;
      }
    }
    if (!selectedConfig) {
      const adminDefault = await loadDefaultLlmConfig();
      if (adminDefault) {
        selectedConfig = adminDefault;
        resolvedLlmConfigId = adminDefault.id;
      }
    }
  }

  // No explicit selection, no active preference, and no active admin default. There
  // is deliberately no env fallback — refuse clearly so an admin configures one.
  if (!selectedConfig) {
    return {
      success: false,
      code: "NO_ACTIVE_PROVIDER",
      message: "No default AI model is configured. Contact an administrator.",
    };
  }

  return {
    success: true,
    selection: {
      provider: selectedConfig.provider,
      llmConfigId: resolvedLlmConfigId,
      providerLabel: LLM_PROVIDER_LABEL[selectedConfig.provider],
      model: getSupportedProviderInfo(selectedConfig.provider)?.model ?? "unknown",
    },
  };
}
