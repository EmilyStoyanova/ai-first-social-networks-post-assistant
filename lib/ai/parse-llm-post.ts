import { z } from "zod";
import { LlmResponseParseError } from "./errors";

const LlmPostSchema = z.object({
  text: z.string().min(1, "text must be non-empty"),
  hashtags: z.array(z.string()).default([]),
  // The single central claim/takeaway of the post (Phase 1.1) — one sentence,
  // model-declared, stored in promptSnapshot. Required and non-empty.
  coreMessage: z.string().trim().min(1, "coreMessage must be non-empty"),
  imagePrompt: z.string().optional(),
  notes: z.string().optional(),
  // Diversity tracking — model-declared, stored in promptSnapshot.
  topic: z.string().optional(),
});

export type ParsedLlmPost = z.infer<typeof LlmPostSchema>;

function stripFences(raw: string): string {
  const fenced = raw.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  return fenced ? fenced[1].trim() : raw.trim();
}

export function parseLlmPost(raw: string): ParsedLlmPost {
  const cleaned = stripFences(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new LlmResponseParseError(`LLM response is not valid JSON: ${cleaned.slice(0, 200)}`);
  }

  const result = LlmPostSchema.safeParse(parsed);
  if (!result.success) {
    throw new LlmResponseParseError(`LLM response failed validation: ${result.error.message}`);
  }

  return result.data;
}
