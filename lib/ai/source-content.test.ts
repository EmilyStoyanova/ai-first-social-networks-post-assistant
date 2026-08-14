import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractionFoundNothing,
  formatEventDate,
  framePrimarySource,
  renderFeedItemContent,
  sourceExtractionInstruction,
  INSTRUCTED_PAGE_TEXT_LIMIT,
} from "./source-content";
import { renderExtraction } from "./product-page-extraction";
import type { FeedItemContext } from "./types";

// The event from the production bug report, with the config keys ingestion
// actually writes (see runSourceIngestion's calendar_event branch).
const EVENT_TITLE = "DEV.BG All in One 2026";
const EVENT_DESCRIPTION =
  "Bulgaria's largest IT conference — AI, software engineering and career tracks across six halls.";

function item(overrides: Partial<FeedItemContext> = {}): FeedItemContext {
  return {
    id: "item-1",
    title: EVENT_TITLE,
    content: JSON.stringify({ title: EVENT_TITLE, date: "2026-08-29", description: null }),
    url: "event:src-1",
    publishedAt: null,
    sourceType: "calendar_event",
    sourceName: "DEV.BG events",
    consumable: false,
    ...overrides,
  };
}

describe("source-content — calendar events", () => {
  it("renders the event title, date, and description as readable fields", () => {
    const rendered = renderFeedItemContent(
      item({
        content: JSON.stringify({
          title: EVENT_TITLE,
          date: "2026-08-29",
          description: EVENT_DESCRIPTION,
        }),
      })
    );

    assert.ok(rendered.includes(`**${EVENT_TITLE}**`), "the event title heads the block");
    assert.ok(rendered.includes("29.08.2026"), "the date is readable, day first");
    assert.ok(rendered.includes(EVENT_DESCRIPTION), "the description reaches the prompt");
  });

  it("never emits the raw stored JSON", () => {
    // The bug: `{"title":"…","date":"2026-08-29","description":null}` was passed
    // to the model verbatim, under a heading calling it an article.
    const rendered = renderFeedItemContent(item());

    assert.ok(!rendered.includes('{"title"'), "no JSON object literal in the prompt text");
    assert.ok(!rendered.includes('"description":null'), "no null field leaks through");
  });

  it("says the source is an event, not an article or a launch", () => {
    const rendered = renderFeedItemContent(item());

    assert.ok(rendered.includes("Calendar event"), "the kind of source is stated");
    assert.ok(rendered.toLowerCase().includes("not a product launch"));
  });

  it("states outright when no description was provided", () => {
    // An empty description is exactly where the model invented a purpose for the
    // event; a silent gap invited that, so it is spelled out.
    const rendered = renderFeedItemContent(item());

    assert.ok(rendered.includes("No description was provided"));
    assert.ok(rendered.includes("do not invent"));
    assert.ok(rendered.includes("29.08.2026"), "a description-less event still carries its date");
  });

  it("keeps the date when the description is long enough to be truncated", () => {
    // Structured fields are outside the free-text budget — truncation may never
    // cost the model the one fact the event actually states.
    const rendered = renderFeedItemContent(
      item({
        content: JSON.stringify({
          title: EVENT_TITLE,
          date: "2026-08-29",
          description: "x".repeat(2000),
        }),
      }),
      100
    );

    assert.ok(rendered.includes("29.08.2026"));
    assert.ok(rendered.includes("…"), "the description itself is trimmed");
    assert.ok(rendered.length < 400);
  });

  it("falls back to the payload title when the column has none", () => {
    const rendered = renderFeedItemContent(item({ title: null }));

    assert.ok(rendered.includes(`**${EVENT_TITLE}**`));
  });
});

describe("source-content — formatEventDate", () => {
  it("renders an ISO date day-first with the ISO form alongside it", () => {
    // Both forms: the day-first one is what the post should quote, the ISO one
    // stops a date like 05.08.2026 from being read month-first.
    assert.equal(formatEventDate("2026-08-29"), "29.08.2026 (2026-08-29)");
    assert.equal(formatEventDate("2026-08-05"), "05.08.2026 (2026-08-05)");
  });

  it("passes anything that is not an ISO date through untouched", () => {
    assert.equal(formatEventDate("next spring"), "next spring");
  });

  it("does not shift the day across timezones", () => {
    // Parsed from the string, never through `new Date()`, which would render
    // 2026-01-01 as 31.12.2025 west of UTC.
    assert.ok(formatEventDate("2026-01-01").startsWith("01.01.2026"));
  });
});

