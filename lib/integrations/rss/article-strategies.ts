/**
 * The three ways an article body is read out of a fetched page, and the rule
 * that picks between them.
 *
 * Readability alone was the whole extractor, and its failure mode is silent: it
 * returns thin text (or nothing) and the caller falls back to the feed's own
 * `<description>` — a single sentence stored as if it were the article. A post
 * then gets written from that sentence, about a subject the rest of the piece
 * contradicts. Two independent readers of the same DOM are what make that
 * recoverable, because they fail for unrelated reasons:
 *
 *   • Readability scores the DOM heuristically. It is the best general reader
 *     there is, and it stays primary — but a consent shell, an unusual wrapper,
 *     or an article whose body is split across sibling sections can starve it.
 *   • JSON-LD `articleBody` is emitted server-side for Google by most large
 *     publishers. It is prose the publisher itself declared to be the article,
 *     so it survives exactly the layout weirdness that defeats scoring.
 *   • DOM traversal of the body container is the last resort and the only one
 *     that works on a page with neither: find the container, walk ALL of it,
 *     keep the real blocks in document order.
 *
 * ORDER OF EXECUTION IS NOT ORDER OF PREFERENCE. `Readability.parse()` rewrites
 * the document it is handed, so the other two must read the DOM first (the same
 * constraint `selectMetaImage` already documents). Preference is applied
 * afterwards, over results already in hand.
 */

/**
 * How the stored `content` of a feed item was obtained.
 *
 * `"readability" | "json_ld" | "dom"` are all a genuine article PAGE read —
 * `resolveArticleContent` marks these `complete: true`. `"rss_full_content"`
 * and `"rss_summary"` are both feed-payload fallbacks used when the page
 * itself could not be read (blocked, paywalled, non-HTML, ...) — see
 * `resolveArticleContent`'s doc comment for the full fallback hierarchy and
 * why the two are kept distinct rather than folded into one "fallback" tag.
 */
export type ExtractionMethod =
  "readability" | "json_ld" | "dom" | "rss_full_content" | "rss_summary";

/**
 * Text shorter than this is not an article — it is a paywall stub, a consent
 * interstitial, or a nav rail that happened to score. Applies to every strategy,
 * so a fallback cannot win by returning junk the primary correctly refused.
 */
export const MIN_ARTICLE_LENGTH = 300;

/**
 * How much longer a lower-preference result must be to overrule a higher one.
 *
 * The cascade is a preference order, not a length contest — Readability wins
 * whenever it produced a real article, even by a few characters. But "real" and
 * "complete" are different claims: a page that yields 400 readable characters
 * while its own JSON-LD carries 9,000 has not been read, it has been sampled,
 * and preferring the sample loses precisely the later sections this module
 * exists to keep. A 2× margin is far outside the range normal formatting
 * differences produce between two readers of the same body.
 */
const OVERRULE_RATIO = 2;

// ─── Text shaping ─────────────────────────────────────────────────────────────

/**
 * Collapses runs of whitespace without collapsing paragraphs.
 *
 * Blank lines are the only structure the downstream prompt has for telling one
 * section from the next, so they survive; every other whitespace run becomes a
 * single space.
 */
function normalizeText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n[ \n]*\n[ \n]*/g, "\n\n")
    .replace(/ *\n */g, "\n")
    .trim();
}

/** A strategy's result, or null when it found nothing substantial. */
function accept(text: string | null | undefined): string | null {
  if (!text) return null;
  const normalized = normalizeText(text);
  return normalized.length >= MIN_ARTICLE_LENGTH ? normalized : null;
}

// ─── Strategy 2: JSON-LD articleBody ─────────────────────────────────────────

/**
 * Every `articleBody` string reachable from the page's JSON-LD blocks.
 *
 * Walks arrays and the `@graph` wrapper Yoast and friends emit, the same shape
 * `jsonLdImage` already handles. A malformed block is skipped rather than
 * thrown on: one bad `<script>` must never cost the whole strategy.
 *
 * The LONGEST match wins rather than the first. A page can legitimately carry
 * several Article nodes — a live-blog entry, a "related" stub, the piece itself
 * — and only one of them is the body.
 */
