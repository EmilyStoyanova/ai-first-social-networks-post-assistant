import type { LlmProvider } from "@prisma/client";
import type { ILlmProvider, LlmRequest, LlmResponse } from "./llm-provider";
import { GroqProvider } from "./groq.provider";
import { AnthropicProvider } from "./anthropic.provider";
import { OpenAILlmProvider } from "./openai.provider";
import { TextWorkerProvider } from "./text-worker.provider";

export class NoActiveLlmProviderError extends Error {
  readonly code = "NO_ACTIVE_PROVIDER" as const;
  constructor(message?: string) {
    super(message ?? "No LLM provider is configured.");
    this.name = "NoActiveLlmProviderError";
  }
}

class MockLlmProvider implements ILlmProvider {
  async generate(_: LlmRequest): Promise<LlmResponse> {
    return { text: "", raw: {} };
  }
}

type LlmProviderName = "groq" | "anthropic" | "openai" | "text-worker";

function resolveProviderName(): LlmProviderName {
  const raw = process.env.LLM_PROVIDER?.toLowerCase().trim().replace(/_/g, "-");
  console.log("[llm-factory] LLM_PROVIDER raw value:", JSON.stringify(process.env.LLM_PROVIDER));
  console.log("[llm-factory] LLM_PROVIDER normalized:", JSON.stringify(raw));
  if (raw === "anthropic") return "anthropic";
  if (raw === "openai") return "openai";
  if (raw === "text-worker") return "text-worker";
  console.log("[llm-factory] No match — falling back to groq");
  return "groq";
}

/**
 * Returns the active provider name and model without instantiating a client.
 * Reads only from environment variables — never throws.
 * Safe to call during context building for display/snapshot purposes.
 */
export function getLlmProviderInfo(): { provider: string; model: string } {
  if (process.env.AI_MOCK_MODE === "true") {
    return { provider: "MOCK", model: "mock" };
  }

  const name = resolveProviderName();

  switch (name) {
    case "groq":
      return { provider: "GROQ", model: process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile" };
    case "anthropic":
      return { provider: "ANTHROPIC", model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6" };
    case "openai":
      return { provider: "OPENAI", model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini" };
    case "text-worker":
      return {
        provider: "TEXT_WORKER",
        model: process.env.TEXT_WORKER_MODEL ?? "qwen3:8b",
      };
    default: {
      const _exhaustive: never = name;
      return { provider: String(_exhaustive), model: "unknown" };
    }
  }
}

/**
 * Returns a ready-to-use provider instance.
 * Throws NoActiveLlmProviderError when the required API key is absent.
 * AI_MOCK_MODE=true always wins regardless of LLM_PROVIDER.
 */
export function getLlmProvider(): ILlmProvider {
  if (process.env.AI_MOCK_MODE === "true") {
    return new MockLlmProvider();
  }

  const name = resolveProviderName();
  console.log("[llm-factory] getLlmProvider resolved name:", name);

  switch (name) {
    case "groq": {
      const apiKey = process.env.GROQ_API_KEY;
      console.log("[llm-factory] Instantiating GroqProvider");
      if (!apiKey) {
        throw new NoActiveLlmProviderError(
          "GROQ_API_KEY is not set. Set LLM_PROVIDER=ANTHROPIC, LLM_PROVIDER=OPENAI, or AI_MOCK_MODE=true."
        );
      }
      return new GroqProvider(apiKey, process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile");
    }

    case "anthropic": {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new NoActiveLlmProviderError(
          "ANTHROPIC_API_KEY is not set. Set LLM_PROVIDER=GROQ, LLM_PROVIDER=OPENAI, or AI_MOCK_MODE=true."
        );
      }
      return new AnthropicProvider(apiKey, process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6");
    }

    case "openai": {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new NoActiveLlmProviderError(
          "OPENAI_API_KEY is not set. Set LLM_PROVIDER=GROQ, LLM_PROVIDER=ANTHROPIC, or AI_MOCK_MODE=true."
        );
      }
      return new OpenAILlmProvider(apiKey, process.env.OPENAI_MODEL ?? "gpt-4.1-mini");
    }

    case "text-worker": {
      console.log("[llm-factory] Instantiating TextWorkerProvider");
      const workerUrl = process.env.TEXT_WORKER_URL;
      const apiKey = process.env.TEXT_WORKER_API_KEY;
      if (!workerUrl || !apiKey) {
        throw new NoActiveLlmProviderError(
          "TEXT_WORKER_URL and TEXT_WORKER_API_KEY are required when LLM_PROVIDER=TEXT_WORKER."
        );
      }
      return new TextWorkerProvider(workerUrl, apiKey, process.env.TEXT_WORKER_MODEL ?? "qwen3:8b");
    }

    default: {
      const _exhaustive: never = name;
      throw new NoActiveLlmProviderError(`Unknown LLM_PROVIDER: "${String(_exhaustive)}".`);
    }
  }
}

/**
 * Human-readable, uppercase provider label for a supported LlmProvider. Used for
 * the `llmProvider` provenance stored on a post. Kept distinct from the env-var
 * factory's labels (e.g. "ANTHROPIC") on purpose — a config-selected provider is
 * a separate provenance identified by enum value.
 */
export const LLM_PROVIDER_LABEL: Record<LlmProvider, string> = {
  claude: "CLAUDE",
  openai: "OPENAI",
  grok: "GROK",
  text_worker: "TEXT_WORKER",
};