describe("source-content — product pages", () => {
  const pageItem = item({
    title: "Pro Plan",
    content: JSON.stringify({
      title: "Pro Plan",
      description: "Everything in Starter, plus SSO.",
      image: "https://cdn.example.com/og.png",
    }),
    url: "https://shop.example.com/pro-plan",
    sourceType: "product_page",
    consumable: true,
  });

  it("renders the page title and description without the JSON", () => {
    const rendered = renderFeedItemContent(pageItem);

    assert.ok(rendered.includes("**Pro Plan**"));
    assert.ok(rendered.includes("Everything in Starter, plus SSO."));
    assert.ok(!rendered.includes('{"title"'));
  });

  it("drops the image URL, which is noise to a text model", () => {
    const rendered = renderFeedItemContent(pageItem);

    assert.ok(!rendered.includes("cdn.example.com"));
  });
});

describe("source-content — product pages with an extraction instruction", () => {
  const instructedItem = item({
    title: "Business events",
    content: JSON.stringify({
      title: "Business events",
      description: "A catalogue of business events.",
      image: null,
      instructions: "The events listed for this week, with date and venue.",
      pageText: "Events this week\nDigital Marketing Summit — 14.08.2026, Sofia Tech Park",
    }),
    url: "https://events.example.com/?week=current",
    sourceType: "product_page",
    consumable: true,
  });

  it("states the instruction and the page text the model must satisfy it from", () => {
    const rendered = renderFeedItemContent(instructedItem);

    assert.ok(rendered.includes("The events listed for this week, with date and venue."));
    assert.ok(rendered.includes("Digital Marketing Summit — 14.08.2026, Sofia Tech Park"));
    assert.ok(!rendered.includes('{"title"'));
  });

  it("gives the page text a bigger budget than the per-item limit", () => {
    // The instruction names a part of the page; truncating to a meta-description
    // sized excerpt would cut away the very thing that was asked for.
    const long = "e".repeat(INSTRUCTED_PAGE_TEXT_LIMIT - 100);
    const rendered = renderFeedItemContent(
      item({
        title: "Events",
        content: JSON.stringify({ instructions: "The events.", pageText: long }),
        sourceType: "product_page",
        consumable: true,
      })
    );

    assert.ok(rendered.includes(long), "the page text must survive the default per-item limit");
  });

  it("truncates page text beyond its own budget", () => {
    const rendered = renderFeedItemContent(
      item({
        title: "Events",
        content: JSON.stringify({
          instructions: "The events.",
          pageText: "e".repeat(INSTRUCTED_PAGE_TEXT_LIMIT + 500),
        }),
        sourceType: "product_page",
        consumable: true,
      })
    );

    assert.ok(rendered.endsWith("…") || rendered.includes("…"));
    assert.ok(rendered.length < INSTRUCTED_PAGE_TEXT_LIMIT + 500);
  });

  it("forbids inventing what the page does not state", () => {
    const rendered = renderFeedItemContent(instructedItem);

    assert.match(rendered, /do not invent it/i);
  });

  it("falls back to the description when the body could not be read", () => {
    const rendered = renderFeedItemContent(
      item({
        title: "Business events",
        content: JSON.stringify({
          description: "A catalogue of business events.",
          instructions: "The events listed for this week.",
          pageText: null,
        }),
        sourceType: "product_page",
        consumable: true,
      })
    );

    assert.ok(rendered.includes("A catalogue of business events."));
    assert.ok(rendered.includes("The events listed for this week."));
  });

  it("says so plainly when there is no page content at all", () => {
    const rendered = renderFeedItemContent(
      item({
        title: "Business events",
        content: JSON.stringify({ instructions: "The events listed for this week." }),
        sourceType: "product_page",
        consumable: true,
      })
    );

    assert.match(rendered, /could not be read/i);
    assert.match(rendered, /do not invent/i);
  });

  it("leaves a product page without an instruction rendering exactly as before", () => {
    const rendered = renderFeedItemContent(
      item({
        title: "Pro Plan",
        content: JSON.stringify({
          title: "Pro Plan",
          description: "Everything in Starter, plus SSO.",
          image: "https://cdn.example.com/og.png",
        }),
        url: "https://shop.example.com/pro-plan",
        sourceType: "product_page",
        consumable: true,
      })
    );

    assert.equal(rendered, "**Pro Plan**\nProduct page.\nEverything in Starter, plus SSO.");
  });
});

