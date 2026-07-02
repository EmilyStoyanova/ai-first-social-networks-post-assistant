import type { ILlmProvider, LlmRequest, LlmResponse } from "../types";
import { LlmProviderError } from "../errors";

const DEFAULT_BASE_URL = "https://api.openai.com";

interface OpenAIChatResponse {
  choices: { message: { content: string | null } }[];
}

export class OpenAIProvider implements ILlmProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl?: string | null
  ) {}

  async generate(request: LlmRequest): Promise<LlmResponse> {
    const base = (this.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");

    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxTokens ?? 1024,
        messages: [
          { role: "system", content: request.systemPrompt },
          { role: "user", content: request.userPrompt },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      throw new LlmProviderError(`OpenAI API error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as OpenAIChatResponse;
    const text = data.choices[0]?.message?.content ?? "";
    return { text, raw: data };
  }
}
