import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  checkSsrf,
  extractArticle,
  extractArticleContent,
  extractArticleParts,
  extractReadableText,
  resolveArticleContent,
} from "./article-extractor";
import type { DnsResolver } from "./article-extractor";
import { pickSourceImage } from "./article-image";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolver(address: string, family: 4 | 6 = 4): DnsResolver {
  return async () => [{ address, family }];
}

function failingResolver(): DnsResolver {
  return async () => {
    throw new Error("DNS failure");
  };
}

function mockFetch(status: number, body: string, contentType = "text/html; charset=utf-8") {
  return async () =>
    new Response(body, { status, headers: { "content-type": contentType } }) as Response;
}

/** Public IP resolver — passes SSRF checks without real DNS. */
const publicResolver = resolver("93.184.216.34", 4);

/** A fake public URL whose hostname passes the pre-DNS hostname check. */
const ARTICLE_URL = "https://example.com/article";

const ARTICLE_HTML = `
<html><body>
  <article>
    <h1>Breaking News</h1>
    <p>${"Detailed reporting on the event with full context and analysis. ".repeat(8)}</p>
    <p>${"Additional paragraphs providing background and expert commentary. ".repeat(6)}</p>
  </article>
</body></html>
`;

// ─── jsdom dependency chain — Vercel runtime compatibility ───────────────────

describe("jsdom dependency chain — CJS-only (Vercel runtime compatibility)", () => {
  // jsdom ≥27 requires ESM-only @exodus/bytes from CommonJS (via itself,
  // html-encoding-sniffer ≥5 and whatwg-url ≥16), which throws ERR_REQUIRE_ESM
  // on Node runtimes without require(esm) support — this broke RSS ingestion in
  // production on Vercel. jsdom is pinned to the 26.x line (fully-CJS chain);
  // do not upgrade past 26 until the Vercel Node runtime supports require(esm).
  it("does not pull the ESM-only @exodus/bytes package", () => {
    const require = createRequire(import.meta.url);
    assert.throws(
      () => require.resolve("@exodus/bytes"),
      "The @exodus/bytes ESM package must not be in the dependency tree — " +
        "it breaks jsdom under require() on the Vercel Node runtime (ERR_REQUIRE_ESM)."
    );
  });

  it("loads jsdom and executes a full extraction (module chain is require()-safe)", () => {
    const result = extractReadableText(ARTICLE_HTML, ARTICLE_URL);
    assert.ok(result !== null, "jsdom + Readability extraction must work end-to-end");
  });
});

// ─── checkSsrf — scheme validation ────────────────────────────────────────────

describe("checkSsrf — scheme validation", () => {
  it("blocks ftp:// scheme", async () => {
    assert.equal(await checkSsrf(new URL("ftp://example.com/file"), publicResolver), false);
  });

  it("blocks file:// scheme", async () => {
    assert.equal(await checkSsrf(new URL("file:///etc/passwd"), publicResolver), false);
  });

  it("allows https://", async () => {
    assert.equal(await checkSsrf(new URL(ARTICLE_URL), publicResolver), true);
  });

  it("allows http://", async () => {
    assert.equal(await checkSsrf(new URL("http://example.com/"), publicResolver), true);
  });
});

// ─── checkSsrf — hostname-level blocks ────────────────────────────────────────

describe("checkSsrf — hostname blocks (pre-DNS)", () => {
  it("blocks localhost", async () => {
    assert.equal(await checkSsrf(new URL("http://localhost/"), publicResolver), false);
  });

  it("blocks *.local suffix", async () => {
    assert.equal(await checkSsrf(new URL("http://myservice.local/"), publicResolver), false);
  });

  it("blocks *.internal suffix", async () => {
    assert.equal(await checkSsrf(new URL("http://db.internal/"), publicResolver), false);
  });
});

// ─── checkSsrf — private IPv4 ranges ─────────────────────────────────────────

