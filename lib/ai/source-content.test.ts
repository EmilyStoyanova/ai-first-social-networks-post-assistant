import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatEventDate,
  framePrimarySource,
  renderFeedItemContent,
  INSTRUCTED_PAGE_TEXT_LIMIT,
} from "./source-content";
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
