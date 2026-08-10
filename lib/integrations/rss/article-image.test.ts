import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  pickSourceImage,
  resolveImageUrl,
  selectContentImage,
  selectMetaImage,
} from "./article-image";

const BASE = "https://example.com/news/story";

function doc(head: string): Document {
  return new JSDOM(`<html><head>${head}</head><body></body></html>`, { url: BASE }).window.document;
}

// ─── resolveImageUrl — what we refuse to persist ──────────────────────────────

describe("resolveImageUrl — scheme and shape", () => {
  it("resolves a relative address against the article URL", () => {
    assert.equal(
      resolveImageUrl("/img/lead.jpg", BASE),
      "https://example.com/img/lead.jpg",
      "a relative og:image must become absolute before it is stored"
    );
  });

  it("keeps an absolute address on another host", () => {
    assert.equal(
      resolveImageUrl("https://cdn.example.net/lead.jpg", BASE),
      "https://cdn.example.net/lead.jpg"
    );
  });

  it("rejects a data: URI", () => {
    // Storing one would put a whole inline image in the database column and
    // there would be nothing to fetch later.
    assert.equal(resolveImageUrl("data:image/png;base64,iVBORw0KGgo=", BASE), null);
  });

  it("rejects javascript: and file: URLs", () => {
    assert.equal(resolveImageUrl("javascript:alert(1)", BASE), null);
    assert.equal(resolveImageUrl("file:///etc/passwd", BASE), null);
  });

  it("rejects an empty or whitespace-only value", () => {
    assert.equal(resolveImageUrl("", BASE), null);
    assert.equal(resolveImageUrl("   ", BASE), null);
    assert.equal(resolveImageUrl(null, BASE), null);
    assert.equal(resolveImageUrl(undefined, BASE), null);
  });

  it("rejects a relative address when there is no base to resolve it against", () => {
    assert.equal(resolveImageUrl("/img/lead.jpg", null), null);
  });
});

describe("resolveImageUrl — junk rejection", () => {
  const junk = [
    ["a favicon", "https://example.com/favicon.png"],
    ["a site logo", "https://example.com/assets/logo.png"],
    ["a logo in its own directory", "https://example.com/logo/header.png"],
    ["an author avatar", "https://example.com/avatar/bob.jpg"],
    ["a gravatar", "https://example.com/gravatar/abc.jpg"],
    ["a sprite sheet", "https://example.com/img/sprite.png"],
    ["a tracking pixel", "https://example.com/img/pixel.gif"],
    ["a share-button icon", "https://example.com/icon-twitter.png"],
    ["a placeholder", "https://example.com/placeholder.jpg"],
    ["an SVG (always a logo)", "https://example.com/img/brand.svg"],
    ["a 1x1 spacer", "https://example.com/img/1x1.gif"],
    ["a declared 64px thumbnail", "https://example.com/img/lead.jpg?w=64&h=64"],
    ["a 100x100 crop in the path", "https://example.com/img/100x100/lead.jpg"],
  ] as const;

  for (const [label, url] of junk) {
    it(`rejects ${label}`, () => {
      assert.equal(
        resolveImageUrl(url, BASE),
        null,
        `${url} should not be treated as an article image`
      );
    });
  }

  it("does not reject an article image whose path merely contains a junk word inside another word", () => {
    // /blog/ contains "log" but not "logo"; "logout-guide" is a headline slug.
    assert.equal(
      resolveImageUrl("https://example.com/blog/logout-guide-hero.jpg", BASE),
      "https://example.com/blog/logout-guide-hero.jpg"
    );
  });

  it("keeps a large image that declares its size", () => {
    assert.equal(
      resolveImageUrl("https://example.com/img/lead.jpg?w=1200&h=630", BASE),
      "https://example.com/img/lead.jpg?w=1200&h=630"
    );
  });

  it("keeps an image that declares no size at all", () => {
    // The common case — absence of a size hint must never be read as "small".
    assert.equal(
      resolveImageUrl("https://example.com/img/lead.jpg", BASE),
      "https://example.com/img/lead.jpg"
    );
  });
});

// ─── pickSourceImage — the priority ingestion applies ─────────────────────────

describe("pickSourceImage — candidate priority", () => {
  const META = "https://example.com/og.jpg";
  const FEED = "https://example.com/enclosure.jpg";
  const CONTENT = "https://example.com/body.jpg";

  it("prefers the publisher's declared image over everything else", () => {
    assert.equal(
      pickSourceImage({ metaImageUrl: META, feedImageUrl: FEED, contentImageUrl: CONTENT }),
      META
    );
  });

  it("falls back to the feed's own attachment when the page declared nothing", () => {
    assert.equal(
      pickSourceImage({ metaImageUrl: null, feedImageUrl: FEED, contentImageUrl: CONTENT }),
      FEED
    );
  });

  it("uses an in-content image only when nothing was nominated", () => {
    assert.equal(
      pickSourceImage({ metaImageUrl: null, feedImageUrl: null, contentImageUrl: CONTENT }),
      CONTENT
    );
  });

  it("returns null when the article has no usable image anywhere", () => {
    assert.equal(pickSourceImage({}), null);
    assert.equal(
      pickSourceImage({ metaImageUrl: null, feedImageUrl: null, contentImageUrl: null }),
      null
    );
  });
});

// ─── selectMetaImage — priority ───────────────────────────────────────────────

