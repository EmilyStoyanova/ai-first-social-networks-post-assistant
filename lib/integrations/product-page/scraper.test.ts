import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractPageText, PAGE_TEXT_LIMIT } from "./scraper";

const LISTING_PAGE = `
<!doctype html>
<html>
  <head>
    <title>Business events</title>
    <meta name="description" content="A catalogue of business events." />
    <script>window.__DATA__ = {"noise": true};</script>
    <style>.card { color: red }</style>
  </head>
  <body>
    <nav><a href="/">Home</a><a href="/about">About</a></nav>
    <h1>Events this week</h1>
    <ul>
      <li>Digital Marketing Summit &mdash; 14.08.2026, Sofia Tech Park</li>
      <li>HR Meetup &#8212; 16.08.2026, Betahaus</li>
    </ul>
    <footer>&copy; 2026 Catalogue</footer>
  </body>
</html>
`;

describe("product-page scraper — extractPageText", () => {
  it("keeps the list a catalogue page consists of", () => {
    // The reason this does not use Readability (the RSS path's extractor):
    // Readability prunes lists and cards as boilerplate, which on a listing page
    // is the entire content.
    const text = extractPageText(LISTING_PAGE);

    assert.ok(text);
    assert.ok(text.includes("Digital Marketing Summit"));
    assert.ok(text.includes("HR Meetup"));
    assert.ok(text.includes("Sofia Tech Park"));
  });

  it("drops scripts, styles, and site chrome", () => {
    const text = extractPageText(LISTING_PAGE) ?? "";

    assert.ok(!text.includes("__DATA__"), "script contents must not reach the prompt");
    assert.ok(!text.includes("color: red"), "style contents must not reach the prompt");
    assert.ok(!text.includes("About"), "navigation must not reach the prompt");
    assert.ok(!text.includes("Catalogue"), "footer must not reach the prompt");
  });

  it("leaves no markup behind", () => {
    const text = extractPageText(LISTING_PAGE) ?? "";

    assert.ok(!text.includes("<"));
    assert.ok(!text.includes(">"));
  });

  it("decodes named and numeric entities", () => {
    const text = extractPageText(LISTING_PAGE) ?? "";

    assert.ok(text.includes("Digital Marketing Summit — 14.08.2026"));
    assert.ok(text.includes("HR Meetup — 16.08.2026"));
    assert.ok(!text.includes("&mdash;"));
  });

  it("puts each list item on its own line rather than running them together", () => {
    // Two events on one line read as one event with two dates.
    const text = extractPageText(LISTING_PAGE) ?? "";
    const lines = text.split("\n");

    assert.ok(
      lines.some((l) => l.includes("Digital Marketing Summit") && !l.includes("HR Meetup"))
    );
  });

  it("collapses non-breaking spaces so lines are not padded with them", () => {
    const text = extractPageText("<body><p>Sofia&nbsp;&nbsp;Tech&#160;Park</p></body>") ?? "";

    assert.equal(text, "Sofia Tech Park");
  });

  it("returns null for a page with no readable text", () => {
    assert.equal(extractPageText("<html><head><title>x</title></head><body></body></html>"), null);
  });

  it("truncates at the storage cap so one page cannot inflate a row without limit", () => {
    const long = `<body><p>${"a".repeat(PAGE_TEXT_LIMIT + 500)}</p></body>`;

    const text = extractPageText(long) ?? "";

    assert.equal(text.length, PAGE_TEXT_LIMIT + 1); // + the ellipsis
    assert.ok(text.endsWith("…"));
  });

  it("honours a caller-supplied limit", () => {
    assert.equal(extractPageText("<body><p>abcdefghij</p></body>", 4), "abcd…");
  });
});
