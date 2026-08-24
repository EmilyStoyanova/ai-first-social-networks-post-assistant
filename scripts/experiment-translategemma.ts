/**
 * EXPERIMENT — not wired into the production pipeline. Read-only investigation of
 * `translategemma:12b` (google/translategemma-12b-it, q4_K_M, pulled via the LOCAL
 * ollama daemon on this machine — NOT the production TEXT_WORKER_URL) as a possible
 * replacement for MADLAD.
 *
 * Does NOT touch: TRANSLATION_PROVIDER, MadladTranslationProvider, protected-tokens.ts,
 * segment-repair.ts, translated-text-validation.ts, translation-provider-factory.ts.
 * Does NOT write to the database. Safe to delete this file at any time.
 *
 * The MADLAD comparison stage reuses MadladTranslationProvider unmodified, pointed at
 * the real TEXT_WORKER_URL — same as `npm run translate:benchmark` already does. That is
 * a read-only translate call, not a production-state change.
 *
 * Usage:
 *   npx tsx scripts/experiment-translategemma.ts --stage model-info
 *   npx tsx scripts/experiment-translategemma.ts --stage native        # 10 EN->BG sentences, no glossary
 *   npx tsx scripts/experiment-translategemma.ts --stage preserve      # identifier/number preservation stress test
 *   npx tsx scripts/experiment-translategemma.ts --stage fixtures      # 3 existing project fixtures, whole-article
 *   npx tsx scripts/experiment-translategemma.ts --stage chunks        # chunk-size experiment on one fixture
 *   npx tsx scripts/experiment-translategemma.ts --stage madlad        # same fixtures through real MADLAD
 *   npx tsx scripts/experiment-translategemma.ts --stage glossary      # SEPARATE glossary-constrained run
 *   npx tsx scripts/experiment-translategemma.ts --stage all
 */

import "dotenv/config";
import {
  TRANSLATION_FIXTURES,
  findTranslationFixture,
} from "@/lib/ai/translation/translation-fixtures";
import { protectTokens, restoreTokens } from "@/lib/ai/translation/protected-tokens";
import { MadladTranslationProvider } from "@/lib/ai/translation/madlad-translation.provider";
import { buildTranslationPrompts, TranslationParseError } from "@/lib/ai/feed-item-translation";
import { GenerationTracer } from "@/lib/generation-trace/tracer";

const OLLAMA_URL = "http://localhost:11434";
const MODEL = "translategemma:12b";

// ─── Ollama transport (LOCAL daemon only — never TEXT_WORKER_URL) ─────────────────

interface OllamaChatResponse {
  message: { role: string; content: string };
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * translategemma:12b's Modelfile TEMPLATE only iterates `.Messages` (no `{{ .Prompt }}`
 * slot) — it is a chat template, not a completion template. Verified against the real
 * model via `ollama show --modelfile` and a live /api/chat call before writing this.
 * /api/generate would still "work" (Ollama synthesizes a single message from the raw
 * prompt) but /api/chat is what the model's own template was authored for.
 */
async function ollamaGenerate(
  prompt: string
): Promise<{ text: string; ms: number; raw: OllamaChatResponse }> {
  const startedAt = Date.now();
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      options: { temperature: 0.1 },
    }),
  });
  if (!res.ok) {
    throw new Error(`ollama /api/chat ${res.status}: ${await res.text()}`);
  }
  const raw = (await res.json()) as OllamaChatResponse;
  return { text: raw.message.content.trim(), ms: Date.now() - startedAt, raw };
}

/** Translate one chunk of English text to Bulgarian. Prompt format kept intentionally plain and non-glossary. */
async function translateNative(
  text: string
): Promise<{ text: string; ms: number; raw: OllamaChatResponse }> {
  const prompt = `Translate the following English text into Bulgarian. Output only the Bulgarian translation, nothing else.\n\n${text}`;
  return ollamaGenerate(prompt);
}

export const GLOSSARY: Record<string, string> = {
  "fire extinguisher": "пожарогасител",
  brushless: "безчетков",
  sawhorse: "магаре за рязане",
};

