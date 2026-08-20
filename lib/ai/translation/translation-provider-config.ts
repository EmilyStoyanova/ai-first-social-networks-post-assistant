import { TRANSLATION_PROVIDER_KINDS, type TranslationProviderKind } from "./translation-provider";

/**
 * How a deployment selects its translation engine — pure, so it is testable
 * without touching `process.env`.
 *
 * The single rule that governs every default here: **an absent variable must mean
 * exactly what the pipeline did before this file existed.** `TRANSLATION_PROVIDER`
 * unset is `ollama`; the Ollama model override unset means "whatever the admin
 * default LLM resolves to"; the fallback unset means "no fallback at all".
 */

/** The default engine. Never change this without an explicit production decision. */
export const DEFAULT_TRANSLATION_PROVIDER: TranslationProviderKind = "ollama";

/** The official checkpoint. Overridable, but this is the one that was asked for. */
export const DEFAULT_MADLAD_MODEL = "google/madlad400-3b-mt";

/**
 * How many MADLAD segment calls may be in flight at once. `1` — today's fully
 * sequential behaviour — until a deployment's own worker is measured otherwise.
 *
 * This is NOT a placeholder someone forgot to raise. Measured live against the
 * production Mac text worker (2026-08-20, feed item 825c8475's real segments,
 * unique payloads so no result cache could contaminate the numbers): concurrency 2
 * took ~3.3x a single call's median latency, and concurrency 3 took even more —
 * WORSE than the 2x/3x a neutrally-serialized worker would show, not better. That
 * matches this file's own worker-side comment ("the Python side holds a single 3B
 * model and serialises anyway") — the bottleneck is the persistent Python process,
 * not this HTTP client, so raising this app-side would add contention without
 * adding throughput. Request/response correlation itself was verified safe even at
 * concurrency 5 (distinct payloads, no cross-matching), so `TRANSLATION_MADLAD_CONCURRENCY`
 * was added as an operator escape hatch for AFTER a worker-side fix.
 *
 * That worker-side fix has since landed as HTTP BATCHING (see
 * {@link DEFAULT_MADLAD_HTTP_BATCH_SIZE}), not as safe simultaneous requests — batching
 * measured a real 1.52x speedup; concurrent single-segment HTTP calls measured a
 * REGRESSION. `TRANSLATION_MADLAD_CONCURRENCY` therefore has NO EFFECT on the MADLAD
 * batch dispatch path today: it is kept parsing (so a deployment that already set it
 * does not start seeing a warning) and the constructor still accepts it, but nothing
 * in `MadladTranslationProvider.translate()` reads it for batch requests, which are
 * always sequential regardless of its value.
 */
export const DEFAULT_MADLAD_CONCURRENCY = 1;

/**
 * The worker's own hard ceiling for one `/translate` batch request. Fixed by the
 * worker, not a deployment choice — never raise this from the app side.
 */
export const MADLAD_MAX_HTTP_BATCH_SIZE = 32;

/**
 * How many segments go in ONE `/translate` HTTP request, using the worker's `texts[]`
 * batch contract (commit d829fec on the text-worker repo). Measured live against a
 * real 120-segment article (feed item 825c8475, 2026-08-20): sequential one-per-call
 * took 189.4s over 120 HTTP requests; batches of 30 (4 HTTP requests, 32 model.generate
 * calls internally at the worker's own batch size of 4) took 124.9s — a 1.52x
 * speedup, with ordering, protected-token restoration, and memory all verified stable.
 *
 * 30, not the worker's max of 32: the same margin below a hard ceiling this file
 * already uses elsewhere (batch 32 would be the ceiling itself, leaving zero room for
 * the worker's own internal chunking to round evenly). This is UNRELATED to
 * {@link DEFAULT_MADLAD_CONCURRENCY} (client-side simultaneous HTTP requests — proven
 * to hurt, stays 1) and to the worker's own `MADLAD_GENERATE_BATCH_SIZE=4` (its
 * internal `model.generate` batch size, not configurable from here): this constant
 * controls only how many PROTECTED SEGMENTS ride in one sequential HTTP call.
 */
export const DEFAULT_MADLAD_HTTP_BATCH_SIZE = 30;

/** A minimal read-only view of the environment, so tests need not mutate the real one. */
export type EnvLike = Record<string, string | undefined>;

