import { lookup } from "node:dns/promises";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { isGenericImageUrl, selectContentImage, selectMetaImage } from "./article-image";
import {
  extractArticleBody,
  type ExtractionMethod,
  type StrategyResult,
} from "./article-strategies";

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Raised from 8s. A long-form article page from a large publisher is routinely
 * over a megabyte of markup, and the old budget turned a slow-but-working fetch
 * into "no article" — indistinguishable, downstream, from a paywall.
 */
const FETCH_TIMEOUT_MS = 15_000;

// ─── SSRF protection ─────────────────────────────────────────────────────────

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false; // Not an IPv4 address — don't treat as private
  const nums = parts.map(Number);
  if (nums.some((n) => isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums;
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // 10.0.0.0/8
    a === 127 || // 127.0.0.0/8 loopback
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) // 192.168.0.0/16
  );
}

function isPrivateIPv6(ip: string): boolean {
  const clean = ip
    .toLowerCase()
    .replace(/%.*$/, "")
    .replace(/^\[|\]$/g, "");
  return (
    clean === "::1" || // loopback
    clean.startsWith("fc") || // fc00::/7 (first half)
    clean.startsWith("fd") || // fc00::/7 (second half)
    /^fe[89ab]/i.test(clean) // fe80::/10 link-local
  );
}

function isSafeHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".local") || lower.endsWith(".internal")) {
    return false;
  }
  // Reject raw private IPs in the hostname field
  return !isPrivateIPv4(lower) && !isPrivateIPv6(lower);
}

export type DnsResolver = (
  hostname: string,
  options: { all: true }
) => Promise<Array<{ address: string; family: number }>>;

/**
 * Returns true if the URL is safe to fetch: https/http scheme, non-private hostname,
 * and all DNS-resolved addresses are public.
 * Exported so tests can inject a fake resolver.
 */
export async function checkSsrf(url: URL, resolve: DnsResolver = lookup): Promise<boolean> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (!isSafeHostname(url.hostname)) return false;

  try {
    const records = await resolve(url.hostname, { all: true });
    for (const { address, family } of records) {
      if (family === 4 && isPrivateIPv4(address)) return false;
      if (family === 6 && isPrivateIPv6(address)) return false;
    }
  } catch {
    return false;
  }
  return true;
}

// ─── HTML → text + image ──────────────────────────────────────────────────────

/** Everything one parse of an article page yields. Each part stands alone: a
 *  paywalled page with no readable text can still advertise a perfectly good
 *  og:image, and a page with plenty of text may have no image at all. */
export interface ExtractedArticle {
  /** Clean article text, or null when nothing substantial could be extracted. */
  text: string | null;
  /**
   * Which reader produced `text` — provenance, stored with the item so a thin
   * article can be told apart from a fully read one after the fact. Null
   * whenever `text` is null.
   */
  method: Exclude<ExtractionMethod, "rss_summary"> | null;
  /**
   * Why extraction produced no text, in one line. The whole point of this field
   * is that "blocked", "timed out" and "parse threw" used to be the same
   * observable outcome as "this page genuinely has no article".
   */
  error: string | null;
  /** The image the publisher declared for the page (og / twitter / JSON-LD). */
  metaImageUrl: string | null;
  /** A large image found inside the article body — the weakest candidate. */
  contentImageUrl: string | null;
}

function emptyArticle(error: string | null): ExtractedArticle {
  return { text: null, method: null, error, metaImageUrl: null, contentImageUrl: null };
}

/**
 * Parses raw HTML with jsdom + Readability ONCE and returns both the article
 * text and its image candidates.
 *
 * Order matters: the metadata is read before `Readability.parse()`, which
 * rewrites the document it is handed. The in-content candidate is then taken
 * from Readability's OWN output, so it is already free of navigation, sidebars
 * and comment threads.
 *
 * Exported so tests can call it directly without network I/O.
 */
export function extractArticleParts(html: string, baseUrl: string): ExtractedArticle {
  let dom: JSDOM | null = null;
  try {
    dom = new JSDOM(html, { url: baseUrl });
    const doc = dom.window.document;

    const metaImageUrl = selectMetaImage(doc, baseUrl);

    // Held from inside the cascade so the ONE Readability parse serves both the
    // text and the in-content image. `extractArticleBody` invokes this callback
    // last, after the strategies that need un-rewritten markup have run.
    let article: ReturnType<Readability["parse"]> = null;
    const chosen: StrategyResult | null = extractArticleBody(doc, () => {
      article = new Readability(doc).parse();
      return article?.textContent ?? null;
    });

    // Skipped when the publisher declared a real one — scanning the body cannot
    // beat a deliberate og:image, and it is the more expensive path. A metadata
    // image that is only the site's stock fallback does NOT count as declared,
    // so the body is searched for something that actually depicts this article;
    // pickSourceImage decides between the two.
    const needsContentImage = !metaImageUrl || isGenericImageUrl(metaImageUrl);

    return {
      text: chosen?.text ?? null,
      method: chosen?.method ?? null,
      // Every reader ran and none cleared MIN_ARTICLE_LENGTH. That is a real
      // finding about the page — most often a consent shell or a paywall stub —
      // and it is recorded rather than left to look like an empty article.
      error: chosen ? null : "no_article_text",
      metaImageUrl,
      contentImageUrl: needsContentImage
        ? selectContentImage(
            (article as { content?: string | null } | null)?.content ?? null,
            baseUrl
          )
        : null,
    };
  } catch (err) {
    // Was silent. A jsdom fault on a megabyte of markup is one of the ways this
    // pipeline loses an article, and swallowing it made that indistinguishable
    // from a page that simply has no body.
    const message = err instanceof Error ? err.message : String(err);
    console.error("[article-extraction] parse failed", { url: baseUrl, error: message });
    return emptyArticle(`parse_failed: ${message}`);
  } finally {
    // jsdom keeps a live window (timers, event loop hooks, the whole DOM) alive
    // until it is closed. Ingestion parses one of these per feed item in a
    // single process, so leaving them open is how a large feed climbs into the
    // memory ceiling partway through a run.
    dom?.window.close();
  }
}

