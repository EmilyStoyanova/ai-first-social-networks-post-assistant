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

// ─── Redirect-safe fetch ──────────────────────────────────────────────────────

/**
 * Standard redirect status codes that carry a `Location` header to follow.
 * Anything else in the 3xx range (e.g. 304 Not Modified) is treated as a
 * terminal response, not a hop — this project never sends conditional
 * request headers, so a 304 would only occur ahead of an intermediary that
 * behaves unexpectedly, and it has no `Location` to follow anyway.
 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Hard cap on redirect hops for one `safeFetch` call — generous enough for a
 * normal CDN/tracking-link chain, small enough to bound the work a malicious
 * or misconfigured target can force.
 */
export const MAX_SAFE_FETCH_REDIRECTS = 5;

export interface SafeFetchOptions {
  /** Injectable DNS resolver — tests avoid real lookups. */
  resolve?: DnsResolver;
  /** Injectable fetch — tests avoid real network requests. */
  fetch?: typeof globalThis.fetch;
  /** Extra request headers, applied identically to every hop. */
  headers?: Record<string, string>;
  /** Total time budget across the WHOLE redirect chain, not per hop — a
   *  target cannot reset the clock by adding another redirect. Defaults to
   *  `FETCH_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Overridable for tests only; production callers use the default. */
  maxRedirects?: number;
  /** Forwarded verbatim to every hop's fetch call — e.g. Next.js's
   *  `"no-store"` to bypass its Data Cache for a source that must always be
   *  read fresh. Omitted entirely (not even as `undefined`) when unset, since
   *  some fetch implementations reject an explicit `cache: undefined`. */
  cache?: RequestCache;
}

export type SafeFetchResult =
  { ok: true; response: Response; finalUrl: string } | { ok: false; reason: string };

