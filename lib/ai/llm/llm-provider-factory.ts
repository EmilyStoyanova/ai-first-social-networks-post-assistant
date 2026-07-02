import type { ILlmProvider, LlmRequest, LlmResponse } from "./llm-provider";
import { GroqProvider } from "./groq.provider";
import { AnthropicProvider } from "./anthropic.provider";
import { OpenAILlmProvider } from "./openai.provider";

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

type LlmProviderName = "groq" | "anthropic" | "openai";

function resolveProviderName(): LlmProviderName {
  const raw = process.env.LLM_PROVIDER?.toLowerCase().trim();
  if (raw === "anthropic") return "anthropic";
  if (raw === "openai") return "openai";
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

  switch (name) {
    case "groq": {
      const apiKey = process.env.GROQ_API_KEY;
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

    default: {
      const _exhaustive: never = name;
      throw new NoActiveLlmProviderError(`Unknown LLM_PROVIDER: "${String(_exhaustive)}".`);
    }
  }
}
