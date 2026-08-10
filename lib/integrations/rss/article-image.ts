/**
 * Finding the main image of a source article.
 *
 * Publishers advertise their lead image in metadata precisely so link previews
 * can show it, so that is what we read first and trust most:
 *
 *   1. og:image        — the social-preview image, what the publisher chose
 *   2. twitter:image   — the same idea, for sites that only set the Twitter card
 *   3. JSON-LD         — schema.org Article.image
 *   (4. the feed's own media/enclosure — supplied by the caller, see parser.ts)
 *   5. the article body — a genuinely large image inside the extracted content
 *
 * Everything is funnelled through `resolveImageUrl`, which throws out the
 * category of URL that makes this feature embarrassing rather than useful:
 * tracking pixels, favicons, author avatars, sprite sheets, share-button icons,
 * and `data:` URIs. A missing image is a fine outcome — the post simply keeps
 * its AI image and the action is never offered.
 */

/** Extensions we never want, whatever the tag claims. SVG is always a logo. */
const REJECTED_EXTENSIONS = /\.(svg|svgz|ico|bmp|tif|tiff|pdf)(?:$|[?#])/i;

/**
 * Filename/path fragments that mark chrome rather than content. Matched against
 * the path only — a query string can legitimately contain "logo" as a CDN
 * parameter, and an article at /news/logo-redesign-2026 must not be excluded, so
 * the match is anchored to a path SEGMENT boundary.
 */
const JUNK_PATH_WORDS = [
  "ad",
  "ads",
  "advert",
  "avatar",
  "badge",
  "banner",
  "beacon",
  "blank",
  "button",
  "emoji",
  "favicon",
  "gravatar",
  "icon",
  "logo",
  "pixel",
  "placeholder",
  "profile-pic",
  "promo",
  "related",
  "share",
  "sponsor",
  "sponsored",
  "sprite",
  "spacer",
  "thumb-default",
  "tracking",
  "watermark",
  "widget",
];

/**
 * Words that mark a SITE-WIDE image rather than this article's own — the single
 * fallback picture a CMS stamps into og:image on every page that forgot to set
 * one. That is the commonest way this feature picks something bland but legal:
 * the URL is a perfectly good image, just not a picture OF anything here.
 *
 * Deliberately softer than the list above. Such a URL is not rejected — it is
 * only demoted below a real in-content image, and still used when there is
 * nothing else. Over-rejecting here would cost real lead images; over-demoting
 * costs nothing, because the alternative had to exist to win.
 */
const GENERIC_PATH_WORDS = [
  "default",
  "default-image",
  "fallback",
  "generic",
  "no-image",
  "noimage",
  "og-default",
  "og-image",
  "og_image",
  "opengraph",
  "site-image",
  "sitewide",
  "social",
];

/** 1x1 (and other degenerate) sizes spelled into the filename or query. */
const DEGENERATE_SIZE = /(?:^|[^0-9])[123]x[123](?:[^0-9]|$)/i;

/** The smallest edge we accept when a size is actually known. */
const MIN_EDGE_PX = 200;

function hasWord(pathname: string, words: readonly string[]): boolean {
  const lower = pathname.toLowerCase();
  return words.some((word) => {
    let at = lower.indexOf(word);
    while (at !== -1) {
      // Require a non-alphanumeric boundary on both sides so "logo" matches
      // "/site-logo.png" and "/logo/x.png" but not "/blog/other.png".
      const before = at === 0 ? "" : lower[at - 1];
      const after = lower[at + word.length] ?? "";
      if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
      // Keep looking: an early unbounded hit must not hide a later real one,
      // which "/blog/ads/x.png" ("ad" inside "blog" first) depends on.
      at = lower.indexOf(word, at + 1);
    }
    return false;
  });
}

function hasJunkWord(pathname: string): boolean {
  return hasWord(pathname, JUNK_PATH_WORDS);
}

/**
 * True when a URL looks like a site-wide fallback rather than this page's own
 * picture. Only ever demotes a candidate — see GENERIC_PATH_WORDS.
 */
export function isGenericImageUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return hasWord(new URL(url).pathname, GENERIC_PATH_WORDS);
  } catch {
    return false;
  }
}

/**
 * Reads a size hint out of the URL itself — `?w=64`, `?width=64`, `/64x64/`.
 * Returns null when the URL says nothing, which is NOT a rejection: most real
 * article images carry no size in their address.
 */
function urlSizeHint(url: URL): { width: number; height: number } | null {
  const params = url.searchParams;
  const w = Number(params.get("w") ?? params.get("width") ?? NaN);
  const h = Number(params.get("h") ?? params.get("height") ?? NaN);
  if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    return { width: w, height: h };
  }

  const dims = url.pathname.match(/(?:^|[^0-9])(\d{2,4})x(\d{2,4})(?:[^0-9]|$)/);
  if (dims) return { width: Number(dims[1]), height: Number(dims[2]) };

  return null;
}

