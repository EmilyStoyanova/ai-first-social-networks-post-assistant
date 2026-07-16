import type { LlmProvider } from "@prisma/client";

/**
 * Human-readable, uppercase provider label for a supported LlmProvider. Used for
 * the `llmProvider` provenance stored on a post and in audit metadata.
 *
 * Providers are selected exclusively from LlmConfig rows (see
 * resolve-llm-selection.service.ts) — there is deliberately no env-var-driven
 * provider selection. Env supplies credentials, model names, and worker URLs only.
 */
export const LLM_PROVIDER_LABEL: Record<LlmProvider, string> = {
  claude: "CLAUDE",
  openai: "OPENAI",
  // The `grok` enum value is a historical misnomer retained for DB compatibility.
  // The provider is Groq (api.groq.com); the label reflects the real vendor.
  grok: "GROQ",
  text_worker: "TEXT_WORKER",
};
