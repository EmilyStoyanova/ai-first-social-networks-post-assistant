import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { checkSsrf, extractReadableText, extractArticleContent } from "./article-extractor";
import type { DnsResolver } from "./article-extractor";

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
