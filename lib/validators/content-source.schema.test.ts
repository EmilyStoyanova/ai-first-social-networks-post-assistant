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