/**
 * Fetches `rawUrl` with EVERY hop — the initial URL and every redirect target
 * it issues — independently validated by `checkSsrf` before it is requested.
 *
 * This exists because `fetch(url, { redirect: "follow" })` (what this module
 * used exclusively before this function) only lets the CALLER see and
 * validate the URL it originally asked for. The actual TCP connections made
 * while following redirects happen entirely inside the fetch implementation,
 * unvalidated — so a target could pass `checkSsrf` on its own public URL and
 * then 302 the real request to `http://169.254.169.254/...` or
 * `http://localhost:6379/`, and Node would follow it transparently. Fetching
 * with `redirect: "manual"` and walking the chain here closes that gap: no
 * hop is ever requested before its own URL clears the same SSRF policy the
 * first one did.
 *
 * Never throws — every failure (SSRF block on any hop, a missing/malformed
 * `Location`, too many redirects, a redirect loop, a transport error, a
 * timeout) comes back as `{ ok: false, reason }`. `reason` is a short
 * machine-readable tag, occasionally suffixed with `: <message>` for
 * transport failures — the same convention `ExtractedArticle.error` already
 * uses, so callers can pass it straight through.
 *
 * Known limitation, not solved by this function or by `checkSsrf`: DNS
 * rebinding. `checkSsrf` resolves and validates each hop's hostname once,
 * before the request; the underlying fetch implementation then resolves it
 * again (independently) to actually connect. A hostname whose DNS answer
 * changes between those two resolutions — pointing at a public address for
 * the check and a private one for the connection — is not caught. This is a
 * pre-existing limitation of `checkSsrf`'s check-then-connect shape, not
 * something the manual redirect loop introduces or could fix without
 * controlling the socket connection itself.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {}
): Promise<SafeFetchResult> {
  const fetchFn = options.fetch ?? fetch;
  const maxRedirects = options.maxRedirects ?? MAX_SAFE_FETCH_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;

  let currentUrl: URL;
  try {
    currentUrl = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Every URL visited this call, initial included — catches a redirect loop
  // (A → B → A) without waiting for it to exhaust the hop budget.
  const visited = new Set<string>();

  try {
    for (let hop = 0; ; hop++) {
      if (!(await checkSsrf(currentUrl, options.resolve))) {
        return { ok: false, reason: "ssrf_blocked" };
      }

      const normalized = currentUrl.toString();
      if (visited.has(normalized)) return { ok: false, reason: "redirect_loop" };
      visited.add(normalized);

      let res: Response;
      try {
        res = await fetchFn(normalized, {
          signal: controller.signal,
          headers: options.headers,
          redirect: "manual",
          ...(options.cache ? { cache: options.cache } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const reason = controller.signal.aborted ? `timeout_${timeoutMs}ms` : "fetch_failed";
        return { ok: false, reason: `${reason}: ${message}` };
      }

      if (!REDIRECT_STATUSES.has(res.status)) {
        return { ok: true, response: res, finalUrl: normalized };
      }

      // A redirect response's body is never used — release it before looping,
      // rather than leaving it open for every hop of a long chain.
      if (res.body) {
        try {
          await res.body.cancel();
        } catch {
          /* best-effort */
        }
      }

      if (hop >= maxRedirects) return { ok: false, reason: "too_many_redirects" };

      const location = res.headers.get("location");
      if (!location) return { ok: false, reason: "invalid_redirect" };

      try {
        // Resolved against the CURRENT hop, not the original URL — a redirect
        // chain routinely changes host, and a relative Location is relative
        // to where it was issued from.
        currentUrl = new URL(location, currentUrl);
      } catch {
        return { ok: false, reason: "invalid_redirect" };
      }
    }
  } finally {
    clearTimeout(timer);
  }
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

  const result = await safeFetch(rawUrl, {
    resolve: options?.resolve,
    fetch: options?.fetch,
    timeoutMs: FETCH_TIMEOUT_MS,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; RSS content reader)",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!result.ok) {
    // ssrf_blocked/invalid_url are expected, routine outcomes (a bad or
    // policy-refused link) — everything else (a redirect gone wrong, a
    // transport failure, a timeout) is worth a log line, same as before.
    if (result.reason !== "ssrf_blocked" && result.reason !== "invalid_url") {
      console.error("[article-extraction] fetch failed", { url: rawUrl, reason: result.reason });
    }
    return emptyArticle(result.reason);
  }

  const res = result.response;
  if (!res.ok) {
    console.warn("[article-extraction] fetch rejected", { url: rawUrl, status: res.status });
    return emptyArticle(`http_${res.status}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) return emptyArticle(`non_html: ${contentType}`);
  const html = await res.text();

  // Resolved against the FINAL fetched url (after any redirects), not the
  // requested one, so a feed link that redirects to the publisher's domain
  // still yields absolute image addresses.
  return extractArticleParts(html, result.finalUrl);
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
 * Below this length, a fallback string (an RSS summary, or even
 * `<content:encoded>` on a feed that ships a one-liner there too) is stored
 * for display purposes but is not treated as analyzable — see
 * `resolveArticleContent`'s doc comment and, downstream, the
 * Competitive-Intelligence extraction gate that reads this same constant.
 * Deliberately much lower than `MIN_ARTICLE_LENGTH` (300, in
 * `article-strategies.ts`): that constant decides whether a PAGE READ counts
 * as a genuine article; this one only filters out a blank/placeholder blurb
 * ("Read more...", a bare title repeated) before it is worth an AI call, not
 * "is this as good as a real article" — it deliberately is not.
 */
export const MIN_ANALYZABLE_CONTENT_LENGTH = 40;

/**
 * Ranks how good a stored `FeedItem.content` is, from a re-ingest's point of
 * view: a genuine article page read outranks the feed's own full body, which
 * outranks its short summary, which outranks nothing at all. Used so a later
 * ingest — the site started blocking reads, or a feed briefly stopped
 * shipping `<content:encoded>` — can never silently REPLACE a better answer
 * already on file with a worse one; see the "do not overwrite a better full
 * article with a weaker summary" rule this exists to serve. Exported so
 * callers can compare an existing row's provenance against a freshly resolved
 * one without duplicating the ranking.
 */
export function contentQualityRank(method: ExtractionMethod | null, complete: boolean): number {
  if (complete) return 3;
  if (method === "rss_full_content") return 2;
  if (method === "rss_summary") return 1;
  return 0;
}

/**
 * Combines a fetch attempt with what the feed itself shipped into what gets
 * stored — preferring, in order: (1) a genuine article-page read, (2) the
 * feed's own full body (`<content:encoded>`, when the feed carries one), (3)
 * the feed's short summary/description. Never fabricates content: a tier is
 * used only when it actually has text, and the tier below is tried when the
 * one above is absent OR too thin to be worth analyzing
 * (`MIN_ANALYZABLE_CONTENT_LENGTH`) — though even a too-thin fallback is still
 * STORED (a titled row beats an empty one for a human browsing the feed
 * list), just correctly labelled `complete: false` with its real (weak)
 * method, so a downstream analysis gate can refuse to spend a model call on
 * it while the UI can still show something.
 *
 * `fullContent` (2026-09 fix — see `parser.ts`'s `extractContentEncoded` doc
 * comment) is what closes the gap a real production incident exposed: a feed
 * that ships the complete article ONLY inside `<content:encoded>`, with no
 * `<description>`/`<summary>` at all, used to resolve to "no content
 * anywhere" the instant the page itself couldn't be read — even though the
 * article text was sitting in the feed payload the whole time.
 */
export function resolveArticleContent(
  extracted: ExtractedArticle,
  summary: string | null,
  fullContent: string | null = null
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

  const candidates: Array<{ text: string; method: "rss_full_content" | "rss_summary" }> = [];
  const full = fullContent?.trim();
  if (full) candidates.push({ text: full, method: "rss_full_content" });
  const brief = summary?.trim();
  if (brief) candidates.push({ text: brief, method: "rss_summary" });

  // Prefer the first candidate that clears the analyzable threshold; if none
  // does, fall back to the best (first, i.e. highest-tier) candidate anyway —
  // still stored, still honestly labelled, just left for the analysis gate to
  // refuse.
  const chosen =
    candidates.find((c) => c.text.length >= MIN_ANALYZABLE_CONTENT_LENGTH) ?? candidates[0] ?? null;

  return {
    content: chosen?.text ?? null,
    method: chosen?.method ?? null,
    chars: chosen?.text.length ?? 0,
    complete: false,
    error: extracted.error ?? "no_article_text",
  };
}
