import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contentSourceSchema } from "./content-source.schema";

/** A valid calendar-event payload, with `config` overridable per case. */
function calendarEvent(config: Record<string, unknown>) {
  return contentSourceSchema.safeParse({
    type: "calendar_event",
    name: "DEV.BG events",
    config: { title: "DEV.BG All in One 2026", date: "2026-08-29", ...config },
  });
}

describe("content-source schema — calendar event URL", () => {
  it("accepts a calendar event with no URL at all", () => {
    // Every calendar source created before the field existed. The URL is
    // optional and its absence must never invalidate an otherwise good source.
    const result = calendarEvent({});

    assert.ok(result.success, "an event without a URL must stay valid");
    assert.equal(
      result.data.type === "calendar_event" ? result.data.config.url : "unreachable",
      undefined
    );
  });

  it("accepts an https URL", () => {
    const result = calendarEvent({ url: "https://www.events.dev.bg/allinone/2026" });

    assert.ok(result.success);
    assert.equal(
      result.data.type === "calendar_event" ? result.data.config.url : null,
      "https://www.events.dev.bg/allinone/2026"
    );
  });

  it("accepts a plain http URL", () => {
    assert.ok(calendarEvent({ url: "http://events.example.com/2026" }).success);
  });

  it("rejects a URL that is not http(s)", () => {
    // `.url()` alone accepts these — the value is rendered as an href and
    // appended to published posts, so the scheme is checked too.
    for (const url of ["javascript:alert(1)", "mailto:hi@example.com", "ftp://files.example.com"]) {
      assert.equal(calendarEvent({ url }).success, false, `${url} must be rejected`);
    }
  });

  it("rejects a non-URL string", () => {
    assert.equal(calendarEvent({ url: "events.dev.bg" }).success, false);
    assert.equal(calendarEvent({ url: "not a url" }).success, false);
  });

  it("rejects an empty string rather than reading it as 'not set'", () => {
    // The form omits the key when the field is blank; an explicit "" is a
    // malformed payload, not an absent value.
    assert.equal(calendarEvent({ url: "" }).success, false);
  });

  it("still requires a title and a date", () => {
    const noTitle = contentSourceSchema.safeParse({
      type: "calendar_event",
      name: "Events",
      config: { date: "2026-08-29", url: "https://example.com/e" },
    });
    assert.equal(noTitle.success, false);
  });

  it("keeps the optional description alongside the URL", () => {
    const result = calendarEvent({ description: "Six halls, two days.", url: "https://a.example" });

    assert.ok(result.success);
    assert.equal(
      result.data.type === "calendar_event" ? result.data.config.description : null,
      "Six halls, two days."
    );
  });
});

describe("content-source schema — the calendar event's name is the organizer", () => {
  it("still requires it, and says which field it means", () => {
    const result = contentSourceSchema.safeParse({
      type: "calendar_event",
      name: "",
      config: { title: "DEV.BG All in One 2026", date: "2026-08-29" },
    });

    assert.equal(result.success, false);
    const issue = result.success ? null : result.error.issues.find((i) => i.path[0] === "name");
    assert.equal(issue?.message, "Organizer is required.");
  });

  it("accepts an organizer name and keeps it on the same key", () => {
    // Terminology only — the payload key and the column behind it are unchanged.
    const result = calendarEvent({});

    assert.ok(result.success);
    assert.equal(result.data.name, "DEV.BG events");
  });

  it("leaves the other types saying 'Name'", () => {
    const result = contentSourceSchema.safeParse({
      type: "rss",
      name: "",
      config: { url: "https://news.example.com/feed.xml" },
    });

    assert.equal(result.success, false);
    const issue = result.success ? null : result.error.issues.find((i) => i.path[0] === "name");
    assert.equal(issue?.message, "Name is required.");
  });

  it("keeps the 200-character limit", () => {
    assert.equal(
      contentSourceSchema.safeParse({
        type: "calendar_event",
        name: "x".repeat(201),
        config: { title: "T", date: "2026-08-29" },
      }).success,
      false
    );
  });
});

describe("content-source schema — product page extraction instructions", () => {
  function productPage(config: Record<string, unknown>) {
    return contentSourceSchema.safeParse({
      type: "product_page",
      name: "Events this week",
      config: { url: "https://events.example.com/?week=current", ...config },
    });
  }

  it("accepts a product page with no instruction — every source created before it existed", () => {
    const result = productPage({});

    assert.ok(result.success);
    assert.equal(
      result.data.type === "product_page" ? result.data.config.extractionInstructions : "x",
      undefined
    );
  });

  it("keeps the instruction when one is given", () => {
    const result = productPage({ extractionInstructions: "The events listed for this week." });

    assert.ok(result.success);
    assert.equal(
      result.data.type === "product_page" ? result.data.config.extractionInstructions : null,
      "The events listed for this week."
    );
  });

  it("rejects an empty string rather than reading it as 'no instruction'", () => {
    // The form omits the key when the field is blank.
    assert.equal(productPage({ extractionInstructions: "" }).success, false);
  });

  it("caps the instruction at 1000 characters", () => {
    assert.ok(productPage({ extractionInstructions: "x".repeat(1000) }).success);
    assert.equal(productPage({ extractionInstructions: "x".repeat(1001) }).success, false);
  });

  it("still requires a valid page URL alongside it", () => {
    assert.equal(
      contentSourceSchema.safeParse({
        type: "product_page",
        name: "Events",
        config: { extractionInstructions: "The events listed for this week." },
      }).success,
      false
    );
  });
});

describe("content-source schema — other types are unchanged", () => {
  it("still accepts an RSS source", () => {
    assert.ok(
      contentSourceSchema.safeParse({
        type: "rss",
        name: "Econ Daily",
        config: { url: "https://news.example.com/feed.xml" },
      }).success
    );
  });

  it("still accepts a product page", () => {
    assert.ok(
      contentSourceSchema.safeParse({
        type: "product_page",
        name: "Pricing",
        config: { url: "https://shop.example.com/pro" },
      }).success
    );
  });

  it("still accepts a prompt source with no URL key", () => {
    assert.ok(
      contentSourceSchema.safeParse({
        type: "prompt",
        name: "Ideas",
        config: { promptText: "Share one concrete productivity tip." },
      }).success
    );
  });
});

describe("content-source schema — competitor types are never accepted here (Part 3B §2/§25.2)", () => {
  // The generic Content Source API is a company-content surface; competitor
  // sources are created exclusively through the dedicated Competitive
  // Analysis routes/services (§3.7), which validate against
  // competitor-source.schema.ts instead. `type` is a Zod discriminated union
  // over exactly four literals, so a competitor payload fails validation
  // structurally — this pins that guarantee down as a test, not just a
  // consequence of the union happening not to list it.
  for (const type of ["competitor_rss", "competitor_website"]) {
    it(`rejects type "${type}"`, () => {
      const result = contentSourceSchema.safeParse({
        type,
        name: "Competitor feed",
        config: { url: "https://competitor.example.com/feed.xml" },
      });
      assert.equal(result.success, false);
    });
  }

  it("rejects a competitorId on an otherwise-valid RSS payload (the field does not exist on this schema)", () => {
    const result = contentSourceSchema.safeParse({
      type: "rss",
      name: "Econ Daily",
      competitorId: "c-1",
      config: { url: "https://news.example.com/feed.xml" },
    });
    // Zod strips unknown keys by default rather than rejecting them, so the
    // meaningful assertion is that the parsed value never carries the field —
    // nothing downstream can read a `competitorId` off a generic-API payload.
    assert.ok(result.success);
    assert.ok(!("competitorId" in result.data));
  });
});