describe("checkSsrf — blocks private IPv4 addresses returned by DNS", () => {
  const privateIPv4Cases: Array<[string, string]> = [
    ["127.0.0.1 (loopback)", "127.0.0.1"],
    ["10.0.0.1 (10/8)", "10.0.0.1"],
    ["172.16.0.1 (172.16/12 start)", "172.16.0.1"],
    ["172.31.255.255 (172.16/12 end)", "172.31.255.255"],
    ["192.168.1.1 (192.168/16)", "192.168.1.1"],
    ["169.254.0.1 (link-local)", "169.254.0.1"],
    ["0.0.0.1 (0/8)", "0.0.0.1"],
  ];

  for (const [label, ip] of privateIPv4Cases) {
    it(`blocks ${label}`, async () => {
      assert.equal(
        await checkSsrf(new URL(ARTICLE_URL), resolver(ip, 4)),
        false,
        `Expected SSRF block for ${ip}`
      );
    });
  }

  it("allows a genuine public IPv4", async () => {
    assert.equal(await checkSsrf(new URL(ARTICLE_URL), resolver("93.184.216.34", 4)), true);
  });

  it("172.15.x.x is not in 172.16/12 — should be allowed", async () => {
    assert.equal(await checkSsrf(new URL(ARTICLE_URL), resolver("172.15.0.1", 4)), true);
  });

  it("172.32.x.x is not in 172.16/12 — should be allowed", async () => {
    assert.equal(await checkSsrf(new URL(ARTICLE_URL), resolver("172.32.0.1", 4)), true);
  });
});

// ─── checkSsrf — private IPv6 ranges ─────────────────────────────────────────

describe("checkSsrf — blocks private IPv6 addresses returned by DNS", () => {
  const privateIPv6Cases: Array<[string, string]> = [
    ["::1 (loopback)", "::1"],
    ["fc00::1 (unique local fc)", "fc00::1"],
    ["fd12:3456::1 (unique local fd)", "fd12:3456::1"],
    ["fe80::1 (link-local)", "fe80::1"],
    ["fe8f::1 (link-local range)", "fe8f::1"],
  ];

  for (const [label, ip] of privateIPv6Cases) {
    it(`blocks ${label}`, async () => {
      assert.equal(
        await checkSsrf(new URL(ARTICLE_URL), resolver(ip, 6)),
        false,
        `Expected SSRF block for IPv6 ${ip}`
      );
    });
  }

  it("allows a public IPv6", async () => {
    assert.equal(
      await checkSsrf(new URL(ARTICLE_URL), resolver("2606:2800:220:1:248:1893:25c8:1946", 6)),
      true
    );
  });
});

// ─── checkSsrf — DNS failure ─────────────────────────────────────────────────

describe("checkSsrf — DNS failure handling", () => {
  it("returns false when DNS resolution throws", async () => {
    assert.equal(await checkSsrf(new URL(ARTICLE_URL), failingResolver()), false);
  });
});

// ─── extractReadableText ─────────────────────────────────────────────────────

describe("extractReadableText — HTML parsing", () => {
  it("extracts article body from well-structured HTML", () => {
    const result = extractReadableText(ARTICLE_HTML, ARTICLE_URL);
    assert.ok(result !== null, "Should extract readable text");
    assert.ok(result!.length >= 300, "Extracted text should exceed minimum length");
  });

  it("returns null for a short paywall stub", () => {
    const html = `<html><body><p>Subscribe to read the full article.</p></body></html>`;
    assert.equal(extractReadableText(html, ARTICLE_URL), null);
  });

  it("returns null for HTML with only navigation", () => {
    const html = `
      <html><body>
        <nav><a href="/">Home</a><a href="/about">About</a><a href="/contact">Contact</a></nav>
        <footer>© 2024 Example Corp. All rights reserved.</footer>
      </body></html>
    `;
    assert.equal(extractReadableText(html, ARTICLE_URL), null);
  });

  it("returns null for an empty string", () => {
    assert.equal(extractReadableText("", ARTICLE_URL), null);
  });
});

// ─── extractArticleContent — input validation (no network) ───────────────────

describe("extractArticleContent — input validation", () => {
  it("returns null for null input", async () => {
    assert.equal(await extractArticleContent(null), null);
  });

  it("returns null for an invalid URL string", async () => {
    assert.equal(await extractArticleContent("not-a-url"), null);
  });

  it("returns null for a non-http(s) URL", async () => {
    assert.equal(await extractArticleContent("ftp://example.com/file"), null);
  });
});

// ─── extractArticleContent — end-to-end with injected dependencies ────────────

