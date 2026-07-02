import type { ILlmProvider, LlmRequest, LlmResponse } from "../types";
import { LlmProviderError } from "../errors";

const DEFAULT_BASE_URL = "https://api.anthropic.com";

interface AnthropicMessagesResponse {
  content: { type: string; text: string }[];
}

export class ClaudeProvider implements ILlmProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl?: string | null
  ) {}

  async generate(request: LlmRequest): Promise<LlmResponse> {
    const base = (this.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");

    const res = await fetch(`${base}/v1/messages`, {
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
    });

    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      throw new LlmProviderError(`Claude API error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as AnthropicMessagesResponse;
    const text = data.content.find((c) => c.type === "text")?.text ?? "";
    return { text, raw: data };
  }
}
