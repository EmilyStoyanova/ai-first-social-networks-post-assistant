/**
 * Side-by-side comparison of the two translation engines.
 *
 * Usage:
 *   npm run translate:benchmark                          # the known-problem ARTICLES
 *   npm run translate:benchmark -- --file article.txt    # a real article, first line = title
 *   npm run translate:benchmark -- --sentences           # the short problem sentences
 *   npm run translate:benchmark -- --fixture sawhorse    # one built-in article
 *   npm run translate:benchmark -- --only madlad         # one engine on its own
 *   npm run translate:benchmark -- --lang bg             # target language (default: bg)
 *
 * Reads only the environment — no database, no admin LlmConfig row, no running app.
 * Both engines are built straight from TEXT_WORKER_URL/KEY, so this runs on (or beside)
 * the Mac against the worker itself.
 *
 * It deliberately does NOT score the engines. Which translation is better is a
 * judgement about Bulgarian, and the point of this script is to put the two texts in
 * front of a person who can make it. All it reports beside the text is what it cost:
 * wall-clock time, HTTP calls to the model, and whether the output was rejected by the
 * pipeline's own quality gate.
 *
 * Whole ARTICLES are the default, not sentences, because that is what the pipeline
 * actually translates: a sentence benchmark cannot show paragraph drift, a lost
 * bulleted list, or the retry a 3000-character body provokes from a chat model.
 */

import "dotenv/config";
import { TextWorkerProvider } from "@/lib/ai/llm/text-worker.provider";
import { buildTranslationPrompts, TranslationParseError } from "@/lib/ai/feed-item-translation";
import { GenerationTracer } from "@/lib/generation-trace/tracer";
import { OllamaTranslationProvider } from "@/lib/ai/translation/ollama-translation.provider";
import { MadladTranslationProvider } from "@/lib/ai/translation/madlad-translation.provider";
import { resolveTranslationProviderConfig } from "@/lib/ai/translation/translation-provider-config";
import {
  findTranslationFixture,
  TRANSLATION_FIXTURES,
  type TranslationFixture,
} from "@/lib/ai/translation/translation-fixtures";
import type {
  ArticleTranslation,
  TranslationProvider,
} from "@/lib/ai/translation/translation-provider";

/**
 * The sentences this integration started from: short, technical, product-catalogue and
 * safety copy, where the prompt-based path has been observed to drift, pad, or answer
 * about the wrong subject. Kept behind `--sentences` — useful for a quick smoke test,
 * but not a substitute for a whole article.
 */
const SENTENCES = [
  "How long do fire extinguishers last?",
  "A fire extinguisher can last between 5 and 15 years.",
  "Check the pressure gauge.",
  "Rust can damage the fire extinguisher.",
  "Brushless cordless drill driver.",
  "The batteries should be fully charged.",
  "A sawhorse provides support while cutting wood.",
  "Act quickly in an emergency situation.",
];

interface Args {
  lang: string;
  only: "ollama" | "madlad" | null;
  file: string | null;
  fixture: string | null;
  sentences: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { lang: "bg", only: null, file: null, fixture: null, sentences: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--lang" && value) args.lang = value;
    if (flag === "--file" && value) args.file = value;
    if (flag === "--fixture" && value) args.fixture = value;
    if (flag === "--sentences") args.sentences = true;
    if (flag === "--only" && (value === "ollama" || value === "madlad")) args.only = value;
  }
  return args;
}

interface Attempt {
  engine: string;
  model: string;
  title: string | null;
  content: string | null;
  error: string | null;
  ms: number;
  /** HTTP calls to the model. One per attempt for Ollama, one per SEGMENT for MADLAD. */
  calls: number;
}