export function extractJsonLdArticleBody(doc: Document): string | null {
  let best: string | null = null;

  const consider = (value: unknown) => {
    if (typeof value !== "string") return;
    if (best === null || value.length > best.length) best = value;
  };

  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as { articleBody?: unknown; "@graph"?: unknown };
    consider(record.articleBody);
    if (record["@graph"]) walk(record["@graph"]);
  };

  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      walk(JSON.parse(script.textContent ?? ""));
    } catch {
      continue;
    }
  }

  return accept(best);
}

// ─── Strategy 3: DOM traversal of the body container ─────────────────────────

/**
 * Where an article body lives, most specific first.
 *
 * `itemprop="articleBody"` is the publisher saying it outright; the class names
 * below are the handful of conventions that cover most CMS themes; `<article>`
 * and `<main>` are the structural last resorts. Every match is tried and the
 * one yielding the most text wins, so an unfamiliar theme degrades to "the
 * biggest plausible container" rather than to nothing.
 */
const CONTAINER_SELECTORS = [
  "[itemprop='articleBody']",
  "article [class*='article-body']",
  "article [class*='article__body']",
  "[class*='article-body']",
  "[class*='article__body']",
  "[class*='post-content']",
  "[class*='entry-content']",
  "[class*='story-body']",
  "[class*='post-body']",
  "article",
  "main",
  "body",
] as const;

/** Elements whose contents are never article prose, whatever they contain. */
const NON_ARTICLE_TAGS = [
  "script",
  "style",
  "noscript",
  "nav",
  "aside",
  "footer",
  "header",
  "form",
  "iframe",
  "button",
  "svg",
  "template",
] as const;

/**
 * Class/id fragments that mark a block as furniture rather than the story:
 * ad slots, "related stories" rails, newsletter forms, share bars, comments.
 *
 * Matched on the element's own class/id at a word boundary, so `ad-slot` and
 * `slot--ad` are junk while `download` and `read-more-body` are not.
 */
const JUNK_ATTR_WORDS = [
  "ad",
  "ads",
  "advert",
  "advertisement",
  "author-bio",
  "breadcrumb",
  "comment",
  "comments",
  "consent",
  "cookie",
  "disqus",
  "footer",
  "masthead",
  "menu",
  "modal",
  "more-from",
  "most-popular",
  "nav",
  "navigation",
  "newsletter",
  "paywall",
  "popular",
  "popup",
  "promo",
  "promoted",
  "recirc",
  "recommend",
  "recommended",
  "related",
  "share",
  "sidebar",
  "signup",
  "sign-up",
  "social",
  "sponsor",
  "sponsored",
  "subscribe",
  "tags",
  "teaser",
  "toolbar",
  "trending",
  "widget",
] as const;

/**
 * Word-boundary containment, so a fragment matches a whole token of a class
 * list and not an incidental substring of a longer word.
 */
function hasWord(value: string, words: readonly string[]): boolean {
  const lower = value.toLowerCase();
  return words.some((word) => {
    let at = lower.indexOf(word);
    while (at !== -1) {
      const before = at === 0 ? "" : lower[at - 1];
      const after = lower[at + word.length] ?? "";
      if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
      at = lower.indexOf(word, at + 1);
    }
    return false;
  });
}

function isJunkElement(el: Element): boolean {
  return (
    hasWord(el.getAttribute("class") ?? "", JUNK_ATTR_WORDS) ||
    hasWord(el.getAttribute("id") ?? "", JUNK_ATTR_WORDS)
  );
}

/** The blocks that carry prose, in document order. */
const BLOCK_SELECTOR = "p, h2, h3, h4, li, blockquote, pre";

/** A heading may be short; a paragraph that short is a byline or a button. */
const MIN_BLOCK_CHARS = 20;

function isHeading(el: Element): boolean {
  return /^h[1-6]$/i.test(el.tagName);
}