describe("source-content — plain-text sources are untouched", () => {
  it("renders an RSS article exactly as before: title line plus excerpt", () => {
    const rendered = renderFeedItemContent(
      item({
        title: "Rates hold steady",
        content: "The central bank left rates unchanged.",
        url: "https://news.example.com/rates",
        sourceType: "rss",
        consumable: true,
      })
    );

    assert.equal(rendered, "**Rates hold steady**\nThe central bank left rates unchanged.");
  });

  it("renders a prompt brief exactly as before", () => {
    const rendered = renderFeedItemContent(
      item({
        title: "Weekly tip",
        content: "Share one concrete productivity tip.",
        url: "prompt:src-1",
        sourceType: "prompt",
      })
    );

    assert.equal(rendered, "**Weekly tip**\nShare one concrete productivity tip.");
  });

  it("truncates long article bodies at the limit, as before", () => {
    const rendered = renderFeedItemContent(
      item({ content: "y".repeat(50), sourceType: "rss" }),
      10
    );

    assert.ok(rendered.endsWith("…"));
    assert.ok(rendered.includes("y".repeat(10)));
  });

  it("leaves a structured item whose content will not parse as prose", () => {
    // A legacy row, or one written before the JSON shape existed: better shown
    // raw than dropped.
    const rendered = renderFeedItemContent(item({ content: "A conference in Sofia." }));

    assert.equal(rendered, `**${EVENT_TITLE}**\nA conference in Sofia.`);
  });

  it("returns an empty string when there is neither title nor content", () => {
    assert.equal(renderFeedItemContent(item({ title: null, content: null })), "");
  });
});

describe("source-content — primary source framing", () => {
  it("keeps the article framing byte-identical for RSS", () => {
    // Changing this text changes generation on the RSS and cron paths.
    const framing = framePrimarySource(item({ sourceType: "rss" }));

    assert.equal(
      framing.heading,
      "**PRIMARY SOURCE ARTICLE — the post MUST be based on THIS article and no other.**"
    );
    assert.equal(
      framing.instruction,
      "The topic, facts, and angle of the post must come from this article. A link to this exact article will be attached to the post, so the post text must be about it."
    );
  });

  it("keeps the article framing for a product page, which really is a linkable page", () => {
    assert.equal(
      framePrimarySource(item({ sourceType: "product_page" })).heading,
      framePrimarySource(item({ sourceType: "rss" })).heading
    );
  });

  it("uses article framing for an item whose source type is unknown", () => {
    assert.equal(
      framePrimarySource(item({ sourceType: undefined })).heading,
      framePrimarySource(item({ sourceType: "rss" })).heading
    );
  });

  it("calls a calendar event an event, and promises no link", () => {
    // Its url is `event:<id>` — a storage key that is never appended, so the
    // article framing told the model two false things about its own source.
    const framing = framePrimarySource(item());

    assert.ok(framing.heading.includes("CALENDAR EVENT"));
    assert.ok(!framing.heading.includes("ARTICLE"));
    assert.ok(
      !framing.instruction.includes("link"),
      "no link is attached for an event — do not claim one"
    );
    assert.ok(framing.instruction.includes("product launch"), "the observed misreading is named");
  });

  it("calls a prompt source a brief, and promises no link", () => {
    const framing = framePrimarySource(item({ sourceType: "prompt" }));

    assert.ok(framing.heading.includes("CONTENT BRIEF"));
    assert.ok(!framing.instruction.includes("link"));
  });
});