async function translateWithGlossary(
  text: string
): Promise<{ text: string; ms: number; raw: OllamaChatResponse }> {
  const glossaryLines = Object.entries(GLOSSARY)
    .map(([en, bg]) => `- "${en}" -> "${bg}"`)
    .join("\n");
  const prompt =
    `Translate the following English text into Bulgarian. Output only the Bulgarian translation, nothing else.\n` +
    `Use this exact terminology whenever the corresponding English term appears (adapt Bulgarian inflection as grammatically required):\n${glossaryLines}\n\n${text}`;
  return ollamaGenerate(prompt);
}

// ─── Output helpers ─────────────────────────────────────────────────────────────

const RULE = "═".repeat(78);
function heading(s: string) {
  console.log("\n" + RULE);
  console.log(s);
  console.log(RULE);
}

// ─── Stage: model-info ────────────────────────────────────────────────────────

async function stageModelInfo(): Promise<void> {
  heading("MODEL INFO");
  const { execSync } = await import("node:child_process");
  console.log(execSync(`ollama list | grep -i translategemma || true`).toString());
  console.log(execSync(`ollama show ${MODEL} --modelfile`).toString());

  console.log("Cold call (measures load_duration)...");
  const cold = await translateNative("Hello, this is a test sentence.");
  console.log(`Response: ${cold.text}`);
  console.log(`Wall time: ${cold.ms} ms`);
  console.log(
    `Ollama-reported: total=${cold.raw.total_duration ? (cold.raw.total_duration / 1e6).toFixed(0) : "?"}ms ` +
      `load=${cold.raw.load_duration ? (cold.raw.load_duration / 1e6).toFixed(0) : "?"}ms`
  );

  console.log("\n`ollama ps` right after inference (RAM/VRAM usage):");
  console.log(execSync(`ollama ps`).toString());
}

// ─── Stage: native terminology sentences ───────────────────────────────────────

export const TERMINOLOGY_SENTENCES = [
  "A fire extinguisher can last between 5 and 15 years.",
  "This brushless motor provides more power and requires less maintenance.",
  "Place the board securely on a sawhorse before cutting it.",
  "This cordless impact driver delivers 1,800 Nm of torque.",
  "The heat pump uses an inverter compressor for improved energy efficiency.",
  "The air conditioner has a cooling capacity of 12,000 BTU.",
  "The unit operates on 230 V and consumes 1.2 kW.",
  "The RTX 5090 graphics card includes 32 GB of GDDR7 memory.",
  "The boiler has a stainless steel tank with a capacity of 100 liters.",
  "Do not exceed the maximum operating pressure of 8 bar.",
];

async function stageNative(): Promise<void> {
  heading("NATIVE TERMINOLOGY TEST (no glossary)");
  for (const [i, sentence] of TERMINOLOGY_SENTENCES.entries()) {
    const result = await translateNative(sentence);
    console.log(`\n[${i + 1}] EN: ${sentence}`);
    console.log(`    BG: ${result.text}`);
    console.log(`    (${result.ms} ms)`);
  }
}

async function stageGlossary(): Promise<void> {
  heading("GLOSSARY-CONSTRAINED TERMINOLOGY TEST (separate from native results)");
  for (const [i, sentence] of TERMINOLOGY_SENTENCES.entries()) {
    const result = await translateWithGlossary(sentence);
    console.log(`\n[${i + 1}] EN: ${sentence}`);
    console.log(`    BG (glossary): ${result.text}`);
    console.log(`    (${result.ms} ms)`);
  }
}

// ─── Stage: preservation stress test ───────────────────────────────────────────

export const PRESERVATION_TEXT = `Contact support at service@example.com or visit https://example.com/manuals/rtx-5090 for details.
The RTX 5090 graphics card includes 32 GB of GDDR7 memory and costs 1,899.99 USD (a 12% increase over the RTX 4090).
Model DCD-800 P2, SKU TX-2/B, firmware v2.14.3. Dimensions: 210 x 145 x 60 mm, weight 1.6 kg.
The unit operates on 230 V, consumes 1.2 kW, and must not exceed a maximum pressure of 8 bar.
The boiler tank capacity is 100 liters and the heat pump COP is 4.2.`;

