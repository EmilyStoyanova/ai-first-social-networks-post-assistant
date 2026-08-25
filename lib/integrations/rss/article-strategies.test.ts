import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  chooseArticleText,
  extractDomArticleBody,
  extractJsonLdArticleBody,
  MIN_ARTICLE_LENGTH,
  type StrategyResult,
} from "./article-strategies";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BASE_URL = "https://example.com/article";

function docOf(html: string): Document {
  return new JSDOM(html, { url: BASE_URL }).window.document;
}

/** How many sentences one `prose()` block repeats by default. */
const PROSE_SENTENCES = 4;

/** Prose long enough to clear MIN_ARTICLE_LENGTH on its own. */
function prose(marker: string, times = PROSE_SENTENCES): string {
  return `${marker} paragraph carrying enough reporting, context and analysis to count as real article text. `.repeat(
    times
  );
}

// ─── JSON-LD strategy ─────────────────────────────────────────────────────────

describe("extractJsonLdArticleBody", () => {
  it("reads articleBody from a plain Article block", () => {
    const body = prose("Main");
    const doc = docOf(`<html><head>
      <script type="application/ld+json">
        ${JSON.stringify({ "@type": "NewsArticle", headline: "H", articleBody: body })}
      </script></head><body></body></html>`);

    const result = extractJsonLdArticleBody(doc);
    assert.ok(result);
    assert.ok(result.includes("Main paragraph carrying enough reporting"));
  });

  it("reads articleBody nested inside an @graph wrapper", () => {
    const body = prose("Graph");
    const doc = docOf(`<html><head>
      <script type="application/ld+json">
        ${JSON.stringify({
          "@context": "https://schema.org",
          "@graph": [{ "@type": "WebPage" }, { "@type": "Article", articleBody: body }],
        })}
      </script></head><body></body></html>`);

    assert.ok(extractJsonLdArticleBody(doc)?.includes("Graph paragraph"));
  });

  it("prefers the LONGEST articleBody when a page declares several", () => {
    // A live-blog stub and the piece itself both describe themselves as
    // articles; only one of them is the body.
    const short = prose("Stub", 4);
    const long = prose("Full", 12);
    const doc = docOf(`<html><head>
      <script type="application/ld+json">${JSON.stringify([
        { "@type": "Article", articleBody: short },
        { "@type": "Article", articleBody: long },
      ])}</script></head><body></body></html>`);

    const result = extractJsonLdArticleBody(doc);
    assert.ok(result?.startsWith("Full paragraph"));
  });

  it("skips a malformed block without losing a valid one", () => {
    const body = prose("Survivor");
    const doc = docOf(`<html><head>
      <script type="application/ld+json">{ not valid json ,,, }</script>
      <script type="application/ld+json">${JSON.stringify({ articleBody: body })}</script>
      </head><body></body></html>`);

    assert.ok(extractJsonLdArticleBody(doc)?.includes("Survivor paragraph"));
  });

  it("rejects an articleBody below the article threshold", () => {
    const doc = docOf(`<html><head>
      <script type="application/ld+json">${JSON.stringify({ articleBody: "Too short." })}</script>
      </head><body></body></html>`);

    assert.equal(extractJsonLdArticleBody(doc), null);
  });

  it("returns null when the page has no JSON-LD at all", () => {
    assert.equal(extractJsonLdArticleBody(docOf("<html><body><p>x</p></body></html>")), null);
  });
});

// ─── DOM traversal strategy ───────────────────────────────────────────────────

