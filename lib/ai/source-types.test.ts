import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hasPublicUrl, publicUrlOf, resolveItemPublicUrl } from "./source-types";
import type { FeedItemContext } from "./types";

const EVENT_URL = "https://www.events.dev.bg/allinone/2026";
const SYNTHETIC = "event:96c4827f-3fa0-44d1-ad01-7777aaae3787";

function item(overrides: Partial<FeedItemContext> = {}): FeedItemContext {
  return {
    id: "item-1",
    title: "DEV.BG All in One 2026",
    content: null,
    url: SYNTHETIC,
    publishedAt: null,
    sourceType: "calendar_event",
    ...overrides,
  };
}

describe("publicUrlOf", () => {
  it("returns the resolved public url when the context set one", () => {
    assert.equal(publicUrlOf(item({ publicUrl: EVENT_URL })), EVENT_URL);
  });

  it("returns null when the context resolved no public url", () => {
    // An explicit null means "this source has no page" — it must NOT fall back
    // to `url`, which for a calendar event is the internal key.
    assert.equal(publicUrlOf(item({ publicUrl: null })), null);
  });

  it("falls back to `url` when the field is absent entirely", () => {
    // A context built before publicUrl existed, or a test fixture. Every article
    // path must keep behaving exactly as it did.
    assert.equal(
      publicUrlOf({ url: "https://news.example.com/a" } as FeedItemContext),
      "https://news.example.com/a"
    );
  });

  it("never returns a synthetic key, whichever branch it takes", () => {
    assert.equal(publicUrlOf(item()), null, "absent publicUrl + event: url");
    assert.equal(
      publicUrlOf(item({ url: "prompt:src-1" })),
      null,
      "absent publicUrl + prompt: url"
    );
    assert.equal(publicUrlOf(item({ publicUrl: SYNTHETIC })), null, "even if handed one directly");
  });

  it("rejects a non-http scheme", () => {
    assert.equal(publicUrlOf(item({ publicUrl: "javascript:alert(1)" })), null);
    assert.equal(publicUrlOf(item({ publicUrl: "ftp://files.example.com" })), null);
  });

  it("trims surrounding whitespace", () => {
    assert.equal(publicUrlOf(item({ publicUrl: `  ${EVENT_URL}  ` })), EVENT_URL);
  });
});

describe("resolveItemPublicUrl", () => {
  it("takes a calendar event's Event URL from its source config", () => {
    assert.equal(resolveItemPublicUrl(SYNTHETIC, { title: "x", url: EVENT_URL }), EVENT_URL);
  });

  it("returns null for a calendar event with no Event URL configured", () => {
    // Existing calendar sources, which predate the field.
    assert.equal(resolveItemPublicUrl(SYNTHETIC, { title: "x", date: "2026-08-29" }), null);
  });

  it("prefers the item's own url over the source config", () => {
    // Decisive for RSS: config.url is the FEED address, never the article's. If
    // the config won, every article would link to the feed xml.
    assert.equal(
      resolveItemPublicUrl("https://news.example.com/article-1", {
        url: "https://news.example.com/feed.xml",
      }),
      "https://news.example.com/article-1"
    );
  });

  it("returns a product page's own url", () => {
    assert.equal(
      resolveItemPublicUrl("https://shop.example.com/pro", { url: "https://shop.example.com/pro" }),
      "https://shop.example.com/pro"
    );
  });

  it("returns null for a prompt source, which has no page at all", () => {
    assert.equal(resolveItemPublicUrl("prompt:src-1", { promptText: "Write about X." }), null);
  });

  it("ignores a config url that is not http(s)", () => {
    assert.equal(resolveItemPublicUrl(SYNTHETIC, { url: "javascript:alert(1)" }), null);
    assert.equal(resolveItemPublicUrl(SYNTHETIC, { url: "mailto:hi@example.com" }), null);
  });

  it("survives a missing, null, or oddly shaped config", () => {
    assert.equal(resolveItemPublicUrl(SYNTHETIC, null), null);
    assert.equal(resolveItemPublicUrl(SYNTHETIC, undefined), null);
    assert.equal(resolveItemPublicUrl(SYNTHETIC, "not an object"), null);
    assert.equal(resolveItemPublicUrl(SYNTHETIC, { url: 42 }), null);
  });
});

describe("hasPublicUrl", () => {
  it("accepts http and https only", () => {
    assert.equal(hasPublicUrl("http://example.com"), true);
    assert.equal(hasPublicUrl("HTTPS://example.com"), true);
    assert.equal(hasPublicUrl("event:abc"), false);
    assert.equal(hasPublicUrl("prompt:abc"), false);
    assert.equal(hasPublicUrl(null), false);
    assert.equal(hasPublicUrl(undefined), false);
    assert.equal(hasPublicUrl(""), false);
  });
});
