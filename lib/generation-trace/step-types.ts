/**
 * The pipeline stages a generation trace can record.
 *
 * A plain string union rather than a database enum, matching `Job.type` and
 * `AuditLog.action`: a new stage must not need a migration to become visible.
 * What this module owns is the KNOWN vocabulary — the order the timeline reads
 * in, and the label a reader sees — so an unknown type coming back from an older
 * row still renders, at the end, under its own name.
 */

export const GENERATION_STEP_TYPES = [
  /** Who asked, for what, with which options. Always the first step. */
  "request",
  /** The article/page/prompt the post was written from, as it stood. */
  "source",
  /** Raw page text → the cleaned/extracted content actually used. */
  "extraction",
  /** The article's translation — a reference to the run that produced it. */
  "translation",
  /** The article's topic verdict — a reference to the run that produced it. */
  "classification",
  /** Which candidate was chosen out of the window, and why. */
  "selection",
  /** Everything the prompt was built from, snapshotted. */
  "context",
  /** The exact system and user prompts, as sent. */
  "prompt",
  /** One provider call: parameters, latency, token usage, transport errors. */
  "llm_call",
  /** The provider's reply, before any parsing or normalization. */
  "raw_response",
  /** The reply after parsing/normalization into post fields. */
  "parsed_result",
  /** One quality gate's verdict: score, threshold, comparison, PASS/FAIL. */
  "validation",
  /** Why an attempt was rejected and what the next one was told to change. */
  "retry",
  /** Article image vs generated image, the prompt used, and what was attached. */
  "image",
  /** The row that was written: id, status, schedule, group. */
  "persistence",
] as const;

export type GenerationStepType = (typeof GENERATION_STEP_TYPES)[number];

/**
 * Where an unrecognised type sorts. Only ever consulted when a trace written by
 * a newer build is read by an older one; the authoritative order is the stored
 * `sequence`, and this is the tie-break for grouping in the UI.
 */
export const UNKNOWN_STEP_ORDER = GENERATION_STEP_TYPES.length;

export function stepTypeOrder(type: string): number {
  const index = (GENERATION_STEP_TYPES as readonly string[]).indexOf(type);
  return index === -1 ? UNKNOWN_STEP_ORDER : index;
}

export function isKnownStepType(type: string): type is GenerationStepType {
  return (GENERATION_STEP_TYPES as readonly string[]).includes(type);
}