describe("extractDomArticleBody", () => {
  it("walks the WHOLE container, not just the first block", () => {
    // The regression this strategy exists for: an article whose body continues
    // through several sibling <section> wrappers at different nesting depths.
    const doc = docOf(`<html><body>
      <article class="article__body">
        <section><p>${prose("First")}</p></section>
        <section><div><div><p>${prose("Second")}</p></div></div></section>
        <section><p>${prose("Third")}</p></section>
      </article>
    </body></html>`);

    const result = extractDomArticleBody(doc);
    assert.ok(result);
    assert.ok(result.includes("First paragraph"), "first section must survive");
    assert.ok(result.includes("Second paragraph"), "deeply nested section must survive");
    assert.ok(result.includes("Third paragraph"), "last section must survive");
  });

  it("keeps blocks in document order", () => {
    const doc = docOf(`<html><body><article>
      <p>${prose("Alpha")}</p>
      <h2>A heading</h2>
      <p>${prose("Beta")}</p>
    </article></body></html>`);

    const result = extractDomArticleBody(doc) ?? "";
    assert.ok(result.indexOf("Alpha") < result.indexOf("A heading"));
    assert.ok(result.indexOf("A heading") < result.indexOf("Beta"));
  });

  it("excludes nav, aside, footer, newsletter, related and ad blocks", () => {
    const doc = docOf(`<html><body>
      <nav><p>${prose("Navigation")}</p></nav>
      <article class="article-body">
        <p>${prose("Story")}</p>
        <aside><p>${prose("Sidebar")}</p></aside>
        <div class="related-stories"><p>${prose("Related")}</p></div>
        <div class="newsletter-signup"><p>${prose("Newsletter")}</p></div>
        <div class="ad-slot"><p>${prose("Advert")}</p></div>
      </article>
      <footer><p>${prose("Footer")}</p></footer>
    </body></html>`);

    const result = extractDomArticleBody(doc) ?? "";
    assert.ok(result.includes("Story paragraph"), "the article body must survive");
    for (const junk of ["Navigation", "Sidebar", "Related", "Newsletter", "Advert", "Footer"]) {
      assert.ok(!result.includes(`${junk} paragraph`), `${junk} must be excluded`);
    }
  });

  it("does not count a nested block twice", () => {
    const doc = docOf(`<html><body><article>
      <ul><li><p>${prose("Item")}</p></li></ul>
    </article></body></html>`);

    const result = extractDomArticleBody(doc) ?? "";
    const occurrences = result.split("Item paragraph").length - 1;
    assert.equal(
      occurrences,
      PROSE_SENTENCES,
      "the <li> wrapping a <p> must contribute its text once, not twice"
    );
  });

  it("drops short non-heading blocks such as bylines and buttons", () => {
    const doc = docOf(`<html><body><article>
      <p>By Jane Doe</p>
      <p>${prose("Body")}</p>
    </article></body></html>`);

    const result = extractDomArticleBody(doc) ?? "";
    assert.ok(!result.includes("By Jane Doe"));
    assert.ok(result.includes("Body paragraph"));
  });

  it("does not mutate the document it reads", () => {
    // Load-bearing: this runs BEFORE Readability, which is still primary and
    // must be handed the original markup.
    const doc = docOf(`<html><body><article>
      <p>${prose("Body")}</p><aside><p>${prose("Aside")}</p></aside>
    </article></body></html>`);

    extractDomArticleBody(doc);
    assert.equal(doc.querySelectorAll("aside").length, 1, "the live DOM must be untouched");
  });

  it("falls back to an unfamiliar structure via <article>/<main>", () => {
    const doc = docOf(`<html><body><main>
      <div class="wrapper-9f3a"><div><p>${prose("Unfamiliar")}</p></div></div>
    </main></body></html>`);

    assert.ok(extractDomArticleBody(doc)?.includes("Unfamiliar paragraph"));
  });

  it("returns null for a page with no substantial prose", () => {
    const doc = docOf(`<html><body><nav><a href="/">Home</a></nav><p>Hi</p></body></html>`);
    assert.equal(extractDomArticleBody(doc), null);
  });
});

// ─── The preference rule ──────────────────────────────────────────────────────

describe("chooseArticleText", () => {
  const at = (method: StrategyResult["method"], length: number): StrategyResult => ({
    method,
    text: "x".repeat(length),
  });

  it("prefers Readability when every reader found a comparable article", () => {
    const chosen = chooseArticleText([
      at("readability", 5000),
      at("json_ld", 5200),
      at("dom", 4800),
    ]);
    assert.equal(chosen?.method, "readability");
  });

  it("falls back to JSON-LD when Readability found nothing", () => {
    assert.equal(
      chooseArticleText([null, at("json_ld", 5000), at("dom", 4000)])?.method,
      "json_ld"
    );
  });

  it("falls back to DOM when Readability and JSON-LD both found nothing", () => {
    assert.equal(chooseArticleText([null, null, at("dom", 4000)])?.method, "dom");
  });

  it("overrules the preferred reader when another is more than twice as long", () => {
    // The sampled-not-read case: Readability cleared the threshold but returned
    // a fraction of what the publisher's own JSON-LD carries.
    const chosen = chooseArticleText([at("readability", 400), at("json_ld", 9000), null]);
    assert.equal(chosen?.method, "json_ld");
  });

  it("does not overrule on a margin explainable by formatting", () => {
    const chosen = chooseArticleText([at("readability", 5000), at("json_ld", 6000), null]);
    assert.equal(chosen?.method, "readability");
  });

  it("returns null when no reader produced anything", () => {
    assert.equal(chooseArticleText([null, null, null]), null);
  });
});

describe("MIN_ARTICLE_LENGTH", () => {
  it("is the single threshold every strategy is held to", () => {
    assert.equal(MIN_ARTICLE_LENGTH, 300);
  });
});
