import { type IEmbeddingProvider } from "./embedding-provider";
import { MockEmbeddingProvider } from "./mock-embedding.provider";
import { WorkerEmbeddingProvider } from "./worker-embedding.provider";

/**
 * Embedding-provider factory — a separate axis from LLM text generation
 * (embeddings are not coupled to the text provider, and unlike it this factory
 * is legitimately env-driven: there is no admin-managed embedding config).
 *
 * Fully LOCAL-FIRST: no cloud embedding provider, no third-party API key.
 * Resolution:
 *
 *   AI_MOCK_MODE=true            → mock (deterministic, offline)
 *   EMBEDDING_PROVIDER=mock      → mock
 *   EMBEDDING_PROVIDER=worker    → the local TEXT_WORKER (POST {TEXT_WORKER_URL}
 *                                  /embed, x-worker-api-key). Usable only when
 *                                  TEXT_WORKER_URL and TEXT_WORKER_API_KEY are
 *                                  set; otherwise reports unusable (skip cleanly).
 *   (unset / anything else)      → no active provider → embedding is skipped.
 *
 * When no provider is usable, post generation continues normally and simply
 * skips the best-effort embedding step.
 *
 * The dimension is fixed at EMBEDDING_DIMENSIONS to match the pgvector column.
 */

/** Must equal the pgvector column dimension in post_semantics.embedding. */
export const EMBEDDING_DIMENSIONS = 1024;

/** Model served by the local TEXT_WORKER /embed endpoint. */
const WORKER_EMBEDDING_MODEL = "bge-m3";

export class NoActiveEmbeddingProviderError extends Error {
  readonly code = "NO_ACTIVE_EMBEDDING_PROVIDER" as const;
  constructor(message?: string) {
    super(message ?? "No embedding provider is configured.");
    this.name = "NoActiveEmbeddingProviderError";
  }
}

type EmbeddingProviderName = "mock" | "worker" | "none";

function resolveProviderName(): EmbeddingProviderName {
  if (process.env.AI_MOCK_MODE === "true") return "mock";
  const raw = process.env.EMBEDDING_PROVIDER?.toLowerCase().trim();
  if (raw === "mock") return "mock";
  if (raw === "worker") return "worker";
  // Unset or unrecognized → no active provider (embedding is skipped cleanly).
  return "none";
}

function resolveDimensions(): number {
  const raw = process.env.EMBEDDING_DIMENSIONS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : EMBEDDING_DIMENSIONS;
}

/** Worker embeddings reuse the TEXT_WORKER endpoint + key (same as text gen). */
function resolveWorkerConfig(): { url: string; apiKey: string } | null {
  const url = process.env.TEXT_WORKER_URL?.trim();
  const apiKey = process.env.TEXT_WORKER_API_KEY?.trim();
  if (!url || !apiKey) return null;
  return { url, apiKey };
}

/**
 * Reports the active provider without instantiating a client or requiring a key.
 * Returns null when no provider is usable (worker reserved, or none configured),
 * so callers (embed + backfill) can skip cleanly instead of throwing.
 */
export function getEmbeddingProviderInfo(): {
  provider: string;
  model: string;
  dims: number;
} | null {
  const name = resolveProviderName();
  const dims = resolveDimensions();

  switch (name) {
    case "mock":
      return { provider: "mock", model: "mock", dims };
    case "worker": {
      // Usable only when the TEXT_WORKER endpoint + key are configured;
      // otherwise report unusable so embedding is skipped cleanly.
      if (!resolveWorkerConfig()) return null;
      return { provider: "worker", model: WORKER_EMBEDDING_MODEL, dims };
    }
    case "none":
      return null;
    default: {
      const _exhaustive: never = name;
      return _exhaustive;
    }
  }
}

/**
 * Returns a ready-to-use embedding provider.
 * Throws NoActiveEmbeddingProviderError when no provider is usable.
 */
export function getEmbeddingProvider(): IEmbeddingProvider {
  const name = resolveProviderName();
  const dims = resolveDimensions();

  switch (name) {
    case "mock":
      return new MockEmbeddingProvider(dims);

    case "worker": {
      const cfg = resolveWorkerConfig();
      if (!cfg) {
        throw new NoActiveEmbeddingProviderError(
          "EMBEDDING_PROVIDER=worker requires TEXT_WORKER_URL and TEXT_WORKER_API_KEY."
        );
      }
      return new WorkerEmbeddingProvider(cfg.url, cfg.apiKey, WORKER_EMBEDDING_MODEL, dims);
    }

    case "none":
      throw new NoActiveEmbeddingProviderError(
        "No embedding provider is configured. Set EMBEDDING_PROVIDER=worker (once implemented), EMBEDDING_PROVIDER=mock, or AI_MOCK_MODE=true."
      );

    default: {
      const _exhaustive: never = name;
      throw new NoActiveEmbeddingProviderError(
        `Unknown EMBEDDING_PROVIDER: "${String(_exhaustive)}".`
      );
    }
  }
}

/** Like getEmbeddingProvider() but returns null instead of throwing. */
export function getEmbeddingProviderOrNull(): IEmbeddingProvider | null {
  try {
    return getEmbeddingProvider();
  } catch (err) {
    if (err instanceof NoActiveEmbeddingProviderError) return null;
    throw err;
  }
}
