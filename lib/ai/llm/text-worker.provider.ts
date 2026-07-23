import type { ILlmProvider, LlmRequest, LlmResponse } from "./llm-provider";
import { LlmProviderError } from "../errors";
import { requestSignal } from "@/lib/http/request-deadline";

/**
 * Per-request cap; squeezed smaller when a cron deadline leaves less budget.
 * Set to 300s to accommodate slow self-hosted (e.g. Ollama) generations — the Mac
 * text-worker's own Ollama timeout is 300s, so this must match to avoid the app
 * aborting a request the worker would have completed. No env override exists; this
 * compile-time constant is the single source of truth for the cap.
 *
 * NB: on the background-worker path a single request can now approach the job lease
 * TTL (WORKER_LEASE_TTL_MS, default 300s). Operators running slow generations should
 * raise WORKER_LEASE_TTL_MS above this cap plus run overhead so a long in-flight call
 * cannot have its job reaped mid-flight.
 */
export const TEXT_WORKER_TIMEOUT_MS = 300_000;

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
        signal: requestSignal(TEXT_WORKER_TIMEOUT_MS),
      });
    } catch (err) {
      // Diagnostic: distinguish a timeout from an unreachable/transport failure.
      // No prompt, key, or body content is logged — only the failure category.
      // AbortError also fires when the ambient cron deadline cuts the request short.
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        console.warn("[llm-diag] text-worker transport failure: category=timeout");
        throw new LlmProviderError("Text worker request exceeded its deadline");
      }
      console.warn(
        `[llm-diag] text-worker transport failure: category=unreachable name=${
          err instanceof Error ? err.name : "unknown"
        }`
      );
      throw new LlmProviderError(
        `Text worker unreachable: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Diagnostic: the worker HTTP status for this POST (one line per attempt,
    // including the aspect-mining call). Status/ok only — no response body.
    console.info(`[llm-diag] text-worker response: status=${res.status} ok=${res.ok}`);

    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      throw new LlmProviderError(`Text worker error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as TextWorkerResponse;
    return { text: data.text ?? "", raw: data };
  }
}
