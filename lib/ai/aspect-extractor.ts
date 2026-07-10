import { createHash } from "node:crypto";
import { z } from "zod";
import type { ILlmProvider, FeedItemContext } from "./types";
import { validateAspects, type ContentAspect } from "./content-aspect";

// ─── Context fingerprint ───────────────────────────────────────────────────────

/**
 * Derives a stable fingerprint from the set of feed items used as source content.
 * Returns null when there are no feed items (no meaningful source to mine aspects from).
 * Source-type agnostic: all content sources produce FeedItems, so this works for
 * RSS, product pages, calendar events, and future source types equally.
 */
export function buildContextFingerprint(feedItems: FeedItemContext[]): string | null {
  if (feedItems.length === 0) return null;
  const ids = feedItems
    .map((f) => f.id)
    .sort()
    .join("|");
  return createHash("sha256").update(ids).digest("hex").slice(0, 12);
}

// ─── Extraction prompt ────────────────────────────────────────────────────────

const CONTENT_PER_ITEM_LIMIT = 900;
const TOTAL_CONTENT_LIMIT = 4000;

function buildSourceContent(feedItems: FeedItemContext[]): string {
  let budget = TOTAL_CONTENT_LIMIT;
  const parts: string[] = [];

  for (const item of feedItems) {
    if (budget <= 0) break;
    const title = item.title?.trim() ?? "";
    const raw = item.content?.trim() ?? "";
    const excerpt =
      raw.length > CONTENT_PER_ITEM_LIMIT ? raw.slice(0, CONTENT_PER_ITEM_LIMIT) + "…" : raw;
    const block = [title ? `**${title}**` : null, excerpt || null].filter(Boolean).join("\n");
    if (!block) continue;
    if (block.length > budget) break;
    budget -= block.length + 10;
    parts.push(block);
  }

  return parts.join("\n---\n");
}

// ─── Response parsing ─────────────────────────────────────────────────────────

const RawAspectArraySchema = z.array(
  z.object({
    title: z.string(),
    focus: z.string(),
    visualConcept: z.string(),
  })
);

function stripFences(raw: string): string {
  const fenced = raw.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  return fenced ? fenced[1].trim() : raw.trim();
}

// ─── Extraction ───────────────────────────────────────────────────────────────

/**
 * Calls the LLM provider to extract distinct content aspects from the feed items.
 * existingFocuses are passed as exclusions so progressive extraction rounds
 * don't re-surface angles already in the pool.
 * Returns an empty array (non-throwing) if the response is unparseable.
 */
export async function extractAspects(
  provider: ILlmProvider,
  feedItems: FeedItemContext[],
  existingFocuses: string[]
): Promise<ContentAspect[]> {
  const sourceContent = buildSourceContent(feedItems);
  if (!sourceContent) return [];

  const exclusionBlock =
    existingFocuses.length > 0
      ? [
          "",
          "Do not produce aspects whose focus overlaps with any of these already-covered angles:",
          ...existingFocuses.map((f) => `- ${f}`),
          "",
        ].join("\n")
      : "";

  const systemPrompt =
    "You extract distinct content aspects from source material. " +
    "Each aspect is a specific angle a social media post could take on the provided content. " +
    "Return ONLY a raw JSON array — no markdown fences, no explanation.";

  const userPrompt =
    "Source content:\n---\n" +
    sourceContent +
    "\n---\n" +
    exclusionBlock +
    "\nExtract distinct aspects from the source content above. " +
    "Each aspect must be genuinely specific to this content — not a generic marketing angle.\n\n" +
    "Return ONLY a JSON array in this exact format:\n" +
    "[\n" +
    "  {\n" +
    '    "title": "short label (3-6 words)",\n' +
    '    "focus": "specific conceptual focus (8-20 words, concrete and unique to this content)",\n' +
    '    "visualConcept": "concrete visual scene for an image generation model (10-20 words, no text, logos, or people)"\n' +
    "  }\n" +
    "]\n\n" +
    "Rules:\n" +
    "- Each focus must be specific to the source content — avoid generic themes like 'innovation' or 'success'\n" +
    "- Minimum 3 distinct words per focus — no one-word or two-word focuses\n" +
    "- visualConcept must be photorealistic and concrete — not abstract\n" +
    "- Return only aspects you are confident about — do NOT pad to a fixed count";

  const response = await provider.generate({
    systemPrompt,
    userPrompt,
    temperature: 0.5,
    maxTokens: 600,
  });

  const cleaned = stripFences(response.text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }

  const result = RawAspectArraySchema.safeParse(parsed);
  if (!result.success) return [];

  return validateAspects(result.data, existingFocuses);
}
