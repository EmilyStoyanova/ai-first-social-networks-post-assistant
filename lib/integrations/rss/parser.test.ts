import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFeedXml } from "./parser";

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
