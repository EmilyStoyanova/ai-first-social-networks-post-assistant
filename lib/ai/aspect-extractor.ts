import { createHash } from "node:crypto";
import { z } from "zod";
import type { ILlmProvider, FeedItemContext } from "./types";
import { validateAspects, type ContentAspect } from "./content-aspect";
import { renderFeedItemContent } from "./source-content";

// ─── Context fingerprint ───────────────────────────────────────────────────────

/**
 * Derives a stable fingerprint for the aspect pool of ONE primary feed item.
 * Returns null when there is no primary (a mission/brand post mines no aspects).
 *
 * Keyed to the primary alone, never to the set of items in context. A set-based
 * fingerprint (all ids, sorted) was the source of a real production bug: it is
 * identical for every post drawn from the same feed window, so post 2 — built
 * around a different article — loaded post 1's pool and was handed an aspect
 * mined from a third article. The post then discussed that article while the
 * appended URL still pointed at its own. One article, one pool.
 *
 * Source-type agnostic: all content sources produce FeedItems, so this works for
 * RSS, product pages, calendar events, and future source types equally.
 */
export function buildPrimaryFingerprint(primary: FeedItemContext | null): string | null {
  if (!primary) return null;
  return createHash("sha256").update(primary.id).digest("hex").slice(0, 12);
}

// ─── Extraction prompt ────────────────────────────────────────────────────────

/**
 * The primary source's text, and nothing else.
 *
 * Background items are deliberately excluded. An aspect is injected into the
 * generation prompt as a MANDATORY constraint ("build this post around this
 * focus, do NOT replace it"), so an aspect mined from a background article is an
 * instruction to write about an article the post does not link to.
 *
 * Rendered by the SAME function the generation prompt uses (source-content.ts).
 * If the two diverged, the mandatory constraint would describe a text the model
 * writing the post was never shown — which is how a calendar event whose stored
 * JSON reached this extractor raw came back as "product launch date".
 */
function buildSourceContent(primary: FeedItemContext): string {
  return renderFeedItemContent(primary);
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
 * Calls the LLM provider to extract distinct content aspects from the PRIMARY
 * feed item — the one article the post will be written from and linked to.
 * existingFocuses are passed as exclusions so progressive extraction rounds
 * don't re-surface angles already in the pool.
 * Returns an empty array (non-throwing) if the response is unparseable.
 */
export async function extractAspects(
  provider: ILlmProvider,
  primary: FeedItemContext,
  existingFocuses: string[]
): Promise<ContentAspect[]> {
  const sourceContent = buildSourceContent(primary);
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
    "You extract distinct, narrow content aspects from source material. " +
    "Each aspect is a specific, actionable angle a single social media post could take on the provided content. " +
    "Prefer narrow sub-aspects over broad themes: every aspect must identify ONE distinct fact, benefit, problem, audience need, or takeaway that is grounded in the source. " +
    "Return ONLY a raw JSON array — no markdown fences, no explanation.";

  const userPrompt =
    "Source content:\n---\n" +
    sourceContent +
    "\n---\n" +
    exclusionBlock +
    "\nExtract distinct, fine-grained aspects from the source content above. " +
    "Each aspect must be genuinely specific to this content — not a generic marketing angle.\n\n" +
    "Return ONLY a JSON array in this exact format:\n" +
    "[\n" +
    "  {\n" +
    '    "title": "short label (3-6 words)",\n' +
    '    "focus": "one narrow, actionable sub-aspect: a distinct fact, benefit, problem, audience need, or takeaway (8-20 words, concrete and grounded in the source)",\n' +
    '    "visualConcept": "concrete visual scene for an image generation model (10-20 words, no text, logos, or people)"\n' +
    "  }\n" +
    "]\n\n" +
    "Rules:\n" +
    "- Prefer narrow, actionable sub-aspects over broad themes — 'shallow calm bays suit toddlers' beats 'great for families'\n" +
    "- Each focus must identify ONE distinct fact, benefit, problem, audience need, or takeaway — not a mood or generic praise\n" +
    "- Each focus must be specific to the source content and grounded in it — avoid generic themes like 'innovation' or 'success', and do not invent facts the source does not support\n" +
    // A short source (a calendar event is often a title and a date) used to be
    // padded out by reframing it as something richer — an event became a
    // "product launch". The aspect then overrode the real subject downstream.
    "- Keep the source as the kind of thing it says it is: an event is an event, a brief is a brief. Never recast it as a product launch, announcement, or campaign the source does not describe\n" +
    "- If the source states only a few facts, return only the aspects those facts support — one aspect is a correct answer for a sparse source\n" +
    "- Reject aspects that differ only by wording: two focuses that make the same point with different words are the SAME aspect — return only one\n" +
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
