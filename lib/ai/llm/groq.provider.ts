import type { ILlmProvider, LlmRequest, LlmResponse } from "./llm-provider";
import { LlmProviderError } from "../errors";

const DEFAULT_BASE_URL = "https://api.groq.com/openai";

interface GroqChatResponse {
  choices: { message: { content: string | null } }[];
}

export class GroqProvider implements ILlmProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl?: string
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
      throw new LlmProviderError(`Groq API error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as GroqChatResponse;
    const text = data.choices[0]?.message?.content ?? "";
    return { text, raw: data };
  }
}
