/**
 * EXPERIMENT — not wired into the production pipeline. Exports the EXACT SAME test
 * data used for the TranslateGemma experiment (scripts/experiment-translategemma.ts) as
 * JSON, so the Python/OPUS-MT side of the comparison translates byte-identical inputs
 * rather than retyped copies. Read-only: touches no production code, no DB.
 *
 * Also exports the production protectTokens() result for the preservation text, so the
 * Python side can test the real [[n]] placeholder mechanism against OPUS-MT exactly as
 * it was tested against MADLAD and TranslateGemma.
 *
 * Usage: npx tsx scripts/experiment-opus-mt-export-fixtures.ts <output.json>
 */

import {
  TRANSLATION_FIXTURES,
  findTranslationFixture,
} from "@/lib/ai/translation/translation-fixtures";
import { protectTokens } from "@/lib/ai/translation/protected-tokens";
import { TERMINOLOGY_SENTENCES, PRESERVATION_TEXT, GLOSSARY } from "./experiment-translategemma";
import { writeFileSync } from "node:fs";

const outPath = process.argv[2];
if (!outPath) {
  console.error("Usage: npx tsx scripts/experiment-opus-mt-export-fixtures.ts <output.json>");
  process.exit(1);
}

const powerTools = findTranslationFixture("power-tools");
if (!powerTools) throw new Error("power-tools fixture not found");
const powerToolsFull = `${powerTools.title}\n\n${powerTools.content}`;
// Same naive splitters used in experiment-translategemma.ts's chunk stage, reused
// verbatim so the OPUS-MT chunk experiment segments the article identically.
const paragraphs = powerToolsFull.split(/\n\n+/).filter((p) => p.trim().length > 0);
const sentences = powerToolsFull
  .split(/\n\n+/)
  .flatMap((p) => p.split(/(?<=[.!?])\s+/))
  .filter((s) => s.trim().length > 0);

const protectedPreservation = protectTokens(PRESERVATION_TEXT);

const payload = {
  terminologySentences: TERMINOLOGY_SENTENCES,
  glossary: GLOSSARY,
  preservationText: PRESERVATION_TEXT,
  protectedPreservationText: protectedPreservation.text,
  protectedPreservationValues: protectedPreservation.values,
  fixtures: TRANSLATION_FIXTURES.map((f) => ({
    name: f.name,
    traps: f.traps,
    title: f.title,
    content: f.content,
  })),
  powerToolsChunks: { whole: powerToolsFull, paragraphs, sentences },
};

writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(`Wrote ${outPath}`);
console.log(`  ${TERMINOLOGY_SENTENCES.length} terminology sentences`);
console.log(`  ${TRANSLATION_FIXTURES.length} fixtures`);
console.log(`  power-tools: ${paragraphs.length} paragraphs, ${sentences.length} sentences`);
console.log(`  preservation text: ${protectedPreservation.values.length} protected value(s)`);