describe("extractArticleContent — end-to-end (injected fetch + resolver)", () => {
  it("returns extracted text for a valid article", async () => {
    const result = await extractArticleContent(ARTICLE_URL, {
      resolve: publicResolver,
      fetch: mockFetch(200, ARTICLE_HTML),
    });
    assert.ok(result !== null, "Should return extracted text");
    assert.ok(result!.length >= 300);
  });

  it("returns null when the server returns 404", async () => {
    const result = await extractArticleContent(ARTICLE_URL, {
      resolve: publicResolver,
      fetch: mockFetch(404, "Not Found", "text/html"),
    });
    assert.equal(result, null);
  });

  it("returns null when the server returns 403", async () => {
    const result = await extractArticleContent(ARTICLE_URL, {
      resolve: publicResolver,
      fetch: mockFetch(403, "Forbidden", "text/html"),
    });
    assert.equal(result, null);
  });

  it("returns null when content-type is application/json", async () => {
    const result = await extractArticleContent(ARTICLE_URL, {
      resolve: publicResolver,
      fetch: mockFetch(200, "{}", "application/json"),
    });
    assert.equal(result, null);
  });

  it("returns null when content-type is application/pdf", async () => {
    const result = await extractArticleContent(ARTICLE_URL, {
      resolve: publicResolver,
      fetch: mockFetch(200, "%PDF-1.4", "application/pdf"),
    });
    assert.equal(result, null);
  });

  it("returns null for a paywall stub (thin extracted content)", async () => {
    const paywallHtml = `
      <html><body><p>This article is for subscribers only. Please log in to continue.</p></body></html>
    `;
    const result = await extractArticleContent(ARTICLE_URL, {
      resolve: publicResolver,
      fetch: mockFetch(200, paywallHtml),
    });
    assert.equal(result, null);
  });

  it("returns null when SSRF check fails (private DNS result)", async () => {
    const result = await extractArticleContent(ARTICLE_URL, {
      resolve: resolver("10.0.0.1", 4),
      fetch: mockFetch(200, ARTICLE_HTML),
    });
    assert.equal(result, null);
  });

  it("returns null when fetch throws (e.g. timeout)", async () => {
    const result = await extractArticleContent(ARTICLE_URL, {
      resolve: publicResolver,
      fetch: async () => {
        throw new Error("fetch failed");
      },
    });
    assert.equal(result, null);
  });

  it("returns null when DNS resolution fails", async () => {
    const result = await extractArticleContent(ARTICLE_URL, {
      resolve: failingResolver(),
      fetch: mockFetch(200, ARTICLE_HTML),
    });
    assert.equal(result, null);
  });
});

// ─── extractArticleParts — text and image from a single parse ────────────────

describe("extractArticleParts — image candidates", () => {
  const BODY = `
    <article>
      <h1>Breaking News</h1>
      <p>${"Detailed reporting on the event with full context and analysis. ".repeat(8)}</p>
    </article>`;

  it("returns the text and the declared image together", () => {
    const html = `<html><head>
      <meta property="og:image" content="https://example.com/og.jpg">
    </head><body>${BODY}</body></html>`;

    const parts = extractArticleParts(html, ARTICLE_URL);
    assert.ok(parts.text && parts.text.length >= 300, "the text extraction is unchanged");
    assert.equal(parts.metaImageUrl, "https://example.com/og.jpg");
  });

  it("reads the metadata BEFORE Readability rewrites the document", () => {
    // Readability.parse() consumes the DOM it is handed; reading <head> after it
    // has run is how this silently returns null in production.
    const html = `<html><head>
      <meta name="twitter:image" content="https://example.com/card.jpg">
    </head><body>${BODY}</body></html>`;

    assert.equal(
      extractArticleParts(html, ARTICLE_URL).metaImageUrl,
      "https://example.com/card.jpg"
    );
  });

  it("skips the body scan when the publisher already declared an image", () => {
    const html = `<html><head>
      <meta property="og:image" content="https://example.com/og.jpg">
    </head><body><article><img src="https://example.com/inline.jpg">${BODY}</article></body></html>`;

    const parts = extractArticleParts(html, ARTICLE_URL);
    assert.equal(parts.metaImageUrl, "https://example.com/og.jpg");
    assert.equal(parts.contentImageUrl, null, "the weaker candidate is not even looked for");
  });

  it("falls back to an in-content image when the page declares none", () => {
    const html = `<html><head><title>Story</title></head><body>
      <article>
        <img src="https://example.com/lead-photo.jpg">
        <p>${"Detailed reporting on the event with full context and analysis. ".repeat(8)}</p>
      </article>
    </body></html>`;

    const parts = extractArticleParts(html, ARTICLE_URL);
    assert.equal(parts.metaImageUrl, null);
    assert.equal(parts.contentImageUrl, "https://example.com/lead-photo.jpg");
  });

  it("still reports the image when the text is too thin to use", () => {
    // A paywalled page has no usable body but a perfectly good preview image —
    // the two outcomes are independent.
    const html = `<html><head>
      <meta property="og:image" content="https://example.com/og.jpg">
    </head><body><p>Subscribe to read.</p></body></html>`;

    const parts = extractArticleParts(html, ARTICLE_URL);
    assert.equal(parts.text, null);
    assert.equal(parts.metaImageUrl, "https://example.com/og.jpg");
  });

  it("returns empty parts for unparseable input rather than throwing", () => {
    const parts = extractArticleParts("", ARTICLE_URL);
    assert.deepEqual(parts, {
      text: null,
      method: null,
      // Empty input parses fine and simply has no article in it — that is a
      // finding about the page, not a crash, and it is now labelled as one.
      error: "no_article_text",
      metaImageUrl: null,
      contentImageUrl: null,
    });
  });

  it("still scans the body when og:image is only the site's stock picture", () => {
    // The commonest cause of a bland, wrong image: a CMS that stamps one
    // fallback into og:image on every page. Both candidates are reported and
    // pickSourceImage prefers the real one.
    const html = `<html><head>
      <meta property="og:image" content="https://example.com/static/og-default.png">
    </head><body><article>
      <img src="https://example.com/lead-photo.jpg">
      <p>${"Detailed reporting on the event with full context and analysis. ".repeat(8)}</p>
    </article></body></html>`;

    const parts = extractArticleParts(html, ARTICLE_URL);
    assert.equal(parts.metaImageUrl, "https://example.com/static/og-default.png");
    assert.equal(parts.contentImageUrl, "https://example.com/lead-photo.jpg");
    assert.equal(
      pickSourceImage(parts),
      "https://example.com/lead-photo.jpg",
      "the article's own photo wins"
    );
  });

  it("keeps the stock picture when the body offers nothing better", () => {
    const html = `<html><head>
      <meta property="og:image" content="https://example.com/static/og-default.png">
    </head><body><article>
      <p>${"Detailed reporting on the event with full context and analysis. ".repeat(8)}</p>
    </article></body></html>`;

    const parts = extractArticleParts(html, ARTICLE_URL);
    assert.equal(parts.contentImageUrl, null);
    assert.equal(pickSourceImage(parts), "https://example.com/static/og-default.png");
  });

  it("takes the largest srcset entry from a <picture> in the body", () => {
    const html = `<html><head><title>Story</title></head><body><article>
      <picture>
        <source srcset="https://example.com/w400.jpg 400w, https://example.com/w2000.jpg 2000w">
        <img src="https://example.com/fallback.jpg">
      </picture>
      <p>${"Detailed reporting on the event with full context and analysis. ".repeat(8)}</p>
    </article></body></html>`;

    assert.equal(
      extractArticleParts(html, ARTICLE_URL).contentImageUrl,
      "https://example.com/w2000.jpg"
    );
  });
});