async function stagePreserve(): Promise<void> {
  heading("PRESERVATION STRESS TEST (URLs, email, SKUs, model numbers, units, %, currency)");
  console.log("SOURCE:\n" + PRESERVATION_TEXT + "\n");
  const result = await translateNative(PRESERVATION_TEXT);
  console.log("TRANSLATED:\n" + result.text + "\n");

  const mustSurvive = [
    "service@example.com",
    "https://example.com/manuals/rtx-5090",
    "RTX 5090",
    "GDDR7",
    "32 GB",
    "DCD-800 P2",
    "TX-2/B",
    "v2.14.3",
    "230 V",
    "1.2 kW",
    "8 bar",
    "100",
    "4.2",
  ];
  console.log("PRESERVATION CHECK (substring presence in output — report every miss):");
  for (const token of mustSurvive) {
    const present = result.text.includes(token);
    console.log(`  ${present ? "OK  " : "MISS"}  "${token}"`);
  }

  console.log(
    "\n--- Same source, run through the PRODUCTION protectTokens/restoreTokens scheme ---"
  );
  console.log(
    "(the exact [[n]] placeholder mechanism MADLAD uses — tests whether it would also work for translategemma)"
  );
  const protectedText = protectTokens(PRESERVATION_TEXT);
  console.log(
    `Protected ${protectedText.values.length} value(s): ${protectedText.values.map((v) => v.value).join(", ")}`
  );
  console.log("SENT TO MODEL:\n" + protectedText.text);
  const protectedResult = await translateNative(protectedText.text);
  console.log("\nMODEL OUTPUT:\n" + protectedResult.text);
  try {
    const restored = restoreTokens(protectedResult.text, protectedText.values, "experiment");
    console.log("\nRESTORED (placeholder round-trip SUCCEEDED):\n" + restored);
  } catch (err) {
    console.log(
      "\nRESTORE FAILED — placeholder scheme did not survive translategemma:\n" +
        (err instanceof Error ? err.message : String(err))
    );
  }
}

// ─── Stage: existing project fixtures, whole-article ───────────────────────────

async function stageFixtures(): Promise<void> {
  heading("EXISTING PROJECT FIXTURES — whole article, one request each");
  for (const fixture of TRANSLATION_FIXTURES) {
    console.log(
      `\n${"─".repeat(78)}\nFIXTURE: ${fixture.name}  (traps: ${fixture.traps})\n${"─".repeat(78)}`
    );
    const full = `${fixture.title}\n\n${fixture.content}`;
    const result = await translateNative(full);
    console.log("SOURCE:\n" + full);
    console.log("\nTRANSLATED:\n" + result.text);
    console.log(`\n(${result.ms} ms, 1 request)`);
  }
}

// ─── Stage: chunk-size experiment ──────────────────────────────────────────────

