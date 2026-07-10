import type { ILlmProvider, LlmRequest, LlmResponse } from "./llm-provider";
import { LlmProviderError } from "../errors";

interface TextWorkerResponse {
  text: string;
}

export class TextWorkerProvider implements ILlmProvider {
  constructor(
    private readonly workerUrl: string,
    private readonly apiKey: string,
    private readonly model: string
  ) {}

  async generate(request: LlmRequest): Promise<LlmResponse> {
    const url = this.workerUrl.replace(/\/$/, "");

    const prompt = request.systemPrompt
      ? `${request.systemPrompt}\n\n${request.userPrompt}`
      : request.userPrompt;

    let res: Response;
    try {
      res = await fetch(`${url}/generate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-worker-api-key": this.apiKey,
        },
        body: JSON.stringify({ prompt, model: this.model }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new LlmProviderError("Text worker timed out after 120 seconds");
      }
      throw new LlmProviderError(
        `Text worker unreachable: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      throw new LlmProviderError(`Text worker error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as TextWorkerResponse;
    return { text: data.text ?? "", raw: data };
  }
}
