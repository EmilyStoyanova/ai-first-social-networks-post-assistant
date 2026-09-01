import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFeed, parseFeedXml, FeedFetchBlockedError } from "./parser";
import type { DnsResolver } from "./article-extractor";

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** The Mailchimp form WordPress/StartupNation embeds inside every article body. */
const MAILCHIMP_EMBED = `
  <div id="mc_embed_signup">
    <link href="//cdn-images.mailchimp.com/embedcode/classic-061523.css" rel="stylesheet" type="text/css"/>
    <form action="https://startupnation.us1.list-manage.com/subscribe/post"></form>
  </div>`;

/** A StartupNation-style RSS 2.0 item whose body embeds the Mailchimp stylesheet. */
function startupNationItem(slug: string, title: string): string {
  return `
  <item>
    <title>${title}</title>
    <link>https://startupnation.com/${slug}/</link>
    <comments>https://startupnation.com/${slug}/#respond</comments>
    <pubDate>Wed, 16 Jul 2025 12:00:00 +0000</pubDate>
    <guid isPermaLink="false">https://startupnation.com/?p=${slug.length}</guid>
    <description><![CDATA[A short summary for ${title}.]]></description>
    <content:encoded><![CDATA[<p>Body of ${title}.</p>${MAILCHIMP_EMBED}]]></content:encoded>
  </item>`;
}