describe("source-content — sourceExtractionInstruction", () => {
  function pageItem(stored: Record<string, unknown>, sourceType = "product_page"): FeedItemContext {
    return item({ content: JSON.stringify(stored), sourceType, consumable: true });
  }

  it("returns the instruction a product page carries", () => {
    assert.equal(
      sourceExtractionInstruction(pageItem({ instructions: "List every event." })),
      "List every event."
    );
  });

  it("is null for a product page without one", () => {
    assert.equal(sourceExtractionInstruction(pageItem({ description: "A page." })), null);
  });

  it("is null for every other source type, even if the JSON has the key", () => {
    // Only a product page can carry one, so a stray key on another type must not
    // silently switch that source into instruction mode.
    assert.equal(
      sourceExtractionInstruction(pageItem({ instructions: "List every event." }, "rss")),
      null
    );
  });

  it("is null for a missing item, unparseable content, or a blank instruction", () => {
    assert.equal(sourceExtractionInstruction(null), null);
    assert.equal(
      sourceExtractionInstruction(item({ content: "not json", sourceType: "product_page" })),
      null
    );
    assert.equal(sourceExtractionInstruction(pageItem({ instructions: "   " })), null);
  });
});

describe("source-content — an extracted product page is the authoritative source", () => {
  const EXTRACTED = [
    "Next week: 17–23 August 2026",
    "Total events: 2",
    "1. Energy Update — Webinar — 18.08.2026 — Online — Free",
    "2. HR Masterclass — Masterclass — 19.08.2026 — In person — Paid, 50 BGN",
  ].join("\n");

  function extractedItem(overrides: Partial<FeedItemContext> = {}): FeedItemContext {
    return item({
      title: "Business events",
      content: JSON.stringify({
        title: "Business events",
        description: "A catalogue of business events.",
        instructions: "Every event next week with type, date and price.",
        pageText: "RAW PAGE TEXT that the model must no longer have to read",
      }),
      url: "https://events.example.com/?week=current",
      sourceType: "product_page",
      consumable: true,
      extractedContent: EXTRACTED,
      extractionStatus: "completed",
      ...overrides,
    });
  }

  it("renders the extracted facts, complete, as the source block", () => {
    const rendered = renderFeedItemContent(extractedItem());

    assert.ok(rendered.includes("Energy Update"));
    assert.ok(rendered.includes("HR Masterclass"));
    assert.ok(rendered.includes("50 BGN"));
    assert.ok(rendered.includes("Total events: 2"));
  });

  it("does NOT also hand over the raw page for the model to re-interpret", () => {
    // The architectural point: extraction happened once, at ingestion. Showing the
    // page as well invites each channel to derive its own list and disagree.
    const rendered = renderFeedItemContent(extractedItem());

    assert.ok(!rendered.includes("RAW PAGE TEXT"));
  });

  it("gives every channel byte-identical source facts", () => {
    // Nothing in the rendering depends on the channel — the facts are a property
    // of the feed item, so a Facebook version and a LinkedIn version of one topic
    // cannot disagree about how many events there were.
    const facts = extractedItem();

    assert.equal(renderFeedItemContent(facts), renderFeedItemContent({ ...facts }));
  });

  it("survives the default per-item budget — a list is not truncated to an excerpt", () => {
    const long = Array.from({ length: 40 }, (_, i) => `${i + 1}. Event ${i + 1} — Webinar — Free`);
    const rendered = renderFeedItemContent(extractedItem({ extractedContent: long.join("\n") }));

    assert.ok(rendered.includes("40. Event 40"), "the tail of the list must reach the prompt");
  });

  it("forbids adding to or dropping from the extracted set", () => {
    const rendered = renderFeedItemContent(extractedItem());

    assert.match(rendered, /Do not add an item, a date, a price or a category that is not listed/);
    assert.match(rendered, /do not drop one to save space/);
  });

  it("falls back to the raw page while extraction is still queued", () => {
    // Not a second design — it keeps generation possible before the worker has
    // run, at the cost of the model doing the reading itself.
    const rendered = renderFeedItemContent(
      extractedItem({ extractionStatus: "pending", extractedContent: null })
    );

    assert.ok(rendered.includes("RAW PAGE TEXT"));
    assert.match(rendered, /WHAT TO TAKE FROM THIS PAGE/);
  });

  it("says plainly that nothing was found, and shows no page to invent from", () => {
    // A `week=current` page against a "next week" instruction.
    const rendered = renderFeedItemContent(
      extractedItem({ extractionStatus: "not_found", extractedContent: null })
    );

    assert.match(rendered, /found NOTHING on this page matching that instruction/);
    assert.match(rendered, /Do not invent any/);
    assert.ok(!rendered.includes("RAW PAGE TEXT"), "no page text to mine for a plausible answer");
  });

  it("falls back to the raw page when the extraction failed, rather than to nothing", () => {
    // `failed` is neither a settled empty answer nor a fact set. Treating it like
    // `not_found` would tell the model there is nothing on a page that is full.
    const rendered = renderFeedItemContent(
      extractedItem({ extractionStatus: "failed", extractedContent: null })
    );

    assert.ok(rendered.includes("RAW PAGE TEXT"));
    assert.ok(!rendered.includes("found NOTHING on this page"));
  });

  it("leaves a product page with no instruction completely unchanged", () => {
    const rendered = renderFeedItemContent(
      item({
        title: "Pro Plan",
        content: JSON.stringify({
          title: "Pro Plan",
          description: "Everything in Starter, plus SSO.",
          image: "https://cdn.example.com/og.png",
        }),
        url: "https://shop.example.com/pro-plan",
        sourceType: "product_page",
        consumable: true,
      })
    );

    assert.equal(rendered, "**Pro Plan**\nProduct page.\nEverything in Starter, plus SSO.");
  });
});

