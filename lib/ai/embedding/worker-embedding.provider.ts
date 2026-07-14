import {
  EmbeddingProviderError,
  type EmbeddingResult,
  type IEmbeddingProvider,
} from "./embedding-provider";

/**
 * Local-first embedding provider backed by the self-hosted TEXT_WORKER
 * (Phase 1.3). Mirrors the text/image worker providers: same base URL, same
 * `x-worker-api-key` header. No cloud vendor and no third-party API key.
 *
 * Contract — POST {TEXT_WORKER_URL}/embed
 *   request:  { "texts": ["..."] }
 *   response: { "provider": "worker", "model": "bge-m3",
 *               "dimensions": 1024, "vectors": [[...]] }
 *
 * embed() throws EmbeddingProviderError on any transport/shape failure. Callers
 * (embed-post.service) treat embedding as best-effort, so a throw here never
 * breaks post generation — it is recorded as a 'failed' row for the backfill.
 */

interface WorkerEmbedResponse {
  provider?: string;
  model?: string;
  dimensions?: number;
  vectors?: number[][];
}

export class WorkerEmbeddingProvider implements IEmbeddingProvider {
  readonly provider = "worker";

  constructor(
    private readonly workerUrl: string,
    private readonly apiKey: string,
    readonly model: string,
    readonly dims: number
  ) {}

  async embed(texts: string[]): Promise<EmbeddingResult> {
    const url = this.workerUrl.replace(/\/$/, "");

    let res: Response;
    try {
      res = await fetch(`${url}/embed`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-worker-api-key": this.apiKey,
        },
        body: JSON.stringify({ texts }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new EmbeddingProviderError("Embedding worker timed out after 60 seconds");
      }
      throw new EmbeddingProviderError(
        `Embedding worker unreachable: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      throw new EmbeddingProviderError(`Embedding worker error ${res.status}: ${body}`);
    }

    const data = (await res.json()) as WorkerEmbedResponse;
    const vectors = data.vectors;
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
      throw new EmbeddingProviderError(
        `Embedding worker returned ${vectors?.length ?? "no"} vectors for ${texts.length} inputs`
      );
    }

    return {
      vectors,
      // Prefer what the worker actually reports, so stored metadata is accurate;
      // fall back to the configured expectations.
      provider: data.provider ?? this.provider,
      model: data.model ?? this.model,
      dims: data.dimensions ?? this.dims,
    };
  }
}
