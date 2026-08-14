import type { FeedItemContext } from "./types";

/**
 * How a stored FeedItem becomes prompt text.
 *
 * Ingestion stores different SHAPES per source type (see runSourceIngestion):
 *
 *   • rss            — `content` is the extracted article body (plain text)
 *   • prompt         — `content` is the brief the user typed (plain text)
 *   • product_page   — `content` is JSON: {title, description, image} and, when
 *                      the source carries an extraction instruction,
 *                      {instructions, pageText} alongside them. That raw page is
 *                      the INPUT to the ingestion-time extraction step; once it
 *                      has run, the item's `extractedContent` column holds the
 *                      requested facts and is what this module renders.
 *   • calendar_event — `content` is JSON: {title, date, description}
 *
 * The two JSON shapes used to reach the model verbatim, as a literal
 * `{"title":"…","date":"2026-08-29","description":null}` blob sitting under a
 * heading that called it an "article". That is what produced the bug this module
 * exists to fix: a conference with no description was read as a product launch
 * ("Product launch date is set for August 29, 2026"), that reading was mined
 * into a content aspect, and the aspect reaches the generation prompt as a
 * MANDATORY constraint that outranks the source block — so the post ended up
 * being about launch planning and never mentioned the event.
 *
 * Rendering is shared by the generation prompt and the aspect extractor on
 * purpose: an aspect is mined from the primary and then imposed on the post, so
 * the two must read the same text or the constraint describes something the
 * model was never shown.
 */

/** Per-item free-text budget. Structured fields (date, kind) are never truncated. */
export const CONTENT_PER_ITEM_LIMIT = 900;

/** The source types whose `content` is a JSON object rather than prose. */
const STRUCTURED_TYPES = new Set(["product_page", "calendar_event"]);