describe("source-content — the structured extraction reaches the prompt whole", () => {
  /** Twenty items with five fields each — a real catalogue, rendered as stored. */
  const CATALOGUE = renderExtraction({
    requestedFields: ["type", "date", "format", "price status", "price"],
    items: Array.from({ length: 20 }, (_, i) => ({
      label: `Event ${i + 1}`,
      fields: {
        type: i % 2 === 0 ? "Webinar" : "Masterclass",
        date: `${String(i + 1).padStart(2, "0")}.09.2026`,
        format: i % 3 === 0 ? "Online" : "In person",
        "price status": i % 4 === 0 ? "Free" : "Paid",
        price: i % 4 === 0 ? "not stated" : `${(i + 1) * 10} BGN`,
      },
    })),
    sourceStatedCount: 20,
    notes: null,
  });

  const catalogueItem: FeedItemContext = item({
    title: "Business events",
    content: JSON.stringify({
      instructions: "Every event with type, date, format and price.",
      pageText: "RAW",
    }),
    url: "https://events.example.com/",
    sourceType: "product_page",
    consumable: true,
    extractionStatus: "completed",
    extractedContent: CATALOGUE,
  });

  it("carries the last item as well as the first", () => {
    // The budget was raised with the structured rendering for exactly this: the
    // same twenty events take roughly three times the characters when every
    // requested field is on its own line.
    const rendered = renderFeedItemContent(catalogueItem);

    assert.ok(rendered.includes("1. Event 1"));
    assert.ok(rendered.includes("20. Event 20"), "the tail of a real catalogue must survive");
    assert.ok(rendered.includes("200 BGN"));
  });

  it("carries the computed totals the generator is meant to state", () => {
    const rendered = renderFeedItemContent(catalogueItem);

    assert.match(rendered, /Total items extracted: 20/);
    assert.match(rendered, /price status — Paid: 15, Free: 5/);
  });

  it("carries a field the page did not state as unstated, not as a gap", () => {
    const rendered = renderFeedItemContent(catalogueItem);

    assert.match(rendered, /price: not stated/);
  });
});

describe("source-content — extractionFoundNothing", () => {
  it("is true only for a product page whose extraction came back empty", () => {
    assert.equal(
      extractionFoundNothing(item({ sourceType: "product_page", extractionStatus: "not_found" })),
      true
    );
    assert.equal(
      extractionFoundNothing(item({ sourceType: "product_page", extractionStatus: "completed" })),
      false
    );
    assert.equal(
      extractionFoundNothing(item({ sourceType: "rss", extractionStatus: "not_found" })),
      false
    );
    assert.equal(extractionFoundNothing(null), false);
  });
});