/**
 * Collects one container's prose.
 *
 * The container is CLONED before anything is removed: these strategies run
 * before Readability, and mutating the live document would corrupt the input of
 * the reader that is still supposed to be primary.
 *
 * Traversal is over the whole subtree — `querySelectorAll` returns every
 * descendant in document order regardless of nesting depth — so the number of
 * sections, divs or paragraphs never has to be known in advance. Blocks nested
 * inside an already-accepted block are skipped, which is what keeps a `<li>`
 * wrapping a `<p>` from contributing its text twice.
 */
function collectContainerText(container: Element): string | null {
  const clone = container.cloneNode(true) as Element;

  for (const tag of NON_ARTICLE_TAGS) {
    for (const el of Array.from(clone.querySelectorAll(tag))) el.remove();
  }
  for (const el of Array.from(clone.querySelectorAll("*"))) {
    // `clone.contains(el)` and NOT `el.isConnected`: the clone is a DETACHED
    // tree, so isConnected is false for every node in it and the whole junk
    // sweep silently did nothing. This skips nodes an earlier removal already
    // took out with their parent.
    if (clone.contains(el) && isJunkElement(el)) el.remove();
  }

  const accepted: Element[] = [];
  const parts: string[] = [];

  for (const el of Array.from(clone.querySelectorAll(BLOCK_SELECTOR))) {
    if (accepted.some((a) => a.contains(el))) continue;
    const text = normalizeText(el.textContent ?? "");
    if (!text) continue;
    if (!isHeading(el) && text.length < MIN_BLOCK_CHARS) continue;
    accepted.push(el);
    parts.push(text);
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * The article body read straight from the DOM, for pages Readability and
 * JSON-LD both miss.
 *
 * Every candidate container is collected and the LONGEST result wins. Taking
 * the first selector that matches would stop at whichever wrapper happens to
 * exist, and on a page whose body is split across two of them that is how the
 * first block becomes "the article".
 */
export function extractDomArticleBody(doc: Document): string | null {
  let best: string | null = null;

  for (const selector of CONTAINER_SELECTORS) {
    let containers: Element[];
    try {
      containers = Array.from(doc.querySelectorAll(selector));
    } catch {
      continue; // A selector an older DOM implementation cannot parse.
    }
    for (const container of containers) {
      const text = collectContainerText(container);
      if (text && (best === null || text.length > best.length)) best = text;
    }
  }

  return accept(best);
}

// ─── The cascade ──────────────────────────────────────────────────────────────

export interface StrategyResult {
  method: Exclude<ExtractionMethod, "rss_summary">;
  text: string;
}

/**
 * Picks the winner from the results already gathered.
 *
 * Preference order is Readability → JSON-LD → DOM, and the first strategy that
 * produced a real article takes it. The one exception is the length overrule
 * documented on OVERRULE_RATIO: a result more than twice as long as the
 * preferred one is not a formatting difference, it is more of the article.
 *
 * Pure and separately exported so the rule can be tested without a DOM.
 */
export function chooseArticleText(
  candidates: ReadonlyArray<StrategyResult | null>
): StrategyResult | null {
  const found = candidates.filter((c): c is StrategyResult => c !== null);
  if (found.length === 0) return null;

  const preferred = found[0];
  const longest = found.reduce((a, b) => (b.text.length > a.text.length ? b : a));

  return longest.text.length >= preferred.text.length * OVERRULE_RATIO ? longest : preferred;
}

/**
 * Runs all three readers over one parsed document and returns the winner.
 *
 * The DOM-reading strategies go first on purpose — see the module header: the
 * Readability call mutates `doc`, so anything that needs the original markup
 * has to have taken it already.
 */
export function extractArticleBody(
  doc: Document,
  readability: () => string | null
): StrategyResult | null {
  const jsonLd = extractJsonLdArticleBody(doc);
  const dom = extractDomArticleBody(doc);
  const readable = accept(readability());

  return chooseArticleText([
    readable ? { method: "readability", text: readable } : null,
    jsonLd ? { method: "json_ld", text: jsonLd } : null,
    dom ? { method: "dom", text: dom } : null,
  ]);
}
