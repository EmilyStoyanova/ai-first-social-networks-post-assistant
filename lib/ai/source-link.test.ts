import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveIncludeSourceLink, applySourceLink } from "./source-link";

const URL = "https://news.example.com/articles/some-long-slug?utm_source=rss&id=12345";

// ─── resolveIncludeSourceLink ─────────────────────────────────────────────────

describe("resolveIncludeSourceLink", () => {
  it("manual true wins over everything", () => {
    assert.deepEqual(resolveIncludeSourceLink(true, false, false), {
      include: true,
      level: "manual",
    });
  });

  it("manual false overrides source true and channel true", () => {
    assert.deepEqual(resolveIncludeSourceLink(false, true, true), {
      include: false,
      level: "manual",
    });
  });

  it("source true wins when manual is undefined", () => {
    assert.deepEqual(resolveIncludeSourceLink(undefined, true, false), {
      include: true,
      level: "source",
    });
  });

  it("source false overrides channel true", () => {
    assert.deepEqual(resolveIncludeSourceLink(undefined, false, true), {
      include: false,
      level: "source",
    });
  });

  it("falls back to channel default when manual and source are undefined", () => {
    assert.deepEqual(resolveIncludeSourceLink(undefined, undefined, true), {
      include: true,
      level: "channel",
    });
    assert.deepEqual(resolveIncludeSourceLink(undefined, undefined, false), {
      include: false,
      level: "channel",
    });
  });
});

// ─── applySourceLink — appending ──────────────────────────────────────────────

describe("applySourceLink append", () => {
  it("appends the URL exactly once at the end", () => {
    const result = applySourceLink("Great news today!", URL, true, null);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.content, `Great news today! ${URL}`);
      assert.equal(result.appended, true);
      assert.equal(result.content.split(URL).length - 1, 1);
    }
  });

  it("uses a blank-line separator for multiline content", () => {
    const result = applySourceLink("Line one.\nLine two.", URL, true, null);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.content, `Line one.\nLine two.\n\n${URL}`);
  });

  it("keeps the URL byte-for-byte unchanged", () => {
    const result = applySourceLink("Post text", URL, true, null);
    assert.equal(result.ok, true);
    if (result.ok) assert.ok(result.content.endsWith(URL));
  });

  it("does not append when the content already contains the URL", () => {
    const content = `Read more: ${URL}`;
    const result = applySourceLink(content, URL, true, null);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.content, content);
      assert.equal(result.appended, false);
      assert.equal(result.content.split(URL).length - 1, 1);
    }
  });

  it("appends nothing when there is no source URL", () => {
    for (const missing of [null, "", "   "]) {
      const result = applySourceLink("Post text", missing, true, null);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.content, "Post text");
        assert.equal(result.appended, false);
      }
    }
  });
});

// ─── applySourceLink — length limits ──────────────────────────────────────────

describe("applySourceLink length limits", () => {
  it("fails with POST_TOO_LONG_WITH_URL when the URL would exceed the limit", () => {
    const content = "x".repeat(100);
    const result = applySourceLink(content, URL, true, 120);
    assert.deepEqual(result, { ok: false, reason: "POST_TOO_LONG_WITH_URL" });
  });

  it("succeeds when the final content fits exactly", () => {
    const content = "abc";
    const finalLength = content.length + 1 + URL.length; // space separator
    const result = applySourceLink(content, URL, true, finalLength);
    assert.equal(result.ok, true);
  });

  it("skips the length check when maxTextLength is null", () => {
    const content = "x".repeat(10_000);
    const result = applySourceLink(content, URL, true, null);
    assert.equal(result.ok, true);
  });

  it("never truncates the URL — the full URL is present or absent", () => {
    const content = "x".repeat(100);
    const overLimit = applySourceLink(content, URL, true, 130);
    assert.equal(overLimit.ok, false);
    const fits = applySourceLink(content, URL, true, 500);
    assert.equal(fits.ok, true);
    if (fits.ok) assert.ok(fits.content.includes(URL));
  });
});

// ─── applySourceLink — disabled ───────────────────────────────────────────────

describe("applySourceLink disabled", () => {
  it("removes the known source URL when disabled", () => {
    const result = applySourceLink(`Check this out: ${URL}`, URL, false, null);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.ok(!result.content.includes(URL));
      assert.equal(result.content, "Check this out:");
    }
  });

  it("does not remove unrelated URLs such as the company website or CTA links", () => {
    const content = `Visit https://our-company.com and book at https://our-company.com/cta today!`;
    const result = applySourceLink(content, URL, false, null);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.content, content);
  });

  it("removes only the source URL and preserves other URLs in the same post", () => {
    const content = `Read ${URL} then visit https://our-company.com for more.`;
    const result = applySourceLink(content, URL, false, null);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.ok(!result.content.includes(URL));
      assert.ok(result.content.includes("https://our-company.com"));
      assert.equal(result.content, "Read then visit https://our-company.com for more.");
    }
  });

  it("leaves content untouched when disabled and the URL is absent", () => {
    const content = "A post with no links at all.";
    const result = applySourceLink(content, URL, false, null);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.content, content);
  });
});
