/**
 * EXPERIMENT — not wired into the production pipeline. Runs the ~20-sample evaluation
 * corpus (scripts/experiment-eval-corpus.ts) through three modes:
 *
 *   A. madlad          — real MadladTranslationProvider, unmodified, against the real
 *                         TEXT_WORKER_URL (read-only translate calls, no DB writes).
 *   B. gemma-native     — translategemma:12b via LOCAL Ollama, no glossary.
 *   C. gemma-glossary   — same model, with only the glossary terms detected in each
 *                         chunk supplied in the prompt (never the full 30-50 term list).
 *
 * Context strategy for TranslateGemma (madlad uses its own real segmentation, untouched):
 * samples under ~1000 chars are sent whole (title+content, matching what the prior
 * experiment found worked best). Longer samples are split into paragraphs; every chunk
 * after the first carries a "this paragraph continues an article titled X" context line
 * instead of ever translating the title in isolation (the prior experiment's
 * "Безчетковина" failure came from exactly that).
 *
 * Writes one JSON file with everything: raw outputs, per-chunk detail, automated
 * preservation/completeness signals (a triage aid — NOT a substitute for manual
 * reading, which is done separately). No DB writes, no production file changes.
 *
 * Usage: npx tsx scripts/experiment-eval-runner.ts <output.json> [--only madlad|gemma-native|gemma-glossary] [--samples id1,id2,...]
 */

import "dotenv/config";
import { writeFileSync } from "node:fs";
import { EVAL_SAMPLES, GLOSSARY_TERMS, type EvalSample } from "./experiment-eval-corpus";
import { protectTokens } from "@/lib/ai/translation/protected-tokens";
import { MadladTranslationProvider } from "@/lib/ai/translation/madlad-translation.provider";
import { buildTranslationPrompts, TranslationParseError } from "@/lib/ai/feed-item-translation";
import { GenerationTracer } from "@/lib/generation-trace/tracer";

const OLLAMA_URL = "http://localhost:11434";
const MODEL = "translategemma:12b";
const WHOLE_THRESHOLD = 1000;

// ─── Ollama transport (local only) ─────────────────────────────────────────────

async function ollamaChat(prompt: string): Promise<{ text: string; ms: number }> {
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
  if (!res.ok) throw new Error(`ollama /api/chat ${res.status}: ${await res.text()}`);
  const raw = (await res.json()) as { message: { content: string } };
  return { text: raw.message.content.trim(), ms: Date.now() - startedAt };
}

// ─── Glossary detection (only matched terms go in the prompt) ─────────────────

function detectGlossaryTerms(text: string): { en: string; bg: string }[] {
  const lower = text.toLowerCase();
  const matched: { en: string; bg: string }[] = [];
  for (const entry of GLOSSARY_TERMS) {
    if (lower.includes(entry.en.toLowerCase())) matched.push(entry);
  }
  // Longer terms first so "brushless motor" isn't shadowed by "brushless" for prompt clarity.
  return matched.sort((a, b) => b.en.length - a.en.length);
}

function buildPrompt(text: string, glossary: { en: string; bg: string }[] | null): string {
  if (!glossary || glossary.length === 0) {
    return `Translate the following English text into Bulgarian. Output only the Bulgarian translation, nothing else.\n\n${text}`;
  }
  const lines = glossary.map((g) => `- "${g.en}" -> "${g.bg}"`).join("\n");
  return (
    `Translate the following English text into Bulgarian. Output only the Bulgarian translation, nothing else.\n` +
    `Use this exact terminology whenever the corresponding English term appears (adapt Bulgarian inflection as grammatically required):\n${lines}\n\n${text}`
  );
}

function contextualPrompt(
  title: string,
  paragraph: string,
  glossary: { en: string; bg: string }[] | null
): string {
  const glossaryLine =
    glossary && glossary.length > 0
      ? `Use this exact terminology whenever the corresponding English term appears (adapt Bulgarian inflection as grammatically required):\n${glossary.map((g) => `- "${g.en}" -> "${g.bg}"`).join("\n")}\n`
      : "";
  return (
    `This paragraph continues an article titled "${title}". Translate ONLY the following paragraph into Bulgarian ` +
    `(do not translate or repeat the title). Output only the Bulgarian translation of the paragraph, nothing else.\n` +
    glossaryLine +
    `\nParagraph:\n${paragraph}`
  );
}

// ─── Chunk building ─────────────────────────────────────────────────────────────

interface Chunk {
  label: string;
  sourceText: string;
  glossaryApplied: { en: string; bg: string }[];
}