describe("selectMetaImage — priority order", () => {
  it("prefers og:image over twitter:image", () => {
    const d = doc(`
      <meta property="og:image" content="https://example.com/og.jpg">
      <meta name="twitter:image" content="https://example.com/twitter.jpg">
    `);
    assert.equal(selectMetaImage(d, BASE), "https://example.com/og.jpg");
  });

  it("prefers og:image:secure_url over plain og:image", () => {
    const d = doc(`
      <meta property="og:image" content="http://example.com/insecure.jpg">
      <meta property="og:image:secure_url" content="https://example.com/secure.jpg">
    `);
    assert.equal(selectMetaImage(d, BASE), "https://example.com/secure.jpg");
  });

  it("falls back to twitter:image when there is no og:image", () => {
    const d = doc(`<meta name="twitter:image" content="https://example.com/twitter.jpg">`);
    assert.equal(selectMetaImage(d, BASE), "https://example.com/twitter.jpg");
  });

  it("accepts twitter:image:src, the older card spelling", () => {
    const d = doc(`<meta name="twitter:image:src" content="https://example.com/card.jpg">`);
    assert.equal(selectMetaImage(d, BASE), "https://example.com/card.jpg");
  });

  it("reads og:image declared with name= instead of property=", () => {
    // Plenty of CMSes get this wrong; the image is still the publisher's choice.
    const d = doc(`<meta name="og:image" content="https://example.com/og.jpg">`);
    assert.equal(selectMetaImage(d, BASE), "https://example.com/og.jpg");
  });

  it("falls through to JSON-LD when og and twitter are absent", () => {
    const d = doc(`
      <script type="application/ld+json">
        {"@type":"NewsArticle","image":"https://example.com/jsonld.jpg"}
      </script>
    `);
    assert.equal(selectMetaImage(d, BASE), "https://example.com/jsonld.jpg");
  });

  it("reads JSON-LD image given as an object or an array", () => {
    const asObject = doc(`
      <script type="application/ld+json">
        {"@type":"Article","image":{"@type":"ImageObject","url":"https://example.com/obj.jpg"}}
      </script>
    `);
    assert.equal(selectMetaImage(asObject, BASE), "https://example.com/obj.jpg");

    const asArray = doc(`
      <script type="application/ld+json">
        {"@type":"Article","image":["https://example.com/first.jpg","https://example.com/second.jpg"]}
      </script>
    `);
    assert.equal(selectMetaImage(asArray, BASE), "https://example.com/first.jpg");
  });

  it("digs into an @graph wrapper", () => {
    const d = doc(`
      <script type="application/ld+json">
        {"@graph":[{"@type":"WebSite"},{"@type":"BlogPosting","image":"https://example.com/graph.jpg"}]}
      </script>
    `);
    assert.equal(selectMetaImage(d, BASE), "https://example.com/graph.jpg");
  });

  it("prefers an Article block's image over a non-Article one", () => {
    const d = doc(`
      <script type="application/ld+json">
        {"@graph":[
          {"@type":"Organization","image":"https://example.com/org.jpg"},
          {"@type":"NewsArticle","image":"https://example.com/article.jpg"}
        ]}
      </script>
    `);
    assert.equal(selectMetaImage(d, BASE), "https://example.com/article.jpg");
  });

  it("survives malformed JSON-LD without throwing", () => {
    const d = doc(`
      <script type="application/ld+json">{ this is not json </script>
      <meta property="og:image" content="https://example.com/og.jpg">
    `);
    assert.equal(selectMetaImage(d, BASE), "https://example.com/og.jpg");
  });

  it("skips a rejected og:image and takes the next usable candidate", () => {
    // A site whose og:image is its logo still has a real Twitter card image.
    const d = doc(`
      <meta property="og:image" content="https://example.com/assets/logo.png">
      <meta name="twitter:image" content="https://example.com/lead.jpg">
    `);
    assert.equal(selectMetaImage(d, BASE), "https://example.com/lead.jpg");
  });

  it("returns null when the page declares nothing", () => {
    assert.equal(selectMetaImage(doc(`<title>Story</title>`), BASE), null);
  });
});

// ─── selectContentImage — the last resort ─────────────────────────────────────

describe("selectContentImage — in-content fallback", () => {
  it("takes the first substantial image in the article body", () => {
    const html = `<div><p>Text</p><img src="https://example.com/body-lead.jpg"></div>`;
    assert.equal(selectContentImage(html, BASE), "https://example.com/body-lead.jpg");
  });

  it("skips an image that declares a small size", () => {
    const html = `
      <img src="https://example.com/inline-small.jpg" width="80" height="80">
      <img src="https://example.com/body-lead.jpg">
    `;
    assert.equal(selectContentImage(html, BASE), "https://example.com/body-lead.jpg");
  });

  it("prefers data-src over a lazy-loading placeholder in src", () => {
    const html = `<img src="/img/placeholder.gif" data-src="https://example.com/real.jpg">`;
    assert.equal(selectContentImage(html, BASE), "https://example.com/real.jpg");
  });

  it("reads the first entry of a srcset", () => {
    const html = `<img srcset="https://example.com/w800.jpg 800w, https://example.com/w1600.jpg 1600w">`;
    assert.equal(selectContentImage(html, BASE), "https://example.com/w800.jpg");
  });

  it("resolves a relative src against the article URL", () => {
    assert.equal(
      selectContentImage(`<img src="/img/body.jpg">`, BASE),
      "https://example.com/img/body.jpg"
    );
  });

  it("returns null for a body with no images, or no body at all", () => {
    assert.equal(selectContentImage(`<p>Just words.</p>`, BASE), null);
    assert.equal(selectContentImage(null, BASE), null);
  });

  it("returns null when every image in the body is junk", () => {
    const html = `<img src="/img/icon-share.png"><img src="/img/avatar.jpg">`;
    assert.equal(selectContentImage(html, BASE), null);
  });
});
