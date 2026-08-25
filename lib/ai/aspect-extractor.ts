import { createHash } from "node:crypto";
import type { ILlmProvider, LlmRequest, FeedItemContext } from "./types";
import { validateAspects, type ContentAspect } from "./content-aspect";
import { PRIMARY_CONTENT_LIMIT, renderFeedItemContent } from "./source-content";

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
  // Same budget the generation prompt gives the primary, not the default. The
  // shared-rendering invariant above is about the TEXT, so a smaller limit here
  // would reinstate the divergence it exists to prevent: aspects mined from the
  // opening paragraphs, then imposed as a mandatory constraint on a model that
  // was shown the whole article.
  return renderFeedItemContent(primary, PRIMARY_CONTENT_LIMIT);
}

// ─── Response parsing ─────────────────────────────────────────────────────────
//
// Parsing only confirms the reply is a JSON array — the SHAPE of each element is
// deliberately not enforced here. A strict schema over the whole array (as this
// used to be, via z.array(z.object({...})).safeParse) fails the array wholesale
// the moment ONE element is malformed, discarding every valid aspect alongside
// it. validateAspects() below is the actual per-object gate: it inspects each
// element independently and only drops the ones that fail, so one bad element
// (e.g. a "(title" key instead of "title") costs exactly one aspect, not the pool.

function stripFences(raw: string): string {
  const fenced = raw.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  return fenced ? fenced[1].trim() : raw.trim();
}

/** Parses one LLM reply into validated aspects. Never throws — worst case, []. */
function parseAspects(text: string, existingFocuses: string[]): ContentAspect[] {
  const cleaned = stripFences(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return validateAspects(parsed, existingFocuses);
}

// ─── Extraction ───────────────────────────────────────────────────────────────

const NO_VALID_ASPECTS_FEEDBACK =
  "\n\nYour previous response contained no valid aspect objects — it was either " +
  "unparseable, not a JSON array, or every element was missing/malformed " +
  '"title", "focus", or "visualConcept". Return ONLY a JSON array of well-formed ' +
  "aspect objects, each with all three fields as non-empty strings.";

/**
 * Calls the LLM provider to extract distinct content aspects from the PRIMARY
 * feed item — the one article the post will be written from and linked to.
 * existingFocuses are passed as exclusions so progressive extraction rounds
 * don't re-surface angles already in the pool.
 *
 * A malformed element in an otherwise-valid array costs only that element —
 * see parseAspects/validateAspects. Retrying is reserved for the case where
 * NOTHING in the reply survived validation (empty array, unparseable JSON, or
 * every element rejected): one extra attempt, with explicit feedback, before
 * giving up and returning []. A reply with at least one valid aspect is never
 * retried, so a single bad element never costs a redundant LLM call.
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

  const request: LlmRequest = { systemPrompt, userPrompt, temperature: 0.5, maxTokens: 600 };

  const response = await provider.generate(request);
  const aspects = parseAspects(response.text, existingFocuses);
  if (aspects.length > 0) return aspects;

  // Zero valid aspects survived — one bounded retry with explicit feedback,
  // never a fabricated replacement.
  const retry = await provider.generate({
    ...request,
    userPrompt: userPrompt + NO_VALID_ASPECTS_FEEDBACK,
  });
  return parseAspects(retry.text, existingFocuses);
}
