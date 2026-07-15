/**
 * Builds the semantic document that is embedded for duplicate detection.
 *
 * Historically only the `coreMessage` was embedded. Enriching the embedded text
 * with the post's topic and the mined aspect focus gives the vector more signal
 * to separate genuinely distinct posts from near-repeats, without touching the
 * cosine thresholds or the gate mechanics.
 *
 * The document has a fixed section order so the same inputs always yield the same
 * text (embeddings are deterministic on their input). Missing/blank sections are
 * omitted entirely:
 *
 *   Topic: <topic>
 *
 *   Core message:
 *   <coreMessage>
 *
 *   Aspect:
 *   <aspectFocus>
 */

export interface SemanticDocumentInput {
  topic?: string | null;
  coreMessage?: string | null;
  aspectFocus?: string | null;
}

export function buildSemanticDocument(input: SemanticDocumentInput): string {
  const sections: string[] = [];

  const topic = input.topic?.trim();
  const coreMessage = input.coreMessage?.trim();
  const aspectFocus = input.aspectFocus?.trim();

  if (topic) sections.push(`Topic: ${topic}`);
  if (coreMessage) sections.push(`Core message:\n${coreMessage}`);
  if (aspectFocus) sections.push(`Aspect:\n${aspectFocus}`);

  return sections.join("\n\n");
}