function buildChunks(sample: EvalSample, useGlossary: boolean): Chunk[] {
  const full = `${sample.title}\n\n${sample.content}`;
  const mkGlossary = (t: string) => (useGlossary ? detectGlossaryTerms(t) : []);

  if (full.length <= WHOLE_THRESHOLD) {
    return [{ label: "whole", sourceText: full, glossaryApplied: mkGlossary(full) }];
  }

  const paragraphs = sample.content.split(/\n\n+/).filter((p) => p.trim().length > 0);
  const chunks: Chunk[] = [];
  const first = `${sample.title}\n\n${paragraphs[0]}`;
  chunks.push({ label: "title+p1", sourceText: first, glossaryApplied: mkGlossary(first) });
  for (const p of paragraphs.slice(1)) {
    chunks.push({ label: "paragraph", sourceText: p, glossaryApplied: mkGlossary(p) });
  }
  return chunks;
}

// ─── Preservation / completeness signals (automated triage only) ──────────────

const NAMED_TECH = [
  "RTX 5090",
  "GDDR7",
  "Wi-Fi 7",
  "PCIe 5.0",
  "USB4",
  "USB-C",
  "HDMI 2.1",
  "DisplayPort 1.4",
];

const NUMERIC_UNIT =
  /\d+(?:[.,]\d+)?\s?(?:kW|W|V|A|Ah|Hz|GB|TB|Nm|BTU|bar|mm|kg|°C|MPa|dB|m²|m\/s|mAh|BGN|USD|%)/g;

function checkPreservation(sourceFull: string, outputFull: string) {
  const protectedValues = protectTokens(sourceFull).values;
  const identifierChecks = protectedValues.map((v) => ({
    value: v.value,
    kind: v.kind,
    survivedExact: outputFull.includes(v.value),
  }));

  const namedTechChecks = NAMED_TECH.filter((t) => sourceFull.includes(t)).map((t) => ({
    term: t,
    survivedExact: outputFull.includes(t),
  }));

  const numericMatches = [...sourceFull.matchAll(NUMERIC_UNIT)].map((m) => m[0]);
  const numberChecks = numericMatches.map((m) => {
    const commaVariant = m.replace(".", ",");
    const numberOnly = m.match(/\d+(?:[.,]\d+)?/)?.[0] ?? m;
    const numberCommaVariant = numberOnly.replace(".", ",");
    return {
      source: m,
      survivedExactOrLocalized: outputFull.includes(m) || outputFull.includes(commaVariant),
      numberSurvivedAtAll:
        outputFull.includes(numberOnly) || outputFull.includes(numberCommaVariant),
    };
  });

  return { identifierChecks, namedTechChecks, numberChecks };
}

function checkCompleteness(sourceContent: string, outputFull: string) {
  const sourceParagraphs = sourceContent.split(/\n\n+/).filter((p) => p.trim().length > 0).length;
  const sourceListItems = (sourceContent.match(/^[-\d]+[.)]?\s/gm) || []).length;
  const sourceSentencesApprox = (sourceContent.match(/[.!?]+(?:\s|$)/g) || []).length;
  const outputSentencesApprox = (outputFull.match(/[.!?]+(?:\s|$)/g) || []).length;
  return {
    sourceParagraphs,
    sourceListItems,
    sourceSentencesApprox,
    outputSentencesApprox,
    outputCharLength: outputFull.length,
    sourceCharLength: sourceContent.length,
    lengthRatio: sourceContent.length > 0 ? outputFull.length / sourceContent.length : null,
  };
}

// ─── Mode runners ───────────────────────────────────────────────────────────────

interface ChunkResult extends Chunk {
  translated: string;
  ms: number;
}

interface SampleResult {
  sampleId: string;
  domain: string;
  origin: string;
  mode: string;
  chunkCount: number;
  totalMs: number;
  translatedFull: string;
  chunks: ChunkResult[];
  preservation: ReturnType<typeof checkPreservation>;
  completeness: ReturnType<typeof checkCompleteness>;
  error: string | null;
}

async function runGemma(
  sample: EvalSample,
  useGlossary: boolean,
  mode: string
): Promise<SampleResult> {
  const chunks = buildChunks(sample, useGlossary);
  const chunkResults: ChunkResult[] = [];
  const t0 = Date.now();
  for (const [i, chunk] of chunks.entries()) {
    const prompt =
      chunks.length === 1
        ? buildPrompt(chunk.sourceText, useGlossary ? chunk.glossaryApplied : null)
        : i === 0
          ? buildPrompt(chunk.sourceText, useGlossary ? chunk.glossaryApplied : null)
          : contextualPrompt(
              sample.title,
              chunk.sourceText,
              useGlossary ? chunk.glossaryApplied : null
            );
    const { text, ms } = await ollamaChat(prompt);
    chunkResults.push({ ...chunk, translated: text, ms });
  }
  const totalMs = Date.now() - t0;
  const translatedFull = chunkResults.map((c) => c.translated).join("\n\n");
  const sourceFull = `${sample.title}\n\n${sample.content}`;

  return {
    sampleId: sample.id,
    domain: sample.domain,
    origin: sample.origin,
    mode,
    chunkCount: chunks.length,
    totalMs,
    translatedFull,
    chunks: chunkResults,
    preservation: checkPreservation(sourceFull, translatedFull),
    completeness: checkCompleteness(sample.content, translatedFull),
    error: null,
  };
}

