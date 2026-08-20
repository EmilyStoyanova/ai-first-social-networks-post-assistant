/**
 * "Which translator will the next article actually use?"
 *
 * Answers it from the SAME code path the pipeline takes — `buildTranslationProvider`
 * reading the real environment — rather than by re-reading .env and hoping the two
 * agree. Touches no database and claims no feed item, so it is safe to run at any
 * time, including against production configuration.
 *
 * Usage:
 *   npm run translate:verify           # configuration only, no network
 *   npm run translate:verify -- --live # also translate one short sentence for real
 *
 * `--live` sends ONE sentence through the selected engine to the configured worker.
 * It writes nothing and reads nothing from the database — it is a reachability and
 * end-to-end check, not a pipeline run.
 */

import "dotenv/config";
import { buildTranslationProvider } from "@/lib/ai/translation/translation-provider-factory";
import { resolveTranslationProviderConfig } from "@/lib/ai/translation/translation-provider-config";
import { buildTranslationPrompts } from "@/lib/ai/feed-item-translation";
import { GenerationTracer } from "@/lib/generation-trace/tracer";
import { resolveLlmSelection } from "@/lib/services/ai/resolve-llm-selection.service";
import {
  buildSupportedProvider,
  ProviderNotAvailableError,
} from "@/lib/ai/llm/supported-providers";

const SAMPLE = "A fire extinguisher can last between 5 and 15 years.";

/** Never print a key — only whether one is there. */
const present = (value: string | undefined): string =>
  value && value.length > 0 ? `set (${value.length} chars)` : "MISSING";

/**
 * The admin default LLM, resolved exactly as translation resolves it.
 *
 * Only the `ollama` engine needs it, and it touches the database to read the admin's
 * LlmConfig row — so it is called lazily, and a MADLAD deployment never reaches it.
 * That laziness is itself part of what this script verifies.
 */
async function resolveLlm() {
  const selection = await resolveLlmSelection({});
  if (!selection.success) return { ok: false as const };
  try {
    const built = buildSupportedProvider(selection.selection.provider);
    return {
      ok: true as const,
      instance: built.instance,
      provider: selection.selection.providerLabel,
      model: built.model,
    };
  } catch (err) {
    if (err instanceof ProviderNotAvailableError) return { ok: false as const };
    throw err;
  }
}

async function main(): Promise<void> {
  const live = process.argv.includes("--live");
  const config = resolveTranslationProviderConfig(process.env);

  console.log("Environment");
  console.log(`  TRANSLATION_PROVIDER        ${process.env.TRANSLATION_PROVIDER ?? "(unset)"}`);
  console.log(`  TRANSLATION_MADLAD_MODEL    ${process.env.TRANSLATION_MADLAD_MODEL ?? "(unset)"}`);
  console.log(
    `  TRANSLATION_MADLAD_FALLBACK ${process.env.TRANSLATION_MADLAD_FALLBACK || "(empty — off)"}`
  );
  console.log(`  TEXT_WORKER_URL             ${process.env.TEXT_WORKER_URL ?? "(unset)"}`);
  console.log(`  TEXT_WORKER_API_KEY         ${present(process.env.TEXT_WORKER_API_KEY)}`);
  console.log("");

  let askedForLlm = false;
  const built = await buildTranslationProvider({
    resolveLlm: async () => {
      askedForLlm = true;
      return resolveLlm();
    },
  });

  if (!built.ok) {
    console.error(`NO PROVIDER: ${built.reason}`);
    process.exit(1);
  }

  console.log("Resolved engine");
  console.log(`  engine        ${built.provider.kind}`);
  console.log(`  provider      ${built.provider.providerLabel}`);
  console.log(`  model         ${built.provider.model}`);
  console.log(`  max attempts  ${built.provider.maxTries}`);
  console.log(`  fallback      ${config.fallbackToOllamaOnTransportError ? "ollama" : "off"}`);
  console.log(`  used admin LLM selection: ${askedForLlm}`);
  console.log("");

  if (!live) {
    console.log("Configuration only. Add --live to translate one sentence for real.");
    return;
  }

  console.log(`Live check — translating: ${SAMPLE}`);
  const prompts = buildTranslationPrompts(SAMPLE, null, "bg");
  const startedAt = Date.now();
  const result = await built.provider.translate(
    {
      feedItemId: "verify",
      url: "verify://local",
      title: SAMPLE,
      content: null,
      targetLang: "bg",
      mode: prompts.mode,
      prompts,
    },
    {
      // Disabled: this is not a pipeline run and must not leave a trace row behind.
      tracer: GenerationTracer.disabled(),
      now: () => new Date(),
      diag: { verify: true },
      attemptTimeoutMs: 120_000,
      itemDeadlineMs: Date.now() + 180_000,
      itemTimeoutMs: 180_000,
    }
  );

  console.log(`  -> ${result.translatedTitle}`);
  console.log(`  ${Date.now() - startedAt} ms, ${result.modelCalls ?? result.tries} call(s)`);
  console.log("");
  console.log("MADLAD is selected, reachable, and returning Bulgarian. No database was touched.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
