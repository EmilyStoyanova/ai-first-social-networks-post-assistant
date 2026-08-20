import type { ILlmProvider } from "@/lib/ai/types";
import { LLM_PROVIDER_LABEL } from "@/lib/ai/llm/llm-provider-factory";
import { TextWorkerProvider } from "@/lib/ai/llm/text-worker.provider";
import type { TranslationProvider } from "./translation-provider";
import { OllamaTranslationProvider } from "./ollama-translation.provider";
import { MadladTranslationProvider } from "./madlad-translation.provider";
import {
  resolveTranslationProviderConfig,
  type EnvLike,
  type TranslationProviderConfig,
} from "./translation-provider-config";

/**
 * Builds the translation engine this deployment is configured for.
 *
 * One decision point, taken once per article. Nothing downstream asks "is this
 * MADLAD?" — which is the whole point of the abstraction, and the reason the
 * previous behaviour survives untouched: with no `TRANSLATION_PROVIDER` set, the
 * only path anything takes is the one that existed before.
 *
 * ── On fallback ───────────────────────────────────────────────────────────────
 * There is deliberately NO automatic fallback from MADLAD to Ollama. A poor
 * translation is not an error condition — it is the answer, and silently swapping
 * engines behind it would make the two indistinguishable in the data, which is
 * exactly the question this integration exists to answer. Only a TECHNICAL failure
 * (worker unreachable, non-2xx, malformed envelope, timeout) can be a fallback, it
 * is off unless `TRANSLATION_MADLAD_FALLBACK=ollama` is set, and when it fires it
 * is logged at warn level naming both engines. See `translateFeedItem`.
 */

/** What `resolveProvider` hands back — the admin-default LLM, already built. */
export interface ResolvedLlm {
  instance: ILlmProvider;
  /** Uppercase provenance label, e.g. "TEXT_WORKER" / "GROQ". */
  provider: string;
  model: string;
}

export type ResolveLlmFn = () => Promise<({ ok: true } & ResolvedLlm) | { ok: false }>;

export interface BuildTranslationProviderOptions {
  /** Resolves the LLM behind the `ollama` engine. Always the admin default. */
  resolveLlm: ResolveLlmFn;
  /** Defaults to `process.env`. Injected in tests. */
  env?: EnvLike;
}

export type BuildTranslationProviderResult =
  | { ok: true; provider: TranslationProvider; config: TranslationProviderConfig }
  /** No engine could be built — the caller reports `no_provider` and burns no attempt. */
  | { ok: false; reason: string; config: TranslationProviderConfig };

/**
 * Applies `TRANSLATION_OLLAMA_MODEL`, but only where it cannot become a silent
 * provider swap.
 *
 * Overriding the model of the self-hosted text worker is a local choice about which
 * Ollama tag to pull. Overriding the model of a cloud provider the admin selected is
 * not the same thing at all, so a set variable is IGNORED (with a warning) whenever
 * the resolved default is anything but the text worker.
 */
function applyOllamaModelOverride(resolved: ResolvedLlm, override: string | null): ResolvedLlm {
  if (!override || override === resolved.model) return resolved;

  if (resolved.provider !== LLM_PROVIDER_LABEL.text_worker) {
    console.warn(
      `[rss-translation] TRANSLATION_OLLAMA_MODEL="${override}" ignored — the default ` +
        `provider is ${resolved.provider}, not the text worker. Translation uses ` +
        `${resolved.model}.`
    );
    return resolved;
  }

  const url = process.env.TEXT_WORKER_URL;
  const apiKey = process.env.TEXT_WORKER_API_KEY;
  if (!url || !apiKey) return resolved;

  return {
    instance: new TextWorkerProvider(url, apiKey, override),
    provider: resolved.provider,
    model: override,
  };
}

export async function buildTranslationProvider(
  options: BuildTranslationProviderOptions
): Promise<BuildTranslationProviderResult> {
  const env = options.env ?? process.env;
  const config = resolveTranslationProviderConfig(env);

  if (config.kind === "madlad") {
    const url = env.TEXT_WORKER_URL;
    const apiKey = env.TEXT_WORKER_API_KEY;
    if (!url || !apiKey) {
      // MADLAD is served by the text worker, so it needs the worker's own address and
      // key. Missing config is an operator problem: report it rather than quietly
      // translating with a different engine than the one that was selected.
      return {
        ok: false,
        reason: "TRANSLATION_PROVIDER=madlad requires TEXT_WORKER_URL and TEXT_WORKER_API_KEY.",
        config,
      };
    }
    return {
      ok: true,
      provider: new MadladTranslationProvider(url, apiKey, config.madladModel),
      config,
    };
  }

  const resolved = await options.resolveLlm();
  if (!resolved.ok) return { ok: false, reason: "No default LLM provider is configured.", config };

  const withModel = applyOllamaModelOverride(resolved, config.ollamaModel);
  return {
    ok: true,
    provider: new OllamaTranslationProvider(
      withModel.instance,
      withModel.provider,
      withModel.model
    ),
    config,
  };
}

/**
 * Builds the Ollama engine on its own — used by the fallback path and the benchmark,
 * both of which need it regardless of what `TRANSLATION_PROVIDER` says.
 */
export async function buildOllamaTranslationProvider(
  options: BuildTranslationProviderOptions
): Promise<TranslationProvider | null> {
  const env = options.env ?? process.env;
  const config = resolveTranslationProviderConfig(env);
  const resolved = await options.resolveLlm();
  if (!resolved.ok) return null;
  const withModel = applyOllamaModelOverride(resolved, config.ollamaModel);
  return new OllamaTranslationProvider(withModel.instance, withModel.provider, withModel.model);
}