async function runOne(
  provider: TranslationProvider,
  title: string,
  content: string | null,
  targetLang: string
): Promise<Attempt> {
  const prompts = buildTranslationPrompts(title, content, targetLang);
  const startedAt = Date.now();
  // A disabled tracer: the benchmark is not a pipeline run and must not write trace
  // rows, but the engines record their steps unconditionally.
  const tracer = GenerationTracer.disabled();

  let calls = 0;
  try {
    const result: ArticleTranslation = await provider.translate(
      {
        feedItemId: "benchmark",
        url: "benchmark://local",
        title,
        content,
        targetLang,
        mode: prompts.mode,
        prompts,
      },
      {
        tracer,
        now: () => new Date(),
        diag: { benchmark: true },
        attemptTimeoutMs: 120_000,
        itemDeadlineMs: Date.now() + 900_000,
        itemTimeoutMs: 900_000,
        reportTry: (n) => {
          calls = n;
        },
      }
    );
    return {
      engine: provider.kind.toUpperCase(),
      model: provider.model,
      title: result.translatedTitle,
      content: result.translatedContent,
      error: null,
      ms: Date.now() - startedAt,
      calls: result.modelCalls ?? result.tries,
    };
  } catch (err) {
    return {
      engine: provider.kind.toUpperCase(),
      model: provider.model,
      title: null,
      content: null,
      // A TranslationParseError is the quality gate rejecting the output — exactly what
      // the pipeline would have done. Reported as such rather than as a crash.
      error:
        err instanceof TranslationParseError
          ? `REJECTED (${err.reason}): ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err),
      ms: Date.now() - startedAt,
      calls,
    };
  }
}

function buildProviders(only: Args["only"]): TranslationProvider[] {
  const config = resolveTranslationProviderConfig(process.env);
  const url = process.env.TEXT_WORKER_URL;
  const apiKey = process.env.TEXT_WORKER_API_KEY;

  if (!url || !apiKey) {
    console.error("TEXT_WORKER_URL and TEXT_WORKER_API_KEY must be set — both engines need them.");
    process.exit(1);
  }

  const providers: TranslationProvider[] = [];
  if (only !== "madlad") {
    const model = config.ollamaModel ?? process.env.TEXT_WORKER_MODEL ?? "qwen3:8b";
    providers.push(
      new OllamaTranslationProvider(
        new TextWorkerProvider(url, apiKey, model),
        "TEXT_WORKER",
        model
      )
    );
  }
  if (only !== "ollama") {
    providers.push(new MadladTranslationProvider(url, apiKey, config.madladModel));
  }
  return providers;
}

// ─── Output ───────────────────────────────────────────────────────────────────

const RULE = "═".repeat(78);
const THIN = "─".repeat(78);

function block(label: string, body: string | null): void {
  console.log(`${label}:`);
  console.log(body && body.trim().length > 0 ? body : "(none)");
  console.log("");
}

function printAttempt(attempt: Attempt): void {
  console.log(`=== ${attempt.engine} ===`);
  console.log(`MODEL:`);
  console.log(attempt.model);
  console.log("");
  if (attempt.error) {
    block("ERROR", attempt.error);
  } else {
    block("TITLE", attempt.title);
    block("CONTENT", attempt.content);
  }
  console.log("TIME:");
  console.log(`${(attempt.ms / 1000).toFixed(1)} s (${attempt.ms} ms)`);
  console.log("");
  console.log("CALLS:");
  console.log(String(attempt.calls));
  console.log("");
}

// ─── Cases ────────────────────────────────────────────────────────────────────

interface Case {
  label: string;
  title: string;
  content: string | null;
}

const fromFixture = (f: TranslationFixture): Case => ({
  label: `fixture:${f.name} — ${f.traps}`,
  title: f.title,
  content: f.content,
});

async function buildCases(args: Args): Promise<Case[]> {
  if (args.file) {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(args.file, "utf8");
    // First line is the title, the rest is the body — the same shape a feed item has.
    const [first, ...rest] = raw.split(/\r?\n/);
    const body = rest.join("\n").trim();
    return [{ label: args.file, title: first.trim(), content: body === "" ? null : body }];
  }

  if (args.fixture) {
    const found = findTranslationFixture(args.fixture);
    if (!found) {
      console.error(
        `Unknown fixture "${args.fixture}". Available: ` +
          TRANSLATION_FIXTURES.map((f) => f.name).join(", ")
      );
      process.exit(1);
    }
    return [fromFixture(found)];
  }

  if (args.sentences) {
    return SENTENCES.map((sentence) => ({
      label: "sentence",
      title: sentence,
      content: null,
    }));
  }

  return TRANSLATION_FIXTURES.map(fromFixture);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const providers = buildProviders(args.only);
  const cases = await buildCases(args);

  console.log(`Target language: ${args.lang}`);
  console.log(`Engines:         ${providers.map((p) => `${p.kind}/${p.model}`).join("   ")}`);
  console.log(`Cases:           ${cases.length}`);
  console.log("");

  for (const [index, testCase] of cases.entries()) {
    console.log(RULE);
    console.log(`CASE ${index + 1}/${cases.length}  ${testCase.label}`);
    console.log(RULE);
    console.log("");
    block("SOURCE TITLE", testCase.title);
    block("SOURCE CONTENT", testCase.content);
    console.log(THIN);
    console.log("");

    // Sequential on purpose: both engines share one Mac, and running them at once
    // would have each measuring the other's memory pressure rather than its own speed.
    for (const provider of providers) {
      printAttempt(await runOne(provider, testCase.title, testCase.content, args.lang));
    }
  }

  console.log(RULE);
  console.log("No automatic verdict is offered — read the translations.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
