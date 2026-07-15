/**
 * Topic Memory — conceptual-repetition guard.
 *
 * Similar prompts (e.g. Barcelona vs. Lisbon) push the LLM toward the same
 * conceptual topic ("Authentic Lisbon") even when the source supports several
 * distinct angles. The semantic gate catches near-duplicate CLAIMS but a
 * repeated topic can slip under its threshold. Topic Memory normalizes the
 * topics of recent posts (same company + channel) and:
 *   1. feeds them to the prompt as recently-used subjects to avoid, and
 *   2. rejects a freshly generated post whose normalized topic collides with
 *      one already used — reusing the existing retry pipeline.
 *
 * Pure and deterministic — no DB, no embeddings, no LLM, no schema.
 */

/** How many recent posts feed the topic memory. */
export const TOPIC_MEMORY_SIZE = 30;

/**
 * Normalizes a topic to a comparison key: lowercased, punctuation and symbols
 * stripped, whitespace collapsed and trimmed. Letters (including Cyrillic) and
 * digits are preserved. Returns "" when nothing meaningful remains.
 */
export function normalizeTopic(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ") // drop anything that is not a letter, digit, or space
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Builds the ordered, de-duplicated list of normalized topic keys from recent
 * posts. Input order (most-recent-first) is preserved; blank/absent topics are
 * dropped. The result is safe to both show in the prompt and compare against.
 */
export function buildTopicMemory(rawTopics: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const memory: string[] = [];
  for (const raw of rawTopics) {
    const key = normalizeTopic(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    memory.push(key);
  }
  return memory;
}

/**
 * True when the candidate topic's normalized key already appears in the topic
 * memory. A blank/absent candidate topic is never treated as a repeat (the
 * model simply declared no topic), so it never blocks generation on its own.
 *
 * The memory is expected to already hold normalized keys (see buildTopicMemory);
 * the candidate is normalized here so both sides compare on the same basis.
 */
export function isTopicRepeated(
  candidateTopic: string | null | undefined,
  memory: readonly string[]
): boolean {
  const key = normalizeTopic(candidateTopic);
  if (!key) return false;
  return memory.includes(key);
}
