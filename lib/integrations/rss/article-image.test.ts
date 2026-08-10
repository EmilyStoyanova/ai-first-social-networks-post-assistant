import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import {
  isGenericImageUrl,
  pickSourceImage,
  resolveImageUrl,
  selectContentImage,
  selectMetaImage,
  srcsetCandidates,
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
    ["a page banner", "https://example.com/img/banner.jpg"],
    ["an ad creative", "https://example.com/ads/summer-sale.jpg"],
    ["an ad in a singular directory", "https://example.com/ad/300x600.jpg"],
    ["a promo strip", "https://example.com/img/promo-newsletter.png"],
    ["a sponsor mark", "https://example.com/img/sponsor-acme.png"],
    ["a related-posts thumbnail", "https://example.com/related/other-story.jpg"],
    ["a share graphic", "https://example.com/img/share.png"],
    ["a widget decoration", "https://example.com/widget/weather.png"],
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

  it("keeps headline slugs that merely contain a new junk word", () => {
    // Each of these embeds "ad", "related" or "share" inside a real word — the
    // short additions to the list are the ones most able to misfire.
    const keep = [
      "https://example.com/2026/roadmap-leaked/hero.jpg",
      "https://example.com/news/shareholders-revolt/lead.jpg",
      "https://example.com/img/unrelatedly-large-photo.jpg",
      "https://example.com/blog/download-numbers/chart.png",
    ];
    for (const url of keep) {
      assert.equal(resolveImageUrl(url, BASE), url, `${url} is a real article image`);
    }
  });

  it("still finds a junk word that appears after an unbounded one", () => {
    // "ad" occurs inside "download" first; the scan must not stop at that hit.
    assert.equal(resolveImageUrl("https://example.com/download/ads/728.jpg", BASE), null);
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

// ─── The site-wide fallback demotion ──────────────────────────────────────────

describe("isGenericImageUrl", () => {
  const generic = [
    "https://example.com/img/default.jpg",
    "https://example.com/assets/default-image.png",
    "https://example.com/img/fallback-hero.jpg",
    "https://example.com/static/og-default.png",
    "https://example.com/img/og-image.jpg",
    "https://example.com/wp-content/uploads/social-card.png",
    "https://example.com/img/no-image.png",
    "https://example.com/opengraph/card.jpg",
  ];
  for (const url of generic) {
    it(`flags ${url.replace("https://example.com", "")}`, () => {
      assert.equal(isGenericImageUrl(url), true);
    });
  }

  it("does not flag a real article image", () => {
    assert.equal(isGenericImageUrl("https://example.com/2026/01/rtx-benchmark.jpg"), false);
  });

  it("does not flag a headline slug that merely contains a generic word", () => {
    // "defaults" and "socially" are words, not the site's stock picture.
    assert.equal(isGenericImageUrl("https://example.com/news/loan-defaults/chart.jpg"), false);
    assert.equal(isGenericImageUrl("https://example.com/news/socially-awkward/lead.jpg"), false);
  });

  it("says no rather than throwing on a value that is not a URL", () => {
    assert.equal(isGenericImageUrl("not a url"), false);
    assert.equal(isGenericImageUrl(null), false);
  });
});

describe("pickSourceImage — a generic metadata image is demoted", () => {
  // A stock CMS fallback. Note this is DEMOTED, not rejected: a name that also
  // trips the hard junk list (`/img/social-share.png`) never gets this far.
  const GENERIC_META = "https://example.com/static/og-default.png";
  const FEED = "https://example.com/enclosure.jpg";
  const CONTENT = "https://example.com/body.jpg";

  it("prefers a real in-content image over the site's stock og:image", () => {
    assert.equal(
      pickSourceImage({ metaImageUrl: GENERIC_META, contentImageUrl: CONTENT }),
      CONTENT
    );
  });

  it("prefers the feed's own attachment over the site's stock og:image", () => {
    assert.equal(
      pickSourceImage({ metaImageUrl: GENERIC_META, feedImageUrl: FEED, contentImageUrl: CONTENT }),
      FEED,
      "the feed attachment keeps its place ahead of a body scan"
    );
  });

  it("still uses the generic image when it is the only candidate", () => {
    // Demoted, never discarded — a bland picture beats no picture.
    assert.equal(pickSourceImage({ metaImageUrl: GENERIC_META }), GENERIC_META);
    assert.equal(
      pickSourceImage({ metaImageUrl: GENERIC_META, feedImageUrl: null, contentImageUrl: null }),
      GENERIC_META
    );
  });

  it("leaves a normal og:image at the front, as before", () => {
    assert.equal(
      pickSourceImage({
        metaImageUrl: "https://example.com/og.jpg",
        feedImageUrl: FEED,
        contentImageUrl: CONTENT,
      }),
      "https://example.com/og.jpg"
    );
  });
});

// ─── srcset ───────────────────────────────────────────────────────────────────

describe("srcsetCandidates — largest first", () => {
  it("orders width descriptors from largest to smallest", () => {
    assert.deepEqual(srcsetCandidates("/a.jpg 320w, /b.jpg 1600w, /c.jpg 800w"), [
      "/b.jpg",
      "/c.jpg",
      "/a.jpg",
    ]);
  });

  it("orders pixel densities when that is all the author wrote", () => {
    assert.deepEqual(srcsetCandidates("/a.jpg 1x, /b.jpg 3x, /c.jpg 2x"), [
      "/b.jpg",
      "/c.jpg",
      "/a.jpg",
    ]);
  });

  it("keeps the author's order when no candidate declares a size", () => {
    assert.deepEqual(srcsetCandidates("/a.jpg, /b.jpg"), ["/a.jpg", "/b.jpg"]);
  });

  it("splits on a comma with no space after the descriptor", () => {
    assert.deepEqual(srcsetCandidates("/a.jpg 320w,/b.jpg 640w"), ["/b.jpg", "/a.jpg"]);
  });

  it("does not split inside a CDN transformation path", () => {
    const value =
      "https://res.cloudinary.com/d/image/upload/w_300,h_200/a.jpg 300w, " +
      "https://res.cloudinary.com/d/image/upload/w_1200,h_800/a.jpg 1200w";
    assert.deepEqual(srcsetCandidates(value), [
      "https://res.cloudinary.com/d/image/upload/w_1200,h_800/a.jpg",
      "https://res.cloudinary.com/d/image/upload/w_300,h_200/a.jpg",
    ]);
  });

  it("returns nothing for an empty or missing srcset", () => {
    assert.deepEqual(srcsetCandidates(null), []);
    assert.deepEqual(srcsetCandidates("   "), []);
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

  it("takes the largest entry of a srcset, not the first", () => {
    const html = `<img srcset="https://example.com/w800.jpg 800w, https://example.com/w1600.jpg 1600w">`;
    assert.equal(selectContentImage(html, BASE), "https://example.com/w1600.jpg");
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

  it("falls through to the next srcset entry when the largest is junk", () => {
    const html = `<img srcset="/img/watermark-2000.jpg 2000w, /img/lead-1200.jpg 1200w">`;
    assert.equal(selectContentImage(html, BASE), "https://example.com/img/lead-1200.jpg");
  });

  it("reads a data-srcset, largest first", () => {
    const html = `<img src="/img/placeholder.gif" data-srcset="/img/a-400.jpg 400w, /img/a-1800.jpg 1800w">`;
    assert.equal(selectContentImage(html, BASE), "https://example.com/img/a-1800.jpg");
  });
});

describe("selectContentImage — <picture> support", () => {
  it("takes the source's largest candidate rather than the img fallback", () => {
    const html = `
      <picture>
        <source srcset="/img/wide-800.webp 800w, /img/wide-2000.webp 2000w" type="image/webp">
        <img src="/img/fallback-small.jpg">
      </picture>
    `;
    assert.equal(selectContentImage(html, BASE), "https://example.com/img/wide-2000.webp");
  });

  it("falls back to the img inside the picture when the source yields nothing", () => {
    const html = `
      <picture>
        <source srcset="/img/logo.svg" type="image/svg+xml">
        <img src="/img/lead.jpg">
      </picture>
    `;
    assert.equal(selectContentImage(html, BASE), "https://example.com/img/lead.jpg");
  });

  it("ignores a video track declared with <source>", () => {
    // <source src="…mp4" type="video/mp4"> must never become the post's image.
    const html = `
      <video><source src="/media/clip.mp4" type="video/mp4"></video>
      <img src="/img/lead.jpg">
    `;
    assert.equal(selectContentImage(html, BASE), "https://example.com/img/lead.jpg");
  });

  it("ignores a bare <source> with no srcset at all", () => {
    // An untyped <source src="…"> is audio/video shaped; only srcset is picture.
    const html = `<source src="/media/clip.webm"><img src="/img/lead.jpg">`;
    assert.equal(selectContentImage(html, BASE), "https://example.com/img/lead.jpg");
  });

  it("respects document order — an earlier real image beats a later picture", () => {
    const html = `
      <img src="/img/lead.jpg">
      <picture><source srcset="/img/later-2000.jpg 2000w"></picture>
    `;
    assert.equal(selectContentImage(html, BASE), "https://example.com/img/lead.jpg");
  });

  it("skips a source that declares a small size", () => {
    const html = `
      <picture>
        <source srcset="/img/tiny.jpg" width="80" height="80">
        <img src="/img/lead.jpg">
      </picture>
    `;
    assert.equal(selectContentImage(html, BASE), "https://example.com/img/lead.jpg");
  });
});