async function stageChunks(): Promise<void> {
  heading("CHUNK-SIZE EXPERIMENT (power-tools fixture)");
  const fixture = findTranslationFixture("power-tools");
  if (!fixture) throw new Error("fixture not found");
  const full = `${fixture.title}\n\n${fixture.content}`;
  console.log(`Source size: ${full.length} chars\n`);

  // (a) whole article, one request
  {
    const startedAt = Date.now();
    const result = await translateNative(full);
    console.log(`--- (a) WHOLE ARTICLE — 1 request ---`);
    console.log(result.text);
    console.log(`(${Date.now() - startedAt} ms total, 1 request)\n`);
  }

  // (b) paragraph-by-paragraph
  {
    const paragraphs = full.split(/\n\n+/).filter((p) => p.trim().length > 0);
    const startedAt = Date.now();
    const outputs: string[] = [];
    for (const p of paragraphs) {
      outputs.push((await translateNative(p)).text);
    }
    console.log(`--- (b) PARAGRAPH-BY-PARAGRAPH — ${paragraphs.length} requests ---`);
    console.log(outputs.join("\n\n"));
    console.log(`(${Date.now() - startedAt} ms total, ${paragraphs.length} requests)\n`);
  }

  // (c) sentence-by-sentence (naive split, good enough for this experiment)
  {
    const sentences = full
      .split(/\n\n+/)
      .flatMap((p) => p.split(/(?<=[.!?])\s+/))
      .filter((s) => s.trim().length > 0);
    const startedAt = Date.now();
    const outputs: string[] = [];
    for (const s of sentences) {
      outputs.push((await translateNative(s)).text);
    }
    console.log(`--- (c) SENTENCE-BY-SENTENCE — ${sentences.length} requests ---`);
    console.log(outputs.join(" "));
    console.log(`(${Date.now() - startedAt} ms total, ${sentences.length} requests)\n`);
  }
}

// ─── Stage: MADLAD comparison (real worker, read-only translate call) ─────────

async function stageMadlad(): Promise<void> {
  heading("MADLAD COMPARISON (real TEXT_WORKER_URL, read-only translate call, no DB writes)");
  const url = process.env.TEXT_WORKER_URL;
  const apiKey = process.env.TEXT_WORKER_API_KEY;
  if (!url || !apiKey) {
    console.error("TEXT_WORKER_URL / TEXT_WORKER_API_KEY not set — skipping MADLAD comparison.");
    return;
  }
  const provider = new MadladTranslationProvider(url, apiKey, "google/madlad400-3b-mt");
  const tracer = GenerationTracer.disabled();

  for (const fixture of TRANSLATION_FIXTURES) {
    console.log(`\n${"─".repeat(78)}\nFIXTURE: ${fixture.name}\n${"─".repeat(78)}`);
    const prompts = buildTranslationPrompts(fixture.title, fixture.content, "bg");
    const startedAt = Date.now();
    try {
      const result = await provider.translate(
        {
          feedItemId: "experiment-translategemma",
          url: "experiment://local",
          title: fixture.title,
          content: fixture.content,
          targetLang: "bg",
          mode: prompts.mode,
          prompts,
        },
        {
          tracer,
          now: () => new Date(),
          diag: { experiment: "translategemma-comparison" },
          attemptTimeoutMs: 120_000,
          itemDeadlineMs: Date.now() + 900_000,
          itemTimeoutMs: 900_000,
          reportTry: () => {},
        }
      );
      console.log(`TITLE: ${result.translatedTitle}`);
      console.log(`CONTENT:\n${result.translatedContent}`);
      console.log(
        `(${Date.now() - startedAt} ms, ${result.modelCalls ?? result.tries} model calls)`
      );
    } catch (err) {
      const msg =
        err instanceof TranslationParseError
          ? `REJECTED (${err.reason}): ${err.message}`
          : String(err);
      console.log(`ERROR: ${msg} (${Date.now() - startedAt} ms)`);
    }
  }
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flagIdx = argv.indexOf("--stage");
  const stage = flagIdx >= 0 ? argv[flagIdx + 1] : "all";

  const stages: Record<string, () => Promise<void>> = {
    "model-info": stageModelInfo,
    native: stageNative,
    preserve: stagePreserve,
    fixtures: stageFixtures,
    chunks: stageChunks,
    madlad: stageMadlad,
    glossary: stageGlossary,
  };

  if (stage === "all") {
    for (const fn of Object.values(stages)) await fn();
    return;
  }

  const fn = stages[stage];
  if (!fn) {
    console.error(`Unknown stage "${stage}". Available: ${Object.keys(stages).join(", ")}, all`);
    process.exit(1);
  }
  await fn();
}

// Guarded so other scripts can `import { TERMINOLOGY_SENTENCES, ... } from "./experiment-translategemma"`
// (e.g. to feed the same fixtures to a different model) without re-running this whole experiment
// as a side effect of the import.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
