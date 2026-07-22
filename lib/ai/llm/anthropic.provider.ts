import type { ILlmProvider, LlmRequest, LlmResponse } from "./llm-provider";
import { LlmProviderError } from "../errors";
import { requestSignal } from "@/lib/http/request-deadline";

const DEFAULT_BASE_URL = "https://api.anthropic.com";

/** Per-request cap for a single Anthropic call; squeezed smaller under a cron deadline. */
const ANTHROPIC_TIMEOUT_MS = 90_000;

interface AnthropicMessagesResponse {
  content: { type: string; text: string }[];
}

export class AnthropicProvider implements ILlmProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl?: string | null
  ) {}

  async generate(request: LlmRequest): Promise<LlmResponse> {
    const base = (this.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");

    let res: Response;
    try {
      res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: request.maxTokens ?? 1024,
          temperature: request.temperature ?? 0.7,
          system: request.systemPrompt,
          messages: [{ role: "user", content: request.userPrompt }],
        }),
        // Bounded by the ambient cron deadline so a hung call cannot run past it.
        signal: requestSignal(ANTHROPIC_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new LlmProviderError("Anthropic request exceeded its deadline");
      }
      throw new LlmProviderError(
        `Anthropic unreachable: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      throw new LlmProviderError(`Anthropic API error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as AnthropicMessagesResponse;
    const text = data.content.find((c) => c.type === "text")?.text ?? "";
    return { text, raw: data };
  }
}