/**
 * Clean article text only, or null if no substantial content can be extracted.
 * Exported so tests can call it directly without network I/O.
 */
export function extractReadableText(html: string, baseUrl: string): string | null {
  return extractArticleParts(html, baseUrl).text;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export interface ExtractOptions {
  /** Injectable DNS resolver — used in tests to avoid real network lookups. */
  resolve?: DnsResolver;
  /** Injectable fetch — used in tests to avoid real network requests. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Fetches the article at `rawUrl` and extracts its text and image candidates.
 * Returns empty parts on any failure (network, SSRF, non-HTML, unparseable).
 * Never throws — callers fall back to the RSS summary on a null `text`, and
 * simply store no source image on a null image.
 */
export async function extractArticle(
  rawUrl: string | null,
  options?: ExtractOptions
): Promise<ExtractedArticle> {
  if (!rawUrl) return emptyArticle("no_url");

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return emptyArticle("invalid_url");
  }

  const fetchFn = options?.fetch ?? fetch;

  if (!(await checkSsrf(url, options?.resolve))) return emptyArticle("ssrf_blocked");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let html: string;
  try {
    const res = await fetchFn(rawUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; RSS content reader)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn("[article-extraction] fetch rejected", { url: rawUrl, status: res.status });
      return emptyArticle(`http_${res.status}`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) return emptyArticle(`non_html: ${contentType}`);
    html = await res.text();
  } catch (err) {
    clearTimeout(timer);
    // Distinguishes an abort (the timeout fired) from a transport error. Both
    // used to be the same silent null.
    const message = err instanceof Error ? err.message : String(err);
    const reason = controller.signal.aborted ? `timeout_${FETCH_TIMEOUT_MS}ms` : `fetch_failed`;
    console.error("[article-extraction] fetch failed", { url: rawUrl, reason, error: message });
    return emptyArticle(`${reason}: ${message}`);
  }

  // Resolved against the FETCHED url, not the requested one, so a feed link that
  // redirects to the publisher's domain still yields absolute image addresses.
  return extractArticleParts(html, rawUrl);
}

/**
 * Fetches the article at `rawUrl` and extracts the main readable text.
 * Returns null on any failure (network, SSRF, non-HTML, thin/paywalled content).
 * Never throws — callers should fall back to the RSS summary on null.
 */
export async function extractArticleContent(
  rawUrl: string | null,
  options?: ExtractOptions
): Promise<string | null> {
  return (await extractArticle(rawUrl, options)).text;
}

// ─── What ingestion stores ────────────────────────────────────────────────────

/**
 * The content decision for one feed item, with its provenance attached.
 *
 * This type exists because the decision used to be the expression
 * `extracted.text ?? item.summary` — which silently equated "the article" with
 * "the one-sentence blurb the feed shipped". Both still end up in `content`;
 * the difference is that only one of them is now allowed to claim it is the
 * article, and generation reads that claim.
 */
export interface ResolvedArticleContent {
  /** What gets written to `FeedItem.content`. */
  content: string | null;
  /** How it was obtained. Null only when there is no content at all. */
  method: ExtractionMethod | null;
  /** `content.length`, stored so a thin item is greppable without a scan. */
  chars: number;
  /**
   * Whether `content` is the article. FALSE for a feed summary — the flag
   * generation gates on. There is deliberately no third "probably" state: a
   * reader either produced a body over MIN_ARTICLE_LENGTH or it did not.
   */
  complete: boolean;
  /** Why full-text extraction did not produce the article, when it did not. */
  error: string | null;
}

/**
 * Combines a fetch attempt with the feed's own summary into what gets stored.
 *
 * The summary is still the last resort — dropping it would mean losing items
 * whose publisher blocks every reader, and a title plus a blurb is genuinely
 * better than an empty row for a human browsing the feed list. What changes is
 * that it is now LABELLED, so the article/blurb distinction survives into the
 * database instead of being erased at the moment it is made.
 */
export function resolveArticleContent(
  extracted: ExtractedArticle,
  summary: string | null
): ResolvedArticleContent {
  if (extracted.text) {
    return {
      content: extracted.text,
      method: extracted.method,
      chars: extracted.text.length,
      complete: true,
      error: null,
    };
  }

  const fallback = summary?.trim() || null;
  return {
    content: fallback,
    method: fallback ? "rss_summary" : null,
    chars: fallback?.length ?? 0,
    complete: false,
    error: extracted.error ?? "no_article_text",
  };
}