/**
 * Normalizes one candidate to an absolute http(s) URL, or rejects it.
 *
 * `baseUrl` resolves the relative `/images/lead.jpg` form that plenty of sites
 * still put in og:image. Anything that is not plain http(s) — `data:`,
 * `javascript:`, `blob:`, a protocol-relative form we cannot resolve — is
 * dropped rather than repaired, so nothing unfetchable is ever persisted.
 */
export function resolveImageUrl(
  raw: string | null | undefined,
  baseUrl?: string | null
): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2000) return null;

  let url: URL;
  try {
    // Without a base, only an already-absolute address can resolve — which is
    // exactly right for a feed enclosure, whose item may have no link at all.
    url = new URL(trimmed, baseUrl ?? undefined);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (REJECTED_EXTENSIONS.test(url.pathname)) return null;
  if (hasJunkWord(url.pathname)) return null;
  if (DEGENERATE_SIZE.test(url.pathname) || DEGENERATE_SIZE.test(url.search)) return null;

  const hint = urlSizeHint(url);
  if (hint && (hint.width < MIN_EDGE_PX || hint.height < MIN_EDGE_PX)) return null;

  return url.toString();
}

/**
 * The one place the priority between the three candidate sources is decided.
 *
 * What the PUBLISHER declared for the page wins — it is the image they chose to
 * represent the article. The feed's own attachment comes next: real, but often a
 * cropped thumbnail sized for a reader app. Scanning the article body is last,
 * because it is the only candidate nobody nominated.
 *
 * The one exception: a metadata image that looks like the site's stock fallback
 * (`/img/default-share.png` and friends) is NOT the image the publisher chose
 * for this article — it is the one they chose for every article. It drops to the
 * back of the queue, so a genuine picture from the feed or the body beats it,
 * and it is still used when there is nothing else. Nothing is discarded.
 */
export function pickSourceImage(candidates: {
  metaImageUrl?: string | null;
  feedImageUrl?: string | null;
  contentImageUrl?: string | null;
}): string | null {
  const meta = candidates.metaImageUrl ?? null;
  if (meta && !isGenericImageUrl(meta)) return meta;
  return candidates.feedImageUrl ?? candidates.contentImageUrl ?? meta ?? null;
}

// ─── Metadata candidates ──────────────────────────────────────────────────────

/** og:* and twitter:* appear under `property` on some sites and `name` on others. */
function metaContent(doc: Document, key: string): string | null {
  const el =
    doc.querySelector(`meta[property="${key}"]`) ?? doc.querySelector(`meta[name="${key}"]`);
  return el?.getAttribute("content") ?? null;
}

/** Pulls every plausible image string out of one JSON-LD value. */
function jsonLdImages(node: unknown, out: string[]): void {
  if (typeof node === "string") {
    out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const entry of node) jsonLdImages(entry, out);
    return;
  }
  if (node && typeof node === "object") {
    const url = (node as { url?: unknown }).url;
    if (typeof url === "string") out.push(url);
  }
}

/**
 * schema.org `image` from any JSON-LD block on the page, including the `@graph`
 * wrapper Yoast and friends emit. Article-ish types are preferred, but a page
 * that only describes itself as a WebPage still has a usable lead image, so a
 * non-Article block is taken rather than discarded.
 */
function jsonLdImage(doc: Document): string[] {
  const preferred: string[] = [];
  const fallback: string[] = [];

  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script.textContent ?? "");
    } catch {
      continue; // A malformed block is common and must never break ingestion.
    }

    const blocks: unknown[] = [];
    const collect = (node: unknown) => {
      if (Array.isArray(node)) {
        node.forEach(collect);
      } else if (node && typeof node === "object") {
        blocks.push(node);
        const graph = (node as { "@graph"?: unknown })["@graph"];
        if (graph) collect(graph);
      }
    };
    collect(parsed);

    for (const block of blocks) {
      const record = block as { "@type"?: unknown; image?: unknown };
      if (record.image === undefined) continue;
      const types = Array.isArray(record["@type"]) ? record["@type"] : [record["@type"]];
      const isArticle = types.some(
        (t) => typeof t === "string" && /article|blogposting|newsarticle/i.test(t)
      );
      jsonLdImages(record.image, isArticle ? preferred : fallback);
    }
  }

  return [...preferred, ...fallback];
}

/**
 * The image the PUBLISHER declared for this page, in priority order.
 *
 * Must be called BEFORE Readability runs: `Readability.parse()` rewrites the
 * document it is given, and the `<head>` this reads may not survive it.
 */