async function runMadlad(sample: EvalSample): Promise<SampleResult> {
  const url = process.env.TEXT_WORKER_URL;
  const apiKey = process.env.TEXT_WORKER_API_KEY;
  if (!url || !apiKey) {
    return {
      sampleId: sample.id,
      domain: sample.domain,
      origin: sample.origin,
      mode: "madlad",
      chunkCount: 0,
      totalMs: 0,
      translatedFull: "",
      chunks: [],
      preservation: { identifierChecks: [], namedTechChecks: [], numberChecks: [] },
      completeness: checkCompleteness(sample.content, ""),
      error: "TEXT_WORKER_URL/TEXT_WORKER_API_KEY not set",
    };
  }
  const provider = new MadladTranslationProvider(url, apiKey, "google/madlad400-3b-mt");
  const tracer = GenerationTracer.disabled();
  const prompts = buildTranslationPrompts(sample.title, sample.content, "bg");
  const t0 = Date.now();
  try {
    const result = await provider.translate(
      {
        feedItemId: `eval-${sample.id}`,
        url: "experiment://local",
        title: sample.title,
        content: sample.content,
        targetLang: "bg",
        mode: prompts.mode,
        prompts,
      },
      {
        tracer,
        now: () => new Date(),
        diag: { experiment: "madlad-vs-translategemma-eval" },
        attemptTimeoutMs: 120_000,
        itemDeadlineMs: Date.now() + 900_000,
        itemTimeoutMs: 900_000,
        reportTry: () => {},
      }
    );
    const totalMs = Date.now() - t0;
    const translatedFull = `${result.translatedTitle}\n\n${result.translatedContent ?? ""}`;
    const sourceFull = `${sample.title}\n\n${sample.content}`;
    return {
      sampleId: sample.id,
      domain: sample.domain,
      origin: sample.origin,
      mode: "madlad",
      chunkCount: result.modelCalls ?? result.tries,
      totalMs,
      translatedFull,
      chunks: [],
      preservation: checkPreservation(sourceFull, translatedFull),
      completeness: checkCompleteness(sample.content, translatedFull),
      error: null,
    };
  } catch (err) {
    const msg =
      err instanceof TranslationParseError
        ? `REJECTED (${err.reason}): ${err.message}`
        : String(err);
    return {
      sampleId: sample.id,
      domain: sample.domain,
      origin: sample.origin,
      mode: "madlad",
      chunkCount: 0,
      totalMs: Date.now() - t0,
      translatedFull: "",
      chunks: [],
      preservation: { identifierChecks: [], namedTechChecks: [], numberChecks: [] },
      completeness: checkCompleteness(sample.content, ""),
      error: msg,
    };
  }
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outPath = argv[0];
  if (!outPath || outPath.startsWith("--")) {
    console.error(
      "Usage: npx tsx scripts/experiment-eval-runner.ts <output.json> [--only mode] [--samples id1,id2]"
    );
    process.exit(1);
  }
  const onlyIdx = argv.indexOf("--only");
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;
  const samplesIdx = argv.indexOf("--samples");
  const onlyIds = samplesIdx >= 0 ? argv[samplesIdx + 1].split(",") : null;

  const samples = onlyIds ? EVAL_SAMPLES.filter((s) => onlyIds.includes(s.id)) : EVAL_SAMPLES;
  console.log(`Running ${samples.length} samples${only ? ` (mode: ${only})` : " x 3 modes"}...`);

  const results: SampleResult[] = [];
  for (const [i, sample] of samples.entries()) {
    console.log(`\n[${i + 1}/${samples.length}] ${sample.id} (${sample.domain}, ${sample.origin})`);

    if (!only || only === "madlad") {
      console.log("  madlad...");
      const r = await runMadlad(sample);
      console.log(
        `    ${r.error ? "ERROR: " + r.error : `${r.totalMs}ms, ${r.chunkCount} call(s)`}`
      );
      results.push(r);
    }
    if (!only || only === "gemma-native") {
      console.log("  gemma-native...");
      const r = await runGemma(sample, false, "gemma-native");
      console.log(`    ${r.totalMs}ms, ${r.chunkCount} chunk(s)`);
      results.push(r);
    }
    if (!only || only === "gemma-glossary") {
      console.log("  gemma-glossary...");
      const r = await runGemma(sample, true, "gemma-glossary");
      console.log(`    ${r.totalMs}ms, ${r.chunkCount} chunk(s)`);
      results.push(r);
    }

    // Write after every sample so a partial run is still recoverable.
    writeFileSync(outPath, JSON.stringify({ samples: samples.map((s) => s.id), results }, null, 2));
  }

  console.log(`\nDone. Wrote ${results.length} results to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