describe("extractArticle — end-to-end image extraction", () => {
  const HTML = `<html><head>
      <meta property="og:image" content="https://example.com/og.jpg">
    </head><body>${ARTICLE_HTML}</body></html>`;

  it("returns the image alongside the text", async () => {
    const result = await extractArticle(ARTICLE_URL, {
      resolve: publicResolver,
      fetch: mockFetch(200, HTML),
    });
    assert.equal(result.metaImageUrl, "https://example.com/og.jpg");
    assert.ok(result.text);
  });

  it("returns no image when the fetch is blocked by the SSRF gate", async () => {
    const result = await extractArticle(ARTICLE_URL, {
      resolve: resolver("10.0.0.1", 4),
      fetch: mockFetch(200, HTML),
    });
    assert.deepEqual(result, {
      text: null,
      method: null,
      error: "ssrf_blocked",
      metaImageUrl: null,
      contentImageUrl: null,
    });
  });

  it("returns no image when the article 404s", async () => {
    const result = await extractArticle(ARTICLE_URL, {
      resolve: publicResolver,
      fetch: mockFetch(404, HTML),
    });
    assert.equal(result.metaImageUrl, null);
  });
});

// ─── Extraction cascade and provenance ───────────────────────────────────────

describe("extractArticleParts — cascade and provenance", () => {
  const LONG_BODY = "Reported detail with context and analysis of the events. ".repeat(8);

  it("uses Readability and records it as the method", () => {
    const result = extractArticleParts(ARTICLE_HTML, ARTICLE_URL);
    assert.equal(result.method, "readability");
    assert.equal(result.error, null);
    assert.ok(result.text && result.text.length >= 300);
  });

  it("falls back to JSON-LD articleBody when there is no readable body", () => {
    // A consent/paywall shell: no article markup for Readability to score, but
    // the publisher still ships the body server-side for search engines.
    const html = `<html><head>
      <script type="application/ld+json">${JSON.stringify({
        "@type": "NewsArticle",
        articleBody: LONG_BODY,
      })}</script>
    </head><body><div id="consent"><p>Accept cookies</p></div></body></html>`;

    const result = extractArticleParts(html, ARTICLE_URL);
    assert.equal(result.method, "json_ld");
    assert.ok(result.text?.includes("Reported detail with context"));
    assert.equal(result.error, null);
  });

  it("records why nothing could be extracted instead of returning a bare null", () => {
    const result = extractArticleParts(`<html><body><p>Hi</p></body></html>`, ARTICLE_URL);
    assert.equal(result.text, null);
    assert.equal(result.method, null);
    assert.equal(result.error, "no_article_text");
  });

  it("keeps the article's image alongside a fallback-extracted body", () => {
    const html = `<html><head>
      <meta property="og:image" content="https://example.com/lead.jpg">
      <script type="application/ld+json">${JSON.stringify({ articleBody: LONG_BODY })}</script>
    </head><body><div id="paywall"><p>Subscribe</p></div></body></html>`;

    const result = extractArticleParts(html, ARTICLE_URL);
    assert.equal(result.method, "json_ld");
    assert.equal(result.metaImageUrl, "https://example.com/lead.jpg");
  });

  it("survives a very large document without leaking the jsdom window", () => {
    // The close() path: a leaked window is not directly observable, so this
    // asserts the parse still completes and returns normally under bulk.
    const bulk = `<div><p>${LONG_BODY}</p></div>`.repeat(400);
    const result = extractArticleParts(
      `<html><body><article>${bulk}</article></body></html>`,
      ARTICLE_URL
    );
    assert.ok(result.text);
  });
});