export interface TranslationProviderConfig {
  kind: TranslationProviderKind;
  /**
   * Model for the MADLAD engine. Read even when the selected kind is `ollama`, so
   * the benchmark can build both engines from one config.
   */
  madladModel: string;
  /**
   * Optional model override for the Ollama engine.
   *
   * `null` (the default) means: use whatever model the admin-default LLM provider
   * resolves to, exactly as today. When set, it is applied ONLY if that default
   * provider is the self-hosted text worker — overriding the model of a cloud
   * provider that was never asked for would be a silent provider swap, which this
   * pipeline refuses to do anywhere else either.
   */
  ollamaModel: string | null;
  /**
   * Whether a TECHNICAL MADLAD failure (unreachable worker, non-2xx, timeout) may
   * fall back to the Ollama engine. Off unless explicitly enabled, and never
   * consulted for a bad translation — see the fallback note in the factory.
   */
  fallbackToOllamaOnTransportError: boolean;
  /** Max MADLAD segment calls in flight at once. See {@link DEFAULT_MADLAD_CONCURRENCY}. */
  madladConcurrency: number;
  /** Segments per `/translate` HTTP batch. See {@link DEFAULT_MADLAD_HTTP_BATCH_SIZE}. */
  madladHttpBatchSize: number;
}

/** Whether a raw string names a supported engine. */
export function isTranslationProviderKind(value: string): value is TranslationProviderKind {
  return (TRANSLATION_PROVIDER_KINDS as readonly string[]).includes(value);
}

/**
 * Reads the engine selection from the environment.
 *
 * An unrecognised value is a configuration mistake, not a reason to guess: it
 * warns loudly and uses the default, so a typo degrades to today's behaviour
 * rather than to no translation at all.
 */
export function resolveTranslationProviderConfig(env: EnvLike): TranslationProviderConfig {
  const raw = env.TRANSLATION_PROVIDER?.trim().toLowerCase();

  let kind: TranslationProviderKind = DEFAULT_TRANSLATION_PROVIDER;
  if (raw) {
    if (isTranslationProviderKind(raw)) {
      kind = raw;
    } else {
      console.warn(
        `[rss-translation] TRANSLATION_PROVIDER="${raw}" is not one of ` +
          `${TRANSLATION_PROVIDER_KINDS.join(" | ")} — using "${DEFAULT_TRANSLATION_PROVIDER}".`
      );
    }
  }

  const madladModel = env.TRANSLATION_MADLAD_MODEL?.trim() || DEFAULT_MADLAD_MODEL;
  const ollamaModel = env.TRANSLATION_OLLAMA_MODEL?.trim() || null;

  const rawConcurrency = env.TRANSLATION_MADLAD_CONCURRENCY?.trim();
  let madladConcurrency = DEFAULT_MADLAD_CONCURRENCY;
  if (rawConcurrency) {
    const parsed = Number.parseInt(rawConcurrency, 10);
    if (Number.isInteger(parsed) && parsed >= 1) {
      madladConcurrency = parsed;
    } else {
      console.warn(
        `[rss-translation] TRANSLATION_MADLAD_CONCURRENCY="${rawConcurrency}" is not a positive ` +
          `integer — using ${DEFAULT_MADLAD_CONCURRENCY}.`
      );
    }
  }

  const rawHttpBatchSize = env.TRANSLATION_MADLAD_HTTP_BATCH_SIZE?.trim();
  let madladHttpBatchSize = DEFAULT_MADLAD_HTTP_BATCH_SIZE;
  if (rawHttpBatchSize) {
    const parsed = Number.parseInt(rawHttpBatchSize, 10);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= MADLAD_MAX_HTTP_BATCH_SIZE) {
      madladHttpBatchSize = parsed;
    } else {
      console.warn(
        `[rss-translation] TRANSLATION_MADLAD_HTTP_BATCH_SIZE="${rawHttpBatchSize}" is not an ` +
          `integer between 1 and ${MADLAD_MAX_HTTP_BATCH_SIZE} — using ${DEFAULT_MADLAD_HTTP_BATCH_SIZE}.`
      );
    }
  }

  return {
    kind,
    madladModel,
    ollamaModel,
    fallbackToOllamaOnTransportError:
      env.TRANSLATION_MADLAD_FALLBACK?.trim().toLowerCase() === "ollama",
    madladConcurrency,
    madladHttpBatchSize,
  };
}
