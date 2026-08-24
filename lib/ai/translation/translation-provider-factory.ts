import type { ILlmProvider } from "@/lib/ai/types";
import { LLM_PROVIDER_LABEL } from "@/lib/ai/llm/llm-provider-factory";
import { TextWorkerProvider } from "@/lib/ai/llm/text-worker.provider";
import type { TranslationProvider } from "./translation-provider";
import { OllamaTranslationProvider } from "./ollama-translation.provider";
import { MadladTranslationProvider, MADLAD_SOURCE_LANGUAGE } from "./madlad-translation.provider";
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
 *
 * ── On TRANSLATION_OLLAMA_MODEL ──────────────────────────────────────────────
 * When set, it is a deployment's explicit choice of translation model, and
 * deterministically selects the self-hosted text worker for that model — it never
 * depends on which provider happens to be the admin's general-purpose default for
 * post generation (see the `ollama` branch below). Unset, translation runs through
 * that admin default exactly as it always has. MADLAD's OWN use of "ollama" — as its
 * transport-fallback and per-segment repair engine, see `buildOllamaTranslationProvider`
 * — keeps the admin-default coupling deliberately, since that pairing (repair engine
 * ⇄ `TRANSLATION_MADLAD_FALLBACK=ollama`) is a separate, already-documented decision.
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
function applyOllamaModelOverride(
  resolved: ResolvedLlm,
  override: string | null,
  env: EnvLike
): ResolvedLlm {
  if (!override || override === resolved.model) return resolved;

  if (resolved.provider !== LLM_PROVIDER_LABEL.text_worker) {
    console.warn(
      `[rss-translation] TRANSLATION_OLLAMA_MODEL="${override}" ignored — the default ` +
        `provider is ${resolved.provider}, not the text worker. Translation uses ` +
        `${resolved.model}.`
    );
    return resolved;
  }

  const url = env.TEXT_WORKER_URL;
  const apiKey = env.TEXT_WORKER_API_KEY;
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
      provider: new MadladTranslationProvider(
        url,
        apiKey,
        config.madladModel,
        MADLAD_SOURCE_LANGUAGE,
        config.madladConcurrency,
        config.madladHttpBatchSize,
        // Repairs the individual segments MADLAD cannot carry — see segment-repair.ts.
        // LAZY on purpose: this closure is invoked at most once per article, and only
        // after a segment has actually failed restoration, so an article with no
        // brand-adjacent identifier never resolves an LLM at all and "MADLAD does not
        // touch the LLM selection" stays true for every article but those.
        //
        // NOTE the coupling, stated rather than hidden: the repair engine is the ADMIN
        // DEFAULT LLM, the same one `TRANSLATION_MADLAD_FALLBACK=ollama` already uses.
        // Changing that default changes which model repairs a segment, which is why
        // the engine and model that answered are recorded on the trace, in the log
        // line and in `raw` rather than assumed — and why every repaired segment is
        // verified byte-for-byte regardless of which model produced it.
        () => buildOllamaTranslationProvider({ resolveLlm: options.resolveLlm, env })
      ),
      config,
    };
  }

  // kind === "ollama". An explicit TRANSLATION_OLLAMA_MODEL is a deployment's deliberate
  // choice of translation model, and must select the self-hosted text worker
  // DETERMINISTICALLY — never depending on which provider happens to be the admin's
  // general-purpose default for post generation, a setting this pipeline does not
  // otherwise consult when a translation model has been named explicitly. Built directly
  // rather than through `resolveLlm`/`applyOllamaModelOverride`, which stay exactly as
  // they were for the UNSET case below and for MADLAD's own fallback/repair use of this
  // engine (see `buildOllamaTranslationProvider`), where that coupling to the admin
  // default is deliberate and documented, not accidental.
  if (config.ollamaModel) {
    const url = env.TEXT_WORKER_URL;
    const apiKey = env.TEXT_WORKER_API_KEY;
    if (!url || !apiKey) {
      return {
        ok: false,
        reason: "TRANSLATION_OLLAMA_MODEL requires TEXT_WORKER_URL and TEXT_WORKER_API_KEY.",
        config,
      };
    }
    return {
      ok: true,
      provider: new OllamaTranslationProvider(
        new TextWorkerProvider(url, apiKey, config.ollamaModel),
        LLM_PROVIDER_LABEL.text_worker,
        config.ollamaModel
      ),
      config,
    };
  }

  // No explicit translation model — the ORIGINAL behaviour, unchanged: translate through
  // whichever provider the admin has set as the general-purpose default.
  const resolved = await options.resolveLlm();
  if (!resolved.ok) return { ok: false, reason: "No default LLM provider is configured.", config };

  return {
    ok: true,
    provider: new OllamaTranslationProvider(resolved.instance, resolved.provider, resolved.model),
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
  const withModel = applyOllamaModelOverride(resolved, config.ollamaModel, env);
  return new OllamaTranslationProvider(withModel.instance, withModel.provider, withModel.model);
}