describe("extractArticle — failure reasons are recorded", () => {
  it("records the HTTP status when the page does not return 200", async () => {
    const result = await extractArticle(ARTICLE_URL, {
      resolve: publicResolver,
      fetch: mockFetch(403, ARTICLE_HTML),
    });
    assert.equal(result.text, null);
    assert.equal(result.error, "http_403");
  });

  it("records a non-HTML content type", async () => {
    const result = await extractArticle(ARTICLE_URL, {
      resolve: publicResolver,
      fetch: mockFetch(200, "{}", "application/json"),
    });
    assert.match(result.error ?? "", /^non_html/);
  });

  it("records a transport failure", async () => {
    const result = await extractArticle(ARTICLE_URL, {
      resolve: publicResolver,
      fetch: async () => {
        throw new Error("socket hang up");
      },
    });
    assert.match(result.error ?? "", /^fetch_failed/);
  });

  it("records a missing url", async () => {
    assert.equal((await extractArticle(null)).error, "no_url");
  });
});

// ─── resolveArticleContent — the RSS summary must not pass as an article ─────

describe("resolveArticleContent", () => {
  const SUMMARY = "One teaser sentence the feed shipped in its description element.";

  it("marks a real extraction complete and keeps its method", () => {
    const extracted = extractArticleParts(ARTICLE_HTML, ARTICLE_URL);
    const resolved = resolveArticleContent(extracted, SUMMARY);

    assert.equal(resolved.complete, true);
    assert.equal(resolved.method, "readability");
    assert.equal(resolved.error, null);
    assert.equal(resolved.content, extracted.text);
    assert.equal(resolved.chars, extracted.text?.length);
  });

  it("stores the feed summary but marks it INCOMPLETE", () => {
    const failed = {
      text: null,
      method: null,
      error: "http_403",
      metaImageUrl: null,
      contentImageUrl: null,
    };
    const resolved = resolveArticleContent(failed, SUMMARY);

    // The summary is still kept — a titled row beats an empty one for a human
    // browsing the feed — but it no longer claims to be the article.
    assert.equal(resolved.content, SUMMARY);
    assert.equal(resolved.complete, false);
    assert.equal(resolved.method, "rss_summary");
    assert.equal(resolved.error, "http_403", "the real cause must survive into the row");
  });

  it("reports no content at all when the feed supplied no summary either", () => {
    const failed = {
      text: null,
      method: null,
      error: "no_article_text",
      metaImageUrl: null,
      contentImageUrl: null,
    };
    const resolved = resolveArticleContent(failed, null);

    assert.equal(resolved.content, null);
    assert.equal(resolved.method, null);
    assert.equal(resolved.chars, 0);
    assert.equal(resolved.complete, false);
  });

  it("treats a whitespace-only summary as no summary", () => {
    const failed = {
      text: null,
      method: null,
      error: "no_article_text",
      metaImageUrl: null,
      contentImageUrl: null,
    };
    assert.equal(resolveArticleContent(failed, "   \n  ").content, null);
  });
});