function rssFeed(items: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
  <rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
    <channel>
      <title>StartupNation</title>
      <link>https://startupnation.com</link>
      <atom:link href="https://startupnation.com/feed/" rel="self" type="application/rss+xml"/>
      ${items}
    </channel>
  </rss>`;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("parseFeedXml — RSS 2.0", () => {
  it("resolves the link from the item's own <link>text</link>, ignoring embedded HTML", () => {
    const xml = rssFeed(
      startupNationItem("start-your-business/mvp-on-a-budget", "MVP on a budget")
    );
    const items = parseFeedXml(xml);

    assert.equal(items.length, 1);
    assert.equal(items[0].url, "https://startupnation.com/start-your-business/mvp-on-a-budget/");
    assert.equal(items[0].title, "MVP on a budget");
    // The Mailchimp stylesheet inside <content:encoded> must never win.
    assert.ok(!/mailchimp/.test(items[0].url ?? ""));
  });

  it("keeps a plain RSS 2.0 item link working (no embedded content)", () => {
    const xml = rssFeed(`
      <item>
        <title>Plain article</title>
        <link>https://example.com/plain-article</link>
        <description>Just a summary.</description>
      </item>`);
    const items = parseFeedXml(xml);

    assert.equal(items.length, 1);
    assert.equal(items[0].url, "https://example.com/plain-article");
    assert.equal(items[0].summary, "Just a summary.");
  });

  it("gives distinct article URLs to items that share the same embedded stylesheet", () => {
    const xml = rssFeed(
      startupNationItem("grow/content-generic", "Why your content sounds generic") +
        startupNationItem("manage/fire-too-slowly", "Why leaders fire too slowly") +
        startupNationItem("start/product-market-fit", "Product-market fit expires")
    );
    const items = parseFeedXml(xml);

    const urls = items.map((i) => i.url);
    assert.deepEqual(urls, [
      "https://startupnation.com/grow/content-generic/",
      "https://startupnation.com/manage/fire-too-slowly/",
      "https://startupnation.com/start/product-market-fit/",
    ]);
    // No collapse: 3 items → 3 distinct URLs.
    assert.equal(new Set(urls).size, 3);
  });

  it("does not collapse a full 20-item StartupNation-style feed to 2 URLs", () => {
    const items20 = Array.from({ length: 20 }, (_, i) =>
      startupNationItem(`category-${i}/article-${i}`, `Article ${i}`)
    ).join("");
    const parsed = parseFeedXml(rssFeed(items20));

    assert.equal(parsed.length, 20);
    const distinct = new Set(parsed.map((p) => p.url));
    assert.equal(distinct.size, 20, "expected 20 distinct article URLs, not a collapse");
    assert.ok(![...distinct].some((u) => u?.includes("mailchimp")));
  });
});

describe("parseFeedXml — pretty-printed CDATA (ArchDaily)", () => {
  /**
   * ArchDaily's real feed indents every CDATA section onto its own line. The extractor used to
   * require `<title><![CDATA[` to be adjacent, so the newline sent it down the plain-text
   * branch — where `replace(/<[^>]+>/g, "")` consumed the whole `<![CDATA[…]]>` span as if it
   * were one tag (it holds no `>` until its terminator) and deleted the title outright. Every
   * such article was stored as `(untitled)`.
   */
  const archDailyItem = `
    <item>
      <title>
        <![CDATA[Modernism on the Watch: Preserving the Sardar Vallabhbhai Patel Stadium in India]]>
      </title>
      <link>https://www.archdaily.com/1183078/modernism-on-the-watch</link>
      <pubDate>Mon, 17 Aug 2026 07:30:00 +0000</pubDate>
      <description>
        <![CDATA[<p>In the heart of Ahmedabad's Navrangpura district sits the stadium.</p>]]>
      </description>
    </item>`;

  it("reads a title whose CDATA sits on its own line", () => {
    const items = parseFeedXml(rssFeed(archDailyItem));

    assert.equal(items.length, 1);
    assert.equal(
      items[0].title,
      "Modernism on the Watch: Preserving the Sardar Vallabhbhai Patel Stadium in India"
    );
  });

  it("reads a description whose CDATA sits on its own line", () => {
    const items = parseFeedXml(rssFeed(archDailyItem));

    assert.ok(items[0].summary?.includes("Navrangpura district"));
    // The CDATA terminator must not leak into the stored text.
    assert.ok(!items[0].summary?.includes("]]"));
  });

  it("never yields a null title for a feed that supplies one", () => {
    const items = parseFeedXml(rssFeed(archDailyItem + archDailyItem.replace("1183078", "9")));
    assert.equal(
      items.filter((i) => i.title === null).length,
      0,
      "a pretty-printed CDATA title must not become (untitled)"
    );
  });

  it("keeps the adjacent CDATA form working", () => {
    const items = parseFeedXml(
      rssFeed(`
      <item>
        <title><![CDATA[Adjacent form]]></title>
        <link>https://example.com/adjacent</link>
      </item>`)
    );
    assert.equal(items[0].title, "Adjacent form");
  });

  it("concatenates an element carrying more than one CDATA section", () => {
    const items = parseFeedXml(
      rssFeed(`
      <item>
        <title><![CDATA[First half ]]><![CDATA[second half]]></title>
        <link>https://example.com/split</link>
      </item>`)
    );
    assert.equal(items[0].title, "First half second half");
  });
});

describe("parseFeedXml — HTML entity decoding", () => {
  it("decodes numeric and named entities in titles", () => {
    const xml = rssFeed(`
      <item>
        <title>Survive Your Startup&#8217;s &#8220;First&#8221; Inspections &amp; More&#8230;</title>
        <link>https://example.com/a</link>
        <description>Nothing here.</description>
      </item>`);
    const items = parseFeedXml(xml);

    assert.equal(items[0].title, "Survive Your Startup’s “First” Inspections & More…");
    assert.ok(!/&#|&amp;/.test(items[0].title ?? ""));
  });

  it("decodes entities inside a CDATA summary", () => {
    const xml = rssFeed(`
      <item>
        <title>Plain</title>
        <link>https://example.com/b</link>
        <description><![CDATA[Cost &amp; value rose 5&#37; &#8212; a big jump.]]></description>
      </item>`);
    const items = parseFeedXml(xml);

    assert.equal(items[0].summary, "Cost & value rose 5% — a big jump.");
  });

  it("decodes hex entities and leaves unknown named entities untouched", () => {
    const xml = rssFeed(`
      <item>
        <title>Ma&#x00F1;ana &fakeentity; stays</title>
        <link>https://example.com/c</link>
      </item>`);
    const items = parseFeedXml(xml);

    assert.equal(items[0].title, "Mañana &fakeentity; stays");
  });

  it("does NOT decode the item URL (preserves the stored key)", () => {
    // WordPress emits &#038; (= &) inside link query strings. Decoding the URL
    // would change the (sourceId, url) key and orphan existing rows, so links
    // must be left byte-for-byte as parsed.
    const xml = rssFeed(`
      <item>
        <title>Query link</title>
        <link>https://example.com/x?utm_source=rss&#038;utm_medium=rss</link>
      </item>`);
    const items = parseFeedXml(xml);

    assert.equal(items[0].url, "https://example.com/x?utm_source=rss&#038;utm_medium=rss");
  });
});

describe("parseFeedXml — Atom", () => {
  it("resolves the link from <entry><link href=.../> (alternate preferred)", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Atom Example</title>
        <entry>
          <title>Atom post</title>
          <link rel="self" href="https://example.com/atom/self"/>
          <link rel="alternate" href="https://example.com/atom/post"/>
          <updated>2025-07-16T12:00:00Z</updated>
          <content type="html">&lt;p&gt;Body&lt;/p&gt;</content>
        </entry>
      </feed>`;
    const items = parseFeedXml(xml);

    assert.equal(items.length, 1);
    // Prefers rel="alternate" over rel="self".
    assert.equal(items[0].url, "https://example.com/atom/post");
    assert.equal(items[0].title, "Atom post");
  });

  it("uses a rel-less Atom link (defaults to alternate)", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>Rel-less</title>
          <link href="https://example.com/atom/relless"/>
          <updated>2025-07-16T12:00:00Z</updated>
        </entry>
      </feed>`;
    const items = parseFeedXml(xml);

    assert.equal(items.length, 1);
    assert.equal(items[0].url, "https://example.com/atom/relless");
  });
});

// ─── Item images ──────────────────────────────────────────────────────────────

describe("parseFeedXml — item images", () => {
  function rssWith(itemBody: string): string {
    return `<?xml version="1.0"?><rss version="2.0"><channel><item>
      <title>Story</title>
      <link>https://example.com/story</link>
      ${itemBody}
    </item></channel></rss>`;
  }

  it("reads an image enclosure", () => {
    const items = parseFeedXml(
      rssWith(
        `<enclosure url="https://example.com/img/lead.jpg" type="image/jpeg" length="12345"/>`
      )
    );
    assert.equal(items[0].imageUrl, "https://example.com/img/lead.jpg");
  });

  it("ignores a podcast enclosure — an enclosure is not necessarily an image", () => {
    const items = parseFeedXml(
      rssWith(
        `<enclosure url="https://example.com/audio/ep1.mp3" type="audio/mpeg" length="9999"/>`
      )
    );
    assert.equal(items[0].imageUrl, null);
  });

  it("reads media:content declared as an image", () => {
    const items = parseFeedXml(
      rssWith(
        `<media:content url="https://example.com/img/media.jpg" medium="image" width="1200"/>`
      )
    );
    assert.equal(items[0].imageUrl, "https://example.com/img/media.jpg");
  });

  it("ignores media:content that is a video", () => {
    const items = parseFeedXml(
      rssWith(`<media:content url="https://example.com/clip.mp4" medium="video"/>`)
    );
    assert.equal(items[0].imageUrl, null);
  });

  it("reads media:thumbnail", () => {
    const items = parseFeedXml(
      rssWith(`<media:thumbnail url="https://example.com/img/thumb.jpg"/>`)
    );
    assert.equal(items[0].imageUrl, "https://example.com/img/thumb.jpg");
  });

  it("prefers media:content over media:thumbnail — the thumbnail is the cropped one", () => {
    const items = parseFeedXml(
      rssWith(`
        <media:thumbnail url="https://example.com/img/thumb.jpg"/>
        <media:content url="https://example.com/img/full.jpg" medium="image"/>
      `)
    );
    assert.equal(items[0].imageUrl, "https://example.com/img/full.jpg");
  });

  it("does not mistake an image inside the article body for the item's own", () => {
    // Same class of bug as the Mailchimp stylesheet hijacking link resolution:
    // a signup form or ad embedded in content:encoded must not supply the image.
    const items = parseFeedXml(
      rssWith(
        `<content:encoded><![CDATA[<p>Body</p><img src="https://ads.example.net/banner.jpg">]]></content:encoded>`
      )
    );
    assert.equal(items[0].imageUrl, null);
  });

  it("resolves a relative enclosure against the item's own link", () => {
    const items = parseFeedXml(rssWith(`<enclosure url="/img/lead.jpg" type="image/png"/>`));
    assert.equal(items[0].imageUrl, "https://example.com/img/lead.jpg");
  });

  it("rejects a tracking pixel dressed as an enclosure", () => {
    const items = parseFeedXml(
      rssWith(`<enclosure url="https://example.com/img/pixel.gif" type="image/gif"/>`)
    );
    assert.equal(items[0].imageUrl, null);
  });

  it("reports null for an item with no image at all", () => {
    assert.equal(parseFeedXml(rssWith(`<description>Text only.</description>`))[0].imageUrl, null);
  });
});

// ─── parseFeed — network fetch is now redirect-safe (verification pass) ──────
//
// Before this pass, `parseFeed` performed a bare `fetch(url, {cache:
// "no-store"})` with NO SSRF check of its own — not on the initial URL, and
// not on any redirect it followed. This applies to BOTH the normal RSS
// pipeline (`ingest-content-source.service.ts`, which calls `parseFeed`
// directly) and competitor RSS ingestion — the fix lives here, once, in the
// shared low-level fetch, so both paths inherit it identically.

function feedResolver(map: Record<string, { address: string; family: 4 | 6 }>): DnsResolver {
  return async (hostname: string) => {
    const entry = map[hostname];
    if (!entry) throw new Error(`no fake DNS entry configured for host "${hostname}"`);
    return [entry];
  };
}

const MINIMAL_FEED_XML = `<?xml version="1.0"?><rss><channel>
  <item><title>Hi</title><link>https://example.com/a</link></item>
</channel></rss>`;

describe("parseFeed — SSRF/redirect safety", () => {
  const FEED_URL = "https://public-feed.example/rss.xml";

  it("fetches and parses a feed from a safe public URL", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response(MINIMAL_FEED_XML, { status: 200 }) as Response;
    const items = await parseFeed(FEED_URL, {
      resolve: feedResolver({ "public-feed.example": { address: "93.184.216.34", family: 4 } }),
      fetch: fetchFn,
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].url, "https://example.com/a");
  });

  it("rejects a feed URL that resolves to a private address, WITHOUT fetching it", async () => {
    let called = false;
    const fetchFn: typeof globalThis.fetch = async () => {
      called = true;
      return new Response(MINIMAL_FEED_XML, { status: 200 }) as Response;
    };
    await assert.rejects(
      () =>
        parseFeed(FEED_URL, {
          resolve: feedResolver({ "public-feed.example": { address: "10.0.0.1", family: 4 } }),
          fetch: fetchFn,
        }),
      FeedFetchBlockedError
    );
    assert.equal(called, false, "must never reach the network for an SSRF-blocked feed URL");
  });

  it("rejects a feed URL that redirects to an internal/private address", async () => {
    const target = "https://internal-feed-host.example/hidden.xml";
    const calls: string[] = [];
    const fetchFn: typeof globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);
      if (url === FEED_URL) {
        return new Response(null, { status: 302, headers: { location: target } }) as Response;
      }
      // The redirect target must never actually be requested.
      return new Response(MINIMAL_FEED_XML, { status: 200 }) as Response;
    };
    await assert.rejects(
      () =>
        parseFeed(FEED_URL, {
          resolve: feedResolver({
            "public-feed.example": { address: "93.184.216.34", family: 4 },
            "internal-feed-host.example": { address: "127.0.0.1", family: 4 },
          }),
          fetch: fetchFn,
        }),
      FeedFetchBlockedError
    );
    assert.deepEqual(calls, [FEED_URL], "the redirect target must never be fetched");
  });

  it("follows a redirect to another safe public URL and parses the final feed", async () => {
    const target = "https://public-feed-2.example/rss2.xml";
    const fetchFn: typeof globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === FEED_URL) {
        return new Response(null, { status: 301, headers: { location: target } }) as Response;
      }
      if (url === target) {
        return new Response(MINIMAL_FEED_XML, { status: 200 }) as Response;
      }
      throw new Error(`unexpected fetch to ${url}`);
    };
    const items = await parseFeed(FEED_URL, {
      resolve: feedResolver({
        "public-feed.example": { address: "93.184.216.34", family: 4 },
        "public-feed-2.example": { address: "93.184.216.35", family: 4 },
      }),
      fetch: fetchFn,
    });
    assert.equal(items.length, 1);
  });

  it("throws an ordinary error (not FeedFetchBlockedError) for a non-SSRF HTTP failure", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response("Not Found", { status: 404, statusText: "Not Found" }) as Response;
    await assert.rejects(
      () =>
        parseFeed(FEED_URL, {
          resolve: feedResolver({ "public-feed.example": { address: "93.184.216.34", family: 4 } }),
          fetch: fetchFn,
        }),
      (err: unknown) => err instanceof Error && !(err instanceof FeedFetchBlockedError)
    );
  });
});

// ─── <content:encoded> — the 2026-09 content-acquisition fix ────────────────
//
// The real production incident: a competitor RSS source
// (`medium.com/feed/...`) whose items ship the FULL article inside
// `<content:encoded>` and carry no `<description>`/`<summary>` at all. The
// generic `extractText(item, "content")` fallback opened on
// `<content:encoded>` (the colon is absorbed by its `[^>]*`) but then looked
// for a `</content>` that never comes, so it silently returned null — and
// every such item was stored with `content: null`, indistinguishable from a
// feed that genuinely shipped nothing.

describe("parseFeedXml — <content:encoded> full article body", () => {
  it("reads the full body from <content:encoded> when there is NO description", () => {
    // The exact real-world shape: content:encoded only, no description/summary.
    const body = "Real article prose that the publisher shipped in the feed. ".repeat(6);
    const xml = rssFeed(`
      <item>
        <title>Medium-style article</title>
        <link>https://medium.com/x/article-abc123</link>
        <content:encoded><![CDATA[<p>${body}</p>]]></content:encoded>
      </item>`);
    const items = parseFeedXml(xml);

    assert.equal(items.length, 1);
    assert.equal(items[0].summary, null, "there genuinely is no description in this feed");
    assert.ok(items[0].fullContent, "the article body must NOT be lost");
    assert.ok(
      items[0].fullContent!.includes("Real article prose"),
      "the actual prose must survive extraction"
    );
  });

  it("strips the embedded HTML rather than storing raw markup", () => {
    const xml = rssFeed(`
      <item>
        <title>Formatted</title>
        <link>https://example.com/formatted</link>
        <content:encoded><![CDATA[<h2>Heading</h2><p>First paragraph.</p><p>Second paragraph.</p>]]></content:encoded>
      </item>`);
    const full = parseFeedXml(xml)[0].fullContent!;

    assert.ok(!full.includes("<p>"), "no markup may survive into the stored text");
    assert.ok(!full.includes("<h2>"));
    assert.ok(full.includes("Heading"));
    assert.ok(full.includes("First paragraph."));
    assert.ok(full.includes("Second paragraph."));
    assert.ok(
      !/First paragraph\.Second/.test(full),
      "adjacent blocks must not glue together when their tags are removed"
    );
  });

  it("drops <script>/<style> content entirely, not just their tags", () => {
    const xml = rssFeed(`
      <item>
        <title>With junk</title>
        <link>https://example.com/junk</link>
        <content:encoded><![CDATA[<script>var tracking = "leak-me";</script><style>.x{color:red}</style><p>The actual article body text goes here and is long enough to matter.</p>]]></content:encoded>
      </item>`);
    const full = parseFeedXml(xml)[0].fullContent!;

    assert.ok(!full.includes("leak-me"), "script contents must not become article text");
    assert.ok(!full.includes("color:red"), "style contents must not become article text");
    assert.ok(full.includes("The actual article body text"));
  });

  it("returns null when the item has no <content:encoded> at all", () => {
    const xml = rssFeed(`
      <item>
        <title>Summary only</title>
        <link>https://example.com/summary-only</link>
        <description>Just a teaser.</description>
      </item>`);
    const item = parseFeedXml(xml)[0];

    assert.equal(item.fullContent, null);
    assert.equal(item.summary, "Just a teaser.", "the summary path is untouched by this change");
  });

  it("keeps summary and fullContent SEPARATE when the feed ships both", () => {
    // A publisher giving the reader a blurb AND the article: each belongs in
    // its own field, so `resolveArticleContent` can prefer the better one.
    const body = "The complete article body, far longer than the teaser sentence. ".repeat(5);
    const xml = rssFeed(`
      <item>
        <title>Both</title>
        <link>https://example.com/both</link>
        <description><![CDATA[A one-line teaser.]]></description>
        <content:encoded><![CDATA[<p>${body}</p>]]></content:encoded>
      </item>`);
    const item = parseFeedXml(xml)[0];

    assert.equal(item.summary, "A one-line teaser.");
    assert.ok(item.fullContent!.includes("The complete article body"));
    assert.ok(
      item.fullContent!.length > item.summary!.length,
      "the two fields must not have collapsed into the same value"
    );
  });

  it("decodes HTML entities in the extracted body", () => {
    const xml = rssFeed(`
      <item>
        <title>Entities</title>
        <link>https://example.com/entities</link>
        <content:encoded><![CDATA[<p>Ben &amp; Jerry&#8217;s launched something &hellip; new today, and the story runs on.</p>]]></content:encoded>
      </item>`);
    const full = parseFeedXml(xml)[0].fullContent!;

    assert.ok(full.includes("Ben & Jerry’s"));
    assert.ok(full.includes("…"));
  });

  it("handles <content:encoded> without CDATA wrapping", () => {
    const xml = rssFeed(`
      <item>
        <title>No CDATA</title>
        <link>https://example.com/no-cdata</link>
        <content:encoded>&lt;p&gt;Plain escaped markup carrying the real article body text.&lt;/p&gt;</content:encoded>
      </item>`);
    const full = parseFeedXml(xml)[0].fullContent;

    assert.ok(full, "an un-CDATA'd content:encoded must still yield text");
    assert.ok(full!.includes("Plain escaped markup carrying the real article body text."));
  });

  it("does not confuse <content:encoded> with a plain <content> element", () => {
    // Atom's own <content> is a different element and keeps using the existing
    // summary chain — this fix must not hijack it.
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Atom entry</title>
        <link href="https://example.com/atom-entry" rel="alternate"/>
        <content>Atom content body.</content>
      </entry>
    </feed>`;
    const item = parseFeedXml(xml)[0];

    assert.equal(item.fullContent, null, "a bare <content> is not <content:encoded>");
    assert.equal(item.summary, "Atom content body.", "it still reaches the summary chain");
  });
});
