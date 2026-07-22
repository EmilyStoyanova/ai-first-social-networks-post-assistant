import type { ILlmProvider, LlmRequest, LlmResponse } from "./llm-provider";
import { LlmProviderError } from "../errors";
import { requestSignal } from "@/lib/http/request-deadline";

const DEFAULT_BASE_URL = "https://api.openai.com";

/** Per-request cap for a single OpenAI call; squeezed smaller under a cron deadline. */
const OPENAI_TIMEOUT_MS = 90_000;

interface OpenAIChatResponse {
  choices: { message: { content: string | null } }[];
}

export class OpenAILlmProvider implements ILlmProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl?: string | null
  ) {}

  async generate(request: LlmRequest): Promise<LlmResponse> {
    const base = (this.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");

    let res: Response;
    try {
      res = await fetch(`${base}/v1/chat/completions`, {
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
        // Bounded by the ambient cron deadline so a hung call cannot run past it.
        signal: requestSignal(OPENAI_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new LlmProviderError("OpenAI request exceeded its deadline");
      }
      throw new LlmProviderError(
        `OpenAI unreachable: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      throw new LlmProviderError(`OpenAI API error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as OpenAIChatResponse;
    const text = data.choices[0]?.message?.content ?? "";
    return { text, raw: data };
  }
}
