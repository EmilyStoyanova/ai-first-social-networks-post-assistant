import { resolveImageUrl } from "./article-image";
import { safeFetch, type DnsResolver } from "./article-extractor";

export interface ParsedFeedItem {
  title: string | null;
  url: string | null;
  summary: string | null;
  publishedAt: Date | null;
  /**
   * An image the FEED itself supplies — `<media:content>`, `<media:thumbnail>`
   * or an image `<enclosure>`. A weaker signal than the article's own og:image
   * (feeds often carry a cropped thumbnail), so ingestion uses it only when the
   * page declared nothing.
   */
  imageUrl: string | null;
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

/**
 * The text of an item's `<tag>`, unwrapping CDATA when the feed uses it.
 *
 * The element is matched ONCE and its CDATA sections are then collected from the
 * inner text, rather than requiring `<tag><![CDATA[` to be adjacent. That adjacency
 * is what ArchDaily's feed breaks — it pretty-prints every field as
 *
 *     <title>
 *       <![CDATA[Modernism on the Watch: Preserving the ... Stadium in India]]>
 *     </title>
 *
 * and the newline meant the CDATA form never matched. The plain fallback then ran
 * `replace(/<[^>]+>/g, "")` over `<![CDATA[…]]>`, which contains no `>` until its own
 * terminator and so was consumed WHOLE as if it were a single tag — deleting the title
 * and storing the article as `(untitled)`. Collecting sections also handles an element
 * that carries more than one, which is concatenated rather than truncated to the first.
 *
 * Markup inside a CDATA section is deliberately preserved, exactly as it always was for
 * the adjacent form: a feed's `<description>` is routinely an HTML excerpt, and callers
 * (translation input sanitising, article extraction) already strip tags themselves.
 */
function extractText(xml: string, tag: string): string | null {
  const element = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (!element) return null;
  const inner = element[1];

  const sections = [...inner.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((m) => m[1]);
  const text =
    sections.length > 0 ? sections.join("").trim() : inner.replace(/<[^>]+>/g, "").trim();

  return text ? decodeEntities(text) : null;
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

/**
 * The item's own image, if the feed bothered to attach one.
 *
 * Read from the SAME body-stripped copy link resolution uses: an article that
 * embeds a newsletter form or an ad in `<content:encoded>` must not have that
 * markup's imagery mistaken for the item's picture.
 *
 * `<enclosure>` is podcast-shaped and carries audio and video too, so only an
 * explicitly image-typed one counts. Media RSS `medium="image"` is treated the
 * same way, while a `<media:thumbnail>` is an image by definition.
 */
function extractFeedImage(strippedXml: string, baseUrl: string | null): string | null {
  const candidates: Array<string | null> = [];

  for (const match of strippedXml.matchAll(/<media:content\b([^>]*?)\/?>/gi)) {
    const attrs = match[1];
    const type = attrs.match(/\btype=["']([^"']+)["']/i)?.[1]?.toLowerCase() ?? "";
    const medium = attrs.match(/\bmedium=["']([^"']+)["']/i)?.[1]?.toLowerCase() ?? "";
    if (medium && medium !== "image") continue;
    if (type && !type.startsWith("image/")) continue;
    if (!medium && !type) continue; // Unlabelled: could be the audio track.
    candidates.push(attrs.match(/\burl=["']([^"']+)["']/i)?.[1] ?? null);
  }

  for (const match of strippedXml.matchAll(/<media:thumbnail\b([^>]*?)\/?>/gi)) {
    candidates.push(match[1].match(/\burl=["']([^"']+)["']/i)?.[1] ?? null);
  }

  for (const match of strippedXml.matchAll(/<enclosure\b([^>]*?)\/?>/gi)) {
    const attrs = match[1];
    const type = attrs.match(/\btype=["']([^"']+)["']/i)?.[1]?.toLowerCase() ?? "";
    if (!type.startsWith("image/")) continue;
    candidates.push(attrs.match(/\burl=["']([^"']+)["']/i)?.[1] ?? null);
  }

  for (const candidate of candidates) {
    const resolved = resolveImageUrl(candidate, baseUrl);
    if (resolved) return resolved;
  }
  return null;
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

    // Link and image resolution both run on a copy with the article body
    // stripped out, so embedded HTML can never influence either.
    const stripped = stripEmbeddedContent(item);
    const url = extractLink(stripped, kind);

    return {
      title: extractText(item, "title"),
      url,
      imageUrl: extractFeedImage(stripped, url),
      summary:
        extractText(item, "description") ??
        extractText(item, "summary") ??
        extractText(item, "content"),
      publishedAt: parseDate(pubRaw),
    };
  });
}

export interface ParseFeedOptions {
  /** Injectable DNS resolver — tests avoid real lookups. */
  resolve?: DnsResolver;
  /** Injectable fetch — tests avoid real network requests. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Thrown when the feed URL — or a redirect target it issues — fails the
 * SSRF/redirect safety gate (`safeFetch`), or when the redirect chain itself
 * is malformed, too long, or looping. A feed URL is user-configurable (both
 * an owner's normal RSS source and a competitor's), so it gets the same
 * per-hop validation `extractArticle` already applies to article links —
 * previously this function performed a bare `fetch` with automatic redirect
 * following and no SSRF check of its own at all.
 */
export class FeedFetchBlockedError extends Error {
  constructor(url: string, reason: string) {
    super(`Refused to fetch feed URL "${url}": ${reason}`);
    this.name = "FeedFetchBlockedError";
  }
}

export async function parseFeed(
  url: string,
  options?: ParseFeedOptions
): Promise<ParsedFeedItem[]> {
  const result = await safeFetch(url, {
    resolve: options?.resolve,
    fetch: options?.fetch,
    // Bypasses Next.js's fetch Data Cache — a feed must always be read fresh,
    // exactly as the bare `fetch` this replaces already requested.
    cache: "no-store",
  });
  if (!result.ok) throw new FeedFetchBlockedError(url, result.reason);

  const res = result.response;
  if (!res.ok) throw new Error(`Feed fetch failed: ${res.status} ${res.statusText}`);
  const xml = await res.text();
  return parseFeedXml(xml);
}