function truncate(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

/** Parses a stored JSON payload; null for anything that is not a JSON object. */
function parseStored(raw: string): Record<string, unknown> | null {
  if (!raw.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Renders an ISO `YYYY-MM-DD` (what `<input type="date">` stores) as
 * `29.08.2026 (2026-08-29)`.
 *
 * Both forms, deliberately. The day-first form is what a Bulgarian or European
 * reader expects the post to quote, and leaving only the ISO form invites the
 * model to write "2026-08-29" into the post text; the ISO form stays alongside
 * it so a date like 05.08.2026 cannot be read month-first. Formatted from the
 * STRING, never via `new Date()`, so no timezone can shift the day.
 */
export function formatEventDate(raw: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!match) return raw.trim();
  const [, year, month, day] = match;
  return `${day}.${month}.${year} (${year}-${month}-${day})`;
}

function renderCalendarEvent(stored: Record<string, unknown>, limit: number): string {
  const date = stringField(stored, "date");
  const description = stringField(stored, "description");

  return [
    "Calendar event — a dated event, not an article and not a product launch.",
    date ? `Date: ${formatEventDate(date)}` : null,
    description
      ? `Description: ${truncate(description, limit)}`
      : // Said out loud rather than left as a silent gap: an empty description is
        // exactly where the model previously invented a purpose for the event.
        "No description was provided for this event. Write only about what is stated above — do not invent a programme, speakers, venue, audience, or purpose.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Free-text budget for a product page's captured body text.
 *
 * Larger than CONTENT_PER_ITEM_LIMIT on purpose, and only for this case: the
 * instruction names a part of the page ("the events listed this week"), so
 * truncating the page to a meta-description-sized excerpt would cut away the
 * very thing that was asked for and leave the instruction pointing at nothing.
 * A caller that asks for a bigger budget still gets it.
 */
export const INSTRUCTED_PAGE_TEXT_LIMIT = 2_500;

/**
 * Budget for a completed extraction result.
 *
 * The most generous of the three, because this text is already the answer: it was
 * produced by asking a model for exactly the requested facts and nothing else, so
 * every character of it is something the post was asked to carry. Truncating it
 * is dropping events off the end of a list that was gathered precisely so it
 * would be complete.
 */
export const EXTRACTED_CONTENT_LIMIT = 4_000;

function renderProductPage(
  item: FeedItemContext,
  stored: Record<string, unknown>,
  limit: number
): string {
  const description = stringField(stored, "description");
  // `image` is deliberately dropped: an image URL is noise to a text model, and
  // it competes for the per-item character budget with the description.
  const instructions = stringField(stored, "instructions");
  if (!instructions) {
    return ["Product page.", description ? truncate(description, limit) : null]
      .filter(Boolean)
      .join("\n");
  }

  const extracted = item.extractedContent?.trim();

  // The normal path once the ingestion-time extraction has run: the prompt gets
  // the FACTS, not the page. The raw page is deliberately left out — including
  // both would invite the model to re-derive its own list and disagree with the
  // one its sibling channels were given.
  if (item.extractionStatus === "completed" && extracted) {
    return [
      "Product page — the facts below were extracted from it in advance, against this instruction:",
      truncate(instructions, limit),
      "",
      "EXTRACTED SOURCE DATA — the complete and only permitted set of facts for this post:",
      truncate(extracted, Math.max(limit, EXTRACTED_CONTENT_LIMIT)),
      "",
      "Every item above was extracted because it matches the instruction. Do not add an item, a date, a price or a category that is not listed, and do not drop one to save space.",
    ].join("\n");
  }

  // The extraction ran and answered "not on this page" — an instruction asking
  // for next week against a page listing this week. Saying so plainly is the
  // whole point of storing that outcome: the alternative is a model handed an
  // instruction and a page that cannot satisfy it, which is how a confident,
  // entirely invented list gets written.
  if (item.extractionStatus === "not_found") {
    return [
      "Product page.",
      `The source was asked for: ${truncate(instructions, limit)}`,
      "The extraction step found NOTHING on this page matching that instruction. There are no items to write about.",
      "Do not invent any. If there is nothing to report, say so plainly rather than describing items the page does not contain.",
    ].join("\n");
  }

  // Extraction has not run yet (queued, in flight, or it failed). Falling back to
  // the raw page keeps a generation possible rather than blocking it, at the cost
  // of the model doing the reading itself — which is exactly the arrangement the
  // extraction step replaces, so it is a fallback and not a second design.
  const pageText = stringField(stored, "pageText") ?? description;

  return [
    "Product page.",
    `WHAT TO TAKE FROM THIS PAGE: ${truncate(instructions, limit)}`,
    pageText
      ? `Page content:\n${truncate(pageText, Math.max(limit, INSTRUCTED_PAGE_TEXT_LIMIT))}`
      : null,
    pageText
      ? "Use only what the page content above actually states. If it does not contain something the instruction asks for, leave that out — do not invent it."
      : "The page content could not be read. Write only from the title and the instruction above, and do not invent details the page might contain.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The `**title**` + body block that represents one feed item in a prompt.
 *
 * Plain-text sources (rss, prompt, and any item whose type is unknown or whose
 * stored JSON will not parse) render exactly as they always have — title line
 * plus a truncated excerpt — so the RSS and cron paths are untouched.
 */
export function renderFeedItemContent(
  item: FeedItemContext,
  limit: number = CONTENT_PER_ITEM_LIMIT
): string {
  const raw = item.content?.trim() ?? "";
  const stored = item.sourceType && STRUCTURED_TYPES.has(item.sourceType) ? parseStored(raw) : null;

  // The stored JSON repeats the title; prefer the column, fall back to the
  // payload so an item ingested without one still names itself.
  const title = (item.title?.trim() || (stored ? stringField(stored, "title") : null)) ?? "";

  let body: string;
  if (stored && item.sourceType === "calendar_event") {
    body = renderCalendarEvent(stored, limit);
  } else if (stored && item.sourceType === "product_page") {
    body = renderProductPage(item, stored, limit);
  } else {
    body = truncate(raw, limit);
  }

  return [title ? `**${title}**` : null, body || null].filter(Boolean).join("\n");
}

/**
 * The extraction instruction a feed item carries, or null when it has none.
 *
 * Only a product page can have one (see the schema), and it is the single most
 * authoritative thing in a generation: the owner has said, in their own words,
 * what a post from this page must contain. Everything else the pipeline decides
 * — the rotated angle, the writing pattern, the mined content aspect — is a
 * heuristic about HOW to write, and none of them may quietly overrule it.
 *
 * Exported so the prompt builder can state it as a requirement and aspect mining
 * can stand down: an aspect reaches the prompt as "build this post around this
 * one focus", which is the exact opposite of "list everything on the page".
 */
export function sourceExtractionInstruction(item: FeedItemContext | null): string | null {
  if (!item || item.sourceType !== "product_page") return null;
  const stored = parseStored(item.content?.trim() ?? "");
  return stored ? stringField(stored, "instructions") : null;
}

/**
 * Whether the ingestion-time extraction ran and found nothing on the page.
 *
 * Separate from the instruction itself because the two answer different
 * questions. The instruction still exists — it is why aspect mining must stay
 * out of the way — but there is nothing to cover, so the prompt must NOT also
 * carry "include every item the instruction asks for". A prompt that says both
 * "there are no items" and "list them all" is resolved by the model, which is
 * precisely how an invented list gets written.
 */
export function extractionFoundNothing(item: FeedItemContext | null): boolean {
  return item?.sourceType === "product_page" && item.extractionStatus === "not_found";
}

/** The heading and instruction that introduce the primary source in a prompt. */
export interface PrimarySourceFraming {
  heading: string;
  instruction: string;
}

const ARTICLE_FRAMING: PrimarySourceFraming = {
  heading: "**PRIMARY SOURCE ARTICLE — the post MUST be based on THIS article and no other.**",
  instruction:
    "The topic, facts, and angle of the post must come from this article. A link to this exact article will be attached to the post, so the post text must be about it.",
};

/**
 * How the primary source is introduced, by what it actually is.
 *
 * rss and product_page keep the article framing verbatim — they are pages with a
 * URL that really is appended, and changing their wording would change
 * generation on the RSS and cron paths.
 *
 * The evergreen types get their own: calling a calendar event an "article" and
 * promising a link that is never attached (their `event:`/`prompt:` URLs are
 * storage keys, never appended — see hasPublicUrl) told the model two false
 * things about its own source.
 */
export function framePrimarySource(item: FeedItemContext): PrimarySourceFraming {
  if (item.sourceType === "calendar_event") {
    return {
      heading:
        "**PRIMARY SOURCE — CALENDAR EVENT — the post MUST be about THIS event and no other.**",
      instruction:
        "The subject, facts, and angle of the post must come from the event details below. Use only the details given: do not reframe the event as something else (a product launch, a company announcement, or a generic business tip), and do not invent details it does not state.",
    };
  }
  if (item.sourceType === "prompt") {
    return {
      heading: "**PRIMARY SOURCE — CONTENT BRIEF — the post MUST follow THIS brief and no other.**",
      instruction:
        "The subject, facts, and angle of the post must come from the brief below. Do not replace it with a different subject, and do not invent facts the brief does not state.",
    };
  }
  return ARTICLE_FRAMING;
}
