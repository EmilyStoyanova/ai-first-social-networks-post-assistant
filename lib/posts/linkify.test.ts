import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitLinks } from "./linkify";

/** The text a segment list renders as — must always equal the input. */
function rendered(text: string): string {
  return splitLinks(text)
    .map((s) => s.value)
    .join("");
}

function urls(text: string) {
  return splitLinks(text).filter((s) => s.type === "url");
}

describe("splitLinks — finding links", () => {
  it("returns text untouched when there is no URL", () => {
    assert.deepEqual(splitLinks("Just a plain post."), [
      { type: "text", value: "Just a plain post." },
    ]);
  });

  it("links a bare https URL and keeps the surrounding words", () => {
    assert.deepEqual(splitLinks("Read https://example.com now"), [
      { type: "text", value: "Read " },
      { type: "url", value: "https://example.com", href: "https://example.com" },
      { type: "text", value: " now" },
    ]);
  });

  it("links a URL that is the whole post", () => {
    assert.deepEqual(splitLinks("https://example.com/a"), [
      { type: "url", value: "https://example.com/a", href: "https://example.com/a" },
    ]);
  });

  it("links every URL in the text, not just the first", () => {
    const found = urls("See https://a.test and https://b.test today");

    assert.deepEqual(
      found.map((s) => s.value),
      ["https://a.test", "https://b.test"]
    );
  });

  it("keeps query strings, fragments and paths in the link", () => {
    const [link] = urls("Source: https://example.com/a/b?utm=x&y=2#top");

    assert.equal(link.value, "https://example.com/a/b?utm=x&y=2#top");
  });

  it("links across newlines without swallowing them", () => {
    const segments = splitLinks("Post body\n\nhttps://example.com");

    assert.deepEqual(segments, [
      { type: "text", value: "Post body\n\n" },
      { type: "url", value: "https://example.com", href: "https://example.com" },
    ]);
  });

  it("handles plain http as well as https", () => {
    const [link] = urls("http://example.com");

    assert.equal(link.href, "http://example.com");
  });
});

describe("splitLinks — www without a scheme", () => {
  it("shows the URL as written but points the href at https", () => {
    const [link] = urls("Visit www.example.com for more");

    // Requirement: the displayed text is never rewritten.
    assert.equal(link.value, "www.example.com");
    // A schemeless href would resolve against the app's own origin.
    assert.equal(link.href, "https://www.example.com");
  });

  it("does not double-prefix a www URL that already has a scheme", () => {
    const [link] = urls("https://www.example.com");

    assert.equal(link.href, "https://www.example.com");
  });
});

describe("splitLinks — punctuation", () => {
  it("leaves a sentence-ending period out of the link", () => {
    assert.deepEqual(splitLinks("Read https://example.com."), [
      { type: "text", value: "Read " },
      { type: "url", value: "https://example.com", href: "https://example.com" },
      { type: "text", value: "." },
    ]);
  });

  it("leaves a trailing comma out of the link", () => {
    const segments = splitLinks("https://example.com, and more");

    assert.equal(segments[0].value, "https://example.com");
    assert.equal(segments[1].value, ", and more");
  });

  it("keeps balanced parentheses inside the link", () => {
    const [link] = urls("https://en.wikipedia.org/wiki/Foo_(bar)");

    assert.equal(link.value, "https://en.wikipedia.org/wiki/Foo_(bar)");
  });

  it("leaves an unbalanced closing parenthesis out of the link", () => {
    const segments = splitLinks("(see https://example.com/a)");

    assert.equal(segments[1].value, "https://example.com/a");
    assert.equal(segments[2].value, ")");
  });

  it("strips a run of trailing punctuation", () => {
    const [link] = urls("Amazing https://example.com?!");

    assert.equal(link.value, "https://example.com");
  });
});

describe("splitLinks — what is deliberately not a link", () => {
  it("ignores prose that merely looks domain-shaped", () => {
    // Linkifying bare domains would turn ordinary copy into broken links.
    assert.deepEqual(urls("We shipped it with Node.js, e.g. last week."), []);
  });

  it("ignores a hashtag", () => {
    assert.deepEqual(urls("#launch #ai"), []);
  });

  it("does not treat a lone 'www.' as a link", () => {
    assert.deepEqual(urls("www. is not a URL"), []);
  });
});

describe("splitLinks — the text is never rewritten", () => {
  const samples = [
    "Read https://example.com.",
    "(see https://example.com/a)",
    "Visit www.example.com for more",
    "Line one\nhttps://a.test\n\nLine three",
    "https://a.test and https://b.test",
    "No links at all",
    "",
    "Node.js e.g. #tag",
    "Amazing https://example.com?!",
  ];

  for (const sample of samples) {
    it(`round-trips ${JSON.stringify(sample)}`, () => {
      // Concatenating the segments must reproduce the post exactly — no URL is
      // ever replaced with a label and no character is dropped.
      assert.equal(rendered(sample), sample);
    });
  }
});