export function selectMetaImage(doc: Document, baseUrl: string): string | null {
  const candidates: Array<string | null> = [
    metaContent(doc, "og:image:secure_url"),
    metaContent(doc, "og:image:url"),
    metaContent(doc, "og:image"),
    metaContent(doc, "twitter:image"),
    metaContent(doc, "twitter:image:src"),
    ...jsonLdImage(doc),
  ];

  for (const candidate of candidates) {
    const resolved = resolveImageUrl(candidate, baseUrl);
    if (resolved) return resolved;
  }
  return null;
}

// ─── In-content fallback ──────────────────────────────────────────────────────

/** `<source>` is matched too — it is where `<picture>` keeps the real image. */
const MEDIA_TAG = /<(img|source)\b[^>]*>/gi;

function attr(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return match?.[1]?.trim() ?? null;
}

/**
 * Splits a srcset on the commas that separate candidates, and not on the ones
 * inside a URL — CDN transformation paths like `/upload/w_300,h_200/pic.jpg` are
 * full of those. A comma counts as a separator when it follows a `320w`/`2x`
 * descriptor, when whitespace follows it, or when the next candidate visibly
 * starts an address.
 */
const SRCSET_SEPARATOR = /(?<=[0-9][wx])\s*,\s*|\s*,\s+|,(?=(?:https?:)?\/)/i;

/**
 * The candidates of a srcset, LARGEST FIRST.
 *
 * srcset is written smallest-first by convention, so taking the head of the list
 * reliably picked the phone-sized crop — a 320px-wide thumbnail standing in for
 * the article's lead image. Width descriptors decide when present, pixel
 * densities when they are all there is, and document order when the author wrote
 * neither.
 *
 * Every entry is returned, not just the winner, so the caller's junk filter can
 * fall through to the next-largest rather than giving up on the tag.
 */
export function srcsetCandidates(value: string | null | undefined): string[] {
  if (!value) return [];

  const entries: Array<{ url: string; width: number | null; density: number | null }> = [];
  for (const part of value.split(SRCSET_SEPARATOR)) {
    const [url, descriptor] = part.trim().split(/\s+/);
    if (!url) continue;
    const width = descriptor?.match(/^([0-9.]+)w$/i);
    const density = descriptor?.match(/^([0-9.]+)x$/i);
    entries.push({
      url,
      width: width ? Number(width[1]) : null,
      density: density ? Number(density[1]) : null,
    });
  }

  const key = entries.some((e) => e.width !== null)
    ? (e: (typeof entries)[number]) => e.width ?? 0
    : entries.some((e) => e.density !== null)
      ? (e: (typeof entries)[number]) => e.density ?? 0
      : null;

  // Undescribed candidates carry no size information at all — reordering them
  // would only be guesswork, so the author's order stands.
  if (!key) return entries.map((e) => e.url);

  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => key(b.entry) - key(a.entry) || a.index - b.index)
    .map(({ entry }) => entry.url);
}

/**
 * Last resort: the first genuinely large image inside the article body Readability
 * kept. Readability has already discarded navigation, sidebars and comment
 * threads, so what is left is at least in the right part of the page.
 *
 * An image is taken only when it does NOT look small. A declared `width`/`height`
 * under 200px is a decisive reject; no declared size at all is accepted, because
 * most publishers omit the attributes on their lead image.
 *
 * `<picture>` is walked as well: its `<source>` elements carry the real art, and
 * the `<img>` inside it is only the fallback. They are read in document order,
 * so a `<source>` still yields to an earlier, larger image.
 */
export function selectContentImage(contentHtml: string | null, baseUrl: string): string | null {
  if (!contentHtml) return null;

  for (const match of contentHtml.matchAll(MEDIA_TAG)) {
    const tag = match[0];
    const isSource = match[1].toLowerCase() === "source";

    const width = Number(attr(tag, "width"));
    const height = Number(attr(tag, "height"));
    if (Number.isFinite(width) && width > 0 && width < MIN_EDGE_PX) continue;
    if (Number.isFinite(height) && height > 0 && height < MIN_EDGE_PX) continue;

    // <source> also belongs to <video> and <audio>. Those declare their track in
    // `src` with a non-image `type`, so requiring a srcset and refusing a
    // declared non-image type keeps an MP4 out of the post.
    if (isSource) {
      const type = attr(tag, "type")?.toLowerCase() ?? "";
      if (type && !type.startsWith("image/")) continue;
    }

    // Lazy-loading markup keeps the real address in data-src / srcset and leaves
    // `src` as a placeholder, so those are read first.
    const fromSrcset = srcsetCandidates(attr(tag, "srcset") ?? attr(tag, "data-srcset"));
    const candidates = isSource
      ? fromSrcset
      : [attr(tag, "data-src"), attr(tag, "data-original"), ...fromSrcset, attr(tag, "src")];

    for (const candidate of candidates) {
      const resolved = resolveImageUrl(candidate, baseUrl);
      if (resolved) return resolved;
    }
  }

  return null;
}
