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
  "avatar",
  "badge",
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
  "sprite",
  "spacer",
  "thumb-default",
  "tracking",
  "watermark",
];

/** 1x1 (and other degenerate) sizes spelled into the filename or query. */
const DEGENERATE_SIZE = /(?:^|[^0-9])[123]x[123](?:[^0-9]|$)/i;

/** The smallest edge we accept when a size is actually known. */
const MIN_EDGE_PX = 200;

function hasJunkWord(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return JUNK_PATH_WORDS.some((word) => {
    const at = lower.indexOf(word);
    if (at === -1) return false;
    // Require a non-alphanumeric boundary on both sides so "logo" matches
    // "/site-logo.png" and "/logo/x.png" but not "/blog/other.png".
    const before = at === 0 ? "" : lower[at - 1];
    const after = lower[at + word.length] ?? "";
    return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
  });
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
 */
export function pickSourceImage(candidates: {
  metaImageUrl?: string | null;
  feedImageUrl?: string | null;
  contentImageUrl?: string | null;
}): string | null {
  return candidates.metaImageUrl ?? candidates.feedImageUrl ?? candidates.contentImageUrl ?? null;
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

const IMG_TAG = /<img\b[^>]*>/gi;

function attr(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return match?.[1]?.trim() ?? null;
}

/**
 * Last resort: the first genuinely large image inside the article body Readability
 * kept. Readability has already discarded navigation, sidebars and comment
 * threads, so what is left is at least in the right part of the page.
 *
 * An image is taken only when it does NOT look small. A declared `width`/`height`
 * under 200px is a decisive reject; no declared size at all is accepted, because
 * most publishers omit the attributes on their lead image.
 */
export function selectContentImage(contentHtml: string | null, baseUrl: string): string | null {
  if (!contentHtml) return null;

  for (const match of contentHtml.matchAll(IMG_TAG)) {
    const tag = match[0];
    const width = Number(attr(tag, "width"));
    const height = Number(attr(tag, "height"));
    if (Number.isFinite(width) && width > 0 && width < MIN_EDGE_PX) continue;
    if (Number.isFinite(height) && height > 0 && height < MIN_EDGE_PX) continue;

    // Lazy-loading markup keeps the real address in data-src / srcset and leaves
    // `src` as a placeholder, so those are read first.
    const srcset = attr(tag, "srcset") ?? attr(tag, "data-srcset");
    const firstFromSrcset = srcset?.split(",")[0]?.trim().split(/\s+/)[0] ?? null;
    const candidates = [
      attr(tag, "data-src"),
      attr(tag, "data-original"),
      firstFromSrcset,
      attr(tag, "src"),
    ];

    for (const candidate of candidates) {
      const resolved = resolveImageUrl(candidate, baseUrl);
      if (resolved) return resolved;
    }
  }

  return null;
}
