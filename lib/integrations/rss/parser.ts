export interface ParsedFeedItem {
  title: string | null;
  url: string | null;
  summary: string | null;
  publishedAt: Date | null;
}

/** Which flavour of feed an item came from — drives how its link is resolved. */
type FeedKind = "rss" | "atom";

/**
 * Named HTML entities that appear in feed titles/summaries but are NOT valid in
 * raw XML (XML predefines only amp/lt/gt/quot/apos). WordPress and many CMSes
 * emit these anyway. Numeric entities (&#8217;, &#x2019;) are handled generically
 * below, so this map only needs the named ones worth spelling out.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…", // …
  mdash: "—", // —
  ndash: "–", // –
  lsquo: "‘", // ‘
  rsquo: "’", // ’
  ldquo: "“", // “
  rdquo: "”", // ”
  laquo: "«", // «
  raquo: "»", // »
  copy: "©", // ©
  reg: "®", // ®
  trade: "™", // ™
  deg: "°", // °
};

/**
 * Decodes HTML entities (named, decimal, and hex) into their characters in a
 * single pass, so `Startup&#8217;s`, `&#8220;quoted&#8221;`, `A &amp; B`, and
 * `&#8230;` become human-readable. A single pass avoids double-decoding (e.g.
 * `&amp;#8217;` decodes only its outer `&amp;`). Unknown named entities are left
 * verbatim rather than dropped.
 */
function decodeEntities(input: string): string {
  return input.replace(/&(#[Xx][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body];
    return named !== undefined ? named : match;
  });
}

function extractText(xml: string, tag: string): string | null {
  const cdata = xml.match(
    new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, "i")
  );
  if (cdata) {
    const text = cdata[1].trim();
    return text ? decodeEntities(text) : null;
  }

  const plain = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (plain) {
    const text = plain[1].replace(/<[^>]+>/g, "").trim();
    return text ? decodeEntities(text) : null;
  }
  return null;
}

/**
 * Strips an item's content-bearing child elements (article body, summary) so
 * that HTML embedded inside them cannot be mistaken for the item's own link.
 *
 * This is the StartupNation bug: each `<content:encoded>` embeds a Mailchimp
 * signup form carrying its own `<link href="//cdn-images.mailchimp.com/.../classic.css"/>`
 * stylesheet tag. Without this strip, link extraction latched onto that shared
 * stylesheet URL, collapsing every article in the feed onto a single row.
 *
 * Only used for link resolution — summary/title extraction still reads the
 * original item so the article body is preserved.
 */
function stripEmbeddedContent(xml: string): string {
  return xml
    .replace(/<content:encoded[\s\S]*?<\/content:encoded>/gi, "")
    .replace(/<description[\s\S]*?<\/description>/gi, "")
    .replace(/<summary[\s\S]*?<\/summary>/gi, "")
    .replace(/<content[\s>][\s\S]*?<\/content>/gi, "");
}

/**
 * Resolves an item's canonical link.
 *
 * RSS 2.0 uses only the item's own `<link>text</link>` element. A bare `<link>`
 * (no attributes) never matches an embedded HTML `<link href="..."/>` tag, so
 * stylesheets/scripts inside the article body cannot hijack the result.
 *
 * Atom `<entry>` has no text-form link — it carries one or more
 * `<link href="..."/>` elements. We prefer `rel="alternate"` (or a link with no
 * `rel`, which defaults to alternate per the Atom spec) and ignore
 * `self`/`edit`/`enclosure`/etc.
 */
function extractLink(xml: string, kind: FeedKind): string | null {
  if (kind === "atom") {
    let fallback: string | null = null;
    for (const match of xml.matchAll(/<link\b([^>]*?)\/?>/gi)) {
      const attrs = match[1];
      const href = attrs.match(/\bhref=["']([^"']+)["']/i)?.[1]?.trim();
      if (!href) continue;
      const rel = attrs.match(/\brel=["']([^"']+)["']/i)?.[1]?.toLowerCase();
      if (rel === undefined || rel === "alternate") return href;
      if (fallback === null) fallback = href;
    }
    return fallback;
  }

  // RSS 2.0: <link>http://...</link> — deliberately does NOT match <link href="...">.
  const text = xml.match(/<link>([^<]+)<\/link>/i);
  return text ? text[1].trim() || null : null;
}

function parseDate(raw: string | null): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

function splitItems(xml: string): { kind: FeedKind; items: string[] } {
  const rssItems = [...xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)].map((m) => m[0]);
  if (rssItems.length > 0) return { kind: "rss", items: rssItems };
  const atomItems = [...xml.matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/gi)].map((m) => m[0]);
  return { kind: "atom", items: atomItems };
}

/**
 * Pure feed parser — turns raw feed XML into items. Exported so parsing can be
 * unit-tested without network I/O.
 */
export function parseFeedXml(xml: string): ParsedFeedItem[] {
  const { kind, items } = splitItems(xml);

  return items.map((item) => {
    const pubRaw =
      extractText(item, "pubDate") ??
      extractText(item, "published") ??
      extractText(item, "updated") ??
      extractText(item, "dc:date");

    return {
      title: extractText(item, "title"),
      // Link resolution runs on a copy with the article body stripped out, so
      // embedded HTML links can never influence it.
      url: extractLink(stripEmbeddedContent(item), kind),
      summary:
        extractText(item, "description") ??
        extractText(item, "summary") ??
        extractText(item, "content"),
      publishedAt: parseDate(pubRaw),
    };
  });
}

export async function parseFeed(url: string): Promise<ParsedFeedItem[]> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Feed fetch failed: ${res.status} ${res.statusText}`);
  const xml = await res.text();
  return parseFeedXml(xml);
}
