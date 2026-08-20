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

  return {
    kind,
    madladModel,
    ollamaModel,
    fallbackToOllamaOnTransportError:
      env.TRANSLATION_MADLAD_FALLBACK?.trim().toLowerCase() === "ollama",
  };
}
