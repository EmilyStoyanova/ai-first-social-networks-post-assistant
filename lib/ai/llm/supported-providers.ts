import type { LlmProvider } from "@prisma/client";
import type { ILlmProvider } from "./llm-provider";
import { GroqProvider } from "./groq.provider";
import { AnthropicProvider } from "./anthropic.provider";
import { OpenAILlmProvider } from "./openai.provider";
import { TextWorkerProvider } from "./text-worker.provider";

/**
 * The fixed set of LLM providers implemented in code. Adding a provider is a
 * developer task (a new entry here + its provider class). Administrators only
 * manage runtime state (active/default) — never credentials.
 *
 * Credentials, worker URLs, and model names come ONLY from environment variables
 * / deployment secrets. Nothing here is ever stored in, or read from, the DB.
 */

/**
 * Whether a provider can actually be used right now, derived purely from env:
 *   • available       — all required env config is present
 *   • misconfigured   — partially configured (e.g. worker URL set but no key)
 *   • not_configured  — no required env config present
 * Only "available" providers may be activated.
 */
export type ProviderStatus = "available" | "misconfigured" | "not_configured";

export interface SupportedProviderInfo {
  provider: LlmProvider;
  displayName: string;
  /** The model this provider will use, resolved from env (or a code default). */
  model: string;
  status: ProviderStatus;
}

/** Thrown when building a provider whose required env config is absent. */
export class ProviderNotAvailableError extends Error {
  readonly code = "PROVIDER_NOT_AVAILABLE" as const;
  constructor(
    readonly provider: LlmProvider,
    message?: string
  ) {
    super(message ?? `Provider "${provider}" is not configured.`);
    this.name = "ProviderNotAvailableError";
  }
}

interface ProviderDef {
  provider: LlmProvider;
  displayName: string;
  /** Resolves the model from env, falling back to a sensible code default. */
  model: () => string;
  /** Availability derived from env only. */
  status: () => ProviderStatus;
  /** Builds a ready-to-use instance; throws ProviderNotAvailableError if not available. */
  build: (model: string) => ILlmProvider;
}

const DEFS: readonly ProviderDef[] = [
  {
    provider: "grok",
    displayName: "Grok",
    model: () => process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile",
    status: () => (process.env.GROQ_API_KEY ? "available" : "not_configured"),
    build: (model) => {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) throw new ProviderNotAvailableError("grok", "GROQ_API_KEY is not set.");
      return new GroqProvider(apiKey, model);
    },
  },
  {
    provider: "text_worker",
    displayName: "Text Worker",
    model: () => process.env.TEXT_WORKER_MODEL ?? "qwen3:8b",
    status: () => {
      const hasUrl = !!process.env.TEXT_WORKER_URL;
      const hasKey = !!process.env.TEXT_WORKER_API_KEY;
      if (hasUrl && hasKey) return "available";
      if (hasUrl || hasKey) return "misconfigured";
      return "not_configured";
    },
    build: (model) => {
      const url = process.env.TEXT_WORKER_URL;
      const apiKey = process.env.TEXT_WORKER_API_KEY;
      if (!url || !apiKey) {
        throw new ProviderNotAvailableError(
          "text_worker",
          "TEXT_WORKER_URL and TEXT_WORKER_API_KEY are required."
        );
      }
      return new TextWorkerProvider(url, apiKey, model);
    },
  },
  {
    provider: "claude",
    displayName: "Claude",
    model: () => process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
    status: () => (process.env.ANTHROPIC_API_KEY ? "available" : "not_configured"),
    build: (model) => {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new ProviderNotAvailableError("claude", "ANTHROPIC_API_KEY is not set.");
      return new AnthropicProvider(apiKey, model);
    },
  },
  {
    provider: "openai",
    displayName: "OpenAI",
    model: () => process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
    status: () => (process.env.OPENAI_API_KEY ? "available" : "not_configured"),
    build: (model) => {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new ProviderNotAvailableError("openai", "OPENAI_API_KEY is not set.");
      return new OpenAILlmProvider(apiKey, model);
    },
  },
] as const;

const BY_PROVIDER = new Map<LlmProvider, ProviderDef>(DEFS.map((d) => [d.provider, d]));

/** All supported provider enum values, in display order. */
export const SUPPORTED_PROVIDERS: readonly LlmProvider[] = DEFS.map((d) => d.provider);

export function isSupportedProvider(value: string): value is LlmProvider {
  return BY_PROVIDER.has(value as LlmProvider);
}

/** Display info (name, model, availability) for one provider, or null if unsupported. */
export function getSupportedProviderInfo(provider: LlmProvider): SupportedProviderInfo | null {
  const def = BY_PROVIDER.get(provider);
  if (!def) return null;
  return {
    provider: def.provider,
    displayName: def.displayName,
    model: def.model(),
    status: def.status(),
  };
}

/** Display info for every supported provider, in display order. */
export function listSupportedProviderInfo(): SupportedProviderInfo[] {
  return DEFS.map((d) => ({
    provider: d.provider,
    displayName: d.displayName,
    model: d.model(),
    status: d.status(),
  }));
}

export function isProviderAvailable(provider: LlmProvider): boolean {
  return getSupportedProviderInfo(provider)?.status === "available";
}

/**
 * Builds a ready-to-use provider instance for a supported provider, reading
 * credentials from env. Throws ProviderNotAvailableError when the required env
 * config is missing. Returns the resolved model alongside the instance so callers
 * can record accurate provenance.
 */
export function buildSupportedProvider(provider: LlmProvider): {
  instance: ILlmProvider;
  model: string;
} {
  const def = BY_PROVIDER.get(provider);
  if (!def) throw new ProviderNotAvailableError(provider, `Unknown provider: "${provider}".`);
  const model = def.model();
  return { instance: def.build(model), model };
}
