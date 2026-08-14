import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractPageText,
  PAGE_TEXT_LIMIT,
  PAGE_TEXT_TRUNCATION_MARKER,
  pageTextWasTruncated,
} from "./scraper";

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

/**
 * The shape a real listing page has, and the one the old chain of replacements
 * could not read: every card is an <article> that keeps its name in a <header>
 * and its price in a <footer>, exactly as HTML5 intends.
 */
const CARD_PAGE = `
<!doctype html>
<html>
  <body>
    <header class="site"><a href="/">Catalogue</a><span>Sign in</span></header>
    <form class="filters"><label>Search</label><input name="q" /><button>Go</button></form>
    <main>
      <h1>This week</h1>
      <article class="card">
        <header><h3>Energy Update</h3><span class="badge">Webinar</span></header>
        <p>18.08.2026, 18:00 — Online</p>
        <footer><span class="price">Free</span></footer>
      </article>
      <article class="card">
        <header><h3>HR Masterclass</h3><span class="badge">Masterclass</span></header>
        <p>19.08.2026, 10:00 — Betahaus, Sofia</p>
        <footer><span class="price">50 BGN</span><aside class="note">Members only</aside></footer>
      </article>
    </main>
    <aside class="promo">Subscribe to our newsletter</aside>
    <footer class="site">&copy; 2026 Catalogue</footer>
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
});

describe("product-page scraper — a card is not chrome", () => {
  it("keeps the name a card holds in its own <header>", () => {
    // The first root cause: <header> was stripped wherever it appeared, and a
    // card-based listing keeps the item's NAME there. Every event survived as a
    // date and a price with nothing to call it.
    const text = extractPageText(CARD_PAGE) ?? "";

    assert.ok(text.includes("Energy Update"), "the first card's name must survive");
    assert.ok(text.includes("HR Masterclass"), "the second card's name must survive");
  });

  it("keeps the label a card holds in its own <footer> or <aside>", () => {
    const text = extractPageText(CARD_PAGE) ?? "";

    assert.ok(text.includes("Free"), "a price status in a card footer must survive");
    assert.ok(text.includes("50 BGN"), "a price in a card footer must survive");
    assert.ok(text.includes("Members only"), "a note in a card aside must survive");
  });

  it("keeps the category badge that says what kind of item it is", () => {
    const text = extractPageText(CARD_PAGE) ?? "";

    assert.ok(text.includes("Webinar"));
    assert.ok(text.includes("Masterclass"));
  });

  it("still drops the same elements when they belong to the page", () => {
    const text = extractPageText(CARD_PAGE) ?? "";

    assert.ok(!text.includes("Sign in"), "the site header is still chrome");
    assert.ok(!text.includes("Subscribe"), "a page-level aside is still chrome");
    assert.ok(!text.includes("© 2026"), "the site footer is still chrome");
    assert.ok(!text.includes("Search"), "a page-level filter form is still chrome");
  });

  it("keeps every card on the page, in order", () => {
    // If the page contains N items, all N must reach extraction.
    const text = extractPageText(CARD_PAGE) ?? "";

    assert.ok(text.indexOf("Energy Update") < text.indexOf("HR Masterclass"));
  });

  it("puts each card's fields on separate lines rather than one run-on string", () => {
    const lines = (extractPageText(CARD_PAGE) ?? "").split("\n");

    assert.ok(lines.some((l) => l.includes("Energy Update") && !l.includes("HR Masterclass")));
    assert.ok(lines.some((l) => l.includes("18.08.2026")));
  });

  it("is not confused by comparison operators inside a script", () => {
    // `a < b && c > d` tokenises as an element. Before the raw-text skip, that
    // opened phantom elements that swallowed the content after them.
    const html = `
      <body>
        <script>if (a < b && c > d) { render(); }</script>
        <article><header><h3>Energy Update</h3></header><p>Free</p></article>
      </body>`;
    const text = extractPageText(html) ?? "";

    assert.ok(text.includes("Energy Update"));
    assert.ok(text.includes("Free"));
    assert.ok(!text.includes("render()"));
  });

  it("recovers from unclosed tags instead of dropping the rest of the page", () => {
    const html = `
      <body>
        <main>
          <article><header><h3>First
          <article><header><h3>Second</h3></header><p>20 EUR</p></article>
        </main>
      </body>`;
    const text = extractPageText(html) ?? "";

    assert.ok(text.includes("First"));
    assert.ok(text.includes("Second"));
    assert.ok(text.includes("20 EUR"));
  });
});

describe("product-page scraper — truncation", () => {
  it("has a budget large enough for a full listing page", () => {
    // Roughly two hundred cards of five fields each. The old 8 000 held about
    // forty, and cut the rest off without saying so.
    assert.ok(PAGE_TEXT_LIMIT >= 40_000);
  });

  it("says so in the text when it has to cut a page short", () => {
    const long = `<body><p>${"a".repeat(PAGE_TEXT_LIMIT + 500)}</p></body>`;

    const text = extractPageText(long) ?? "";

    assert.ok(text.endsWith(PAGE_TEXT_TRUNCATION_MARKER));
    assert.ok(pageTextWasTruncated(text));
  });

  it("leaves an untruncated page unmarked", () => {
    const text = extractPageText(LISTING_PAGE);

    assert.equal(pageTextWasTruncated(text), false);
  });

  it("cuts on a line boundary so no half-item is left looking whole", () => {
    // A card sliced through the middle reads as a complete card with most of its
    // fields missing — which extraction would then report as "not stated".
    const items = Array.from(
      { length: 40 },
      (_, i) => `<li>Event ${i} — 1${i}.08.2026 — Sofia — ${i * 10} BGN</li>`
    ).join("");
    const limit = 300;

    const text = extractPageText(`<body><ul>${items}</ul></body>`, limit) ?? "";
    const [, ...body] = text.split("\n").reverse();

    assert.ok(pageTextWasTruncated(text));
    for (const line of body) {
      assert.match(line, /^Event \d+ — \d+\.08\.2026 — Sofia — \d+ BGN$/, `half a line: ${line}`);
    }
  });

  it("honours a caller-supplied limit", () => {
    const text = extractPageText("<body><p>abcdefghij</p></body>", 4) ?? "";

    assert.ok(text.startsWith("abcd"));
    assert.ok(pageTextWasTruncated(text));
  });
});
