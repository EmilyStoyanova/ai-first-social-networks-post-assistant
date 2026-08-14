export interface ProductPageMeta {
  title: string | null;
  description: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  /**
   * The page's visible text, extracted only when the caller asks for it
   * (`includeText`). Null when it was not requested, or when the page yielded
   * nothing readable.
   */
  pageText: string | null;
}

export interface ScrapeProductPageOptions {
  /**
   * Also extract the page body as plain text. Off by default: a product page
   * with no extraction instruction is represented by its title and meta
   * description exactly as it always has been, and the body text would only
   * compete for the prompt's per-item budget.
   */
  includeText?: boolean;
}

/**
 * Storage cap for extracted page text.
 *
 * Sized for the page this feature exists to read: a catalogue listing every item
 * of something, each with a name, a date, a place, a category and a price. At the
 * old 8 000 it took roughly forty such cards to reach the cap — and a listing page
 * carrying more than that is precisely the page whose tail an owner would never
 * notice was missing, because the extraction that ran on the truncated text was
 * itself complete and self-consistent. The cost of the higher cap is a larger
 * FeedItem row for instructed pages only; the cost of the lower one was a silently
 * short list presented as the whole page.
 */
export const PAGE_TEXT_LIMIT = 40_000;

/**
 * What a truncated page text ends with.
 *
 * Said out loud, in the text itself, rather than the bare "…" this used to append.
 * Truncation is invisible to everything downstream unless the text says so: the
 * extraction cannot know its source was cut, so it reports a complete list of what
 * it was given, and the completeness check would then chase a shortfall that no
 * retry can close. Both read this marker.
 */
export const PAGE_TEXT_TRUNCATION_MARKER =
  "[PAGE TEXT TRUNCATED — the page continues past this point and the rest was not captured.]";

/** Whether `extractPageText` had to cut this text short. */
export function pageTextWasTruncated(pageText: string | null | undefined): boolean {
  return typeof pageText === "string" && pageText.includes(PAGE_TEXT_TRUNCATION_MARKER);
}

function extractMeta(html: string, name: string): string | null {
  const pA = new RegExp(
    `<meta\\s[^>]*name=["']${name}["'][^>]*content=["']([^"']+)["'][^>]*>`,
    "i"
  );
  const pB = new RegExp(
    `<meta\\s[^>]*content=["']([^"']+)["'][^>]*name=["']${name}["'][^>]*>`,
    "i"
  );
  return (html.match(pA) ?? html.match(pB))?.[1]?.trim() ?? null;
}

function extractOg(html: string, property: string): string | null {
  const pA = new RegExp(
    `<meta\\s[^>]*property=["']og:${property}["'][^>]*content=["']([^"']+)["'][^>]*>`,
    "i"
  );
  const pB = new RegExp(
    `<meta\\s[^>]*content=["']([^"']+)["'][^>]*property=["']og:${property}["'][^>]*>`,
    "i"
  );
  return (html.match(pA) ?? html.match(pB))?.[1]?.trim() ?? null;
}

/**
 * Elements whose text is never page content, wherever they appear.
 *
 * `nav` is here rather than below because a navigation region is navigation at any
 * depth — a card carrying its own pagination is still not carrying facts.
 */
const ALWAYS_CHROME = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "head",
  "iframe",
  "nav",
  "object",
  "canvas",
  "select",
  "datalist",
]);

/**
 * Elements that are chrome ONLY at page level.
 *
 * The reason this distinction exists at all: HTML5 puts `<header>` and `<footer>`
 * INSIDE `<article>` and `<li>`, and that is where card-based listings keep the
 * two most load-bearing facts on the card — the item's name in its header, its
 * price and status in its footer. Stripping the tag name wherever it appeared
 * deleted them, and the extraction then faithfully reported the items it could
 * still see, with the fields it could still see. No prompt can recover a fact the
 * scraper threw away, which is why this is the first thing fixed.
 */
const CHROME_AT_PAGE_LEVEL = new Set(["header", "footer", "aside", "form"]);

/** Inside one of these, a `header`/`footer`/`aside`/`form` belongs to an item. */
const CONTENT_CONTAINERS = new Set([
  "article",
  "section",
  "main",
  "li",
  "td",
  "th",
  "tr",
  "table",
  "dd",
  "figure",
  "blockquote",
]);

/** Raw-text elements: their contents are not markup and must not be tokenised. */
const RAW_TEXT = new Set(["script", "style", "noscript", "template", "svg", "textarea"]);

/** Elements that never close, so they must not be pushed onto the open stack. */
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Elements that end a line of reading — a list of events must not run together. */
const LINE_BREAKING = new Set([
  "p",
  "div",
  "li",
  "ul",
  "ol",
  "tr",
  "td",
  "th",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "section",
  "article",
  "br",
  "hr",
  "header",
  "footer",
  "aside",
  "main",
  "dl",
  "dt",
  "dd",
  "figure",
  "figcaption",
  "blockquote",
  "table",
  "tbody",
  "thead",
  "caption",
  "form",
  "button",
  "label",
  "option",
]);

const NAMED_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
};

function decodeEntities(text: string): string {
  return (
    text
      .replace(/&[a-z]+;|&#\d+;/gi, (entity) => {
        const named = NAMED_ENTITIES[entity.toLowerCase()];
        if (named !== undefined) return named;
        const numeric = /^&#(\d+);$/.exec(entity);
        if (numeric) {
          const code = Number(numeric[1]);
          // Control characters would only add noise to a prompt.
          return code >= 32 ? String.fromCodePoint(code) : " ";
        }
        return entity;
      })
      // A numeric &#160; decodes to U+00A0, which `\s` does not treat as
      // whitespace — flatten it so the line collapsing below actually collapses.
      .replace(/ /g, " ")
  );
}

/**
 * Matches one comment or one tag, honouring quoted attribute values so a `>`
 * inside `alt="a > b"` does not end the tag early.
 */
const TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[!?][^>]*>|<(\/?)([a-zA-Z][^\s/>]*)((?:'[^']*'|"[^"]*"|[^'">])*)\/?>/g;

interface OpenElement {
  name: string;
  /** True when opening this element started a dropped region. */
  drops: boolean;
}

/**
 * Skips to just past the matching close tag of a raw-text element.
 *
 * Necessary because script and style bodies are not markup: `if (a < b && c > d)`
 * tokenises as an element, and a page's inline JSON payload can open dozens of
 * phantom elements. Returns the index to continue from.
 */
function skipRawText(html: string, name: string, from: number): number {
  const close = new RegExp(`</${name}\\b[^>]*>`, "i");
  const rest = html.slice(from);
  const match = close.exec(rest);
  return match ? from + match.index + match[0].length : html.length;
}

/**
 * The page's visible text, as a model would read it.
 *
 * Deliberately NOT Readability (which the RSS path uses): Readability is built
 * for articles and prunes exactly the lists, tables and cards that a catalogue
 * or listing page consists of — the pages an extraction instruction is most
 * often pointed at. This keeps the body and only removes chrome.
 *
 * A tokeniser rather than a chain of replacements, because the one rule that
 * matters here — a `<footer>` is chrome on a page and content on a card — is a
 * question about an element's ANCESTORS, and a regex over the whole document
 * cannot ask it.
 *
 * Exported so tests can run it without network I/O.
 */
export function extractPageText(html: string, limit: number = PAGE_TEXT_LIMIT): string | null {
  const stack: OpenElement[] = [];
  const out: string[] = [];
  let dropDepth = 0;
  let cursor = 0;

  const emitText = (raw: string) => {
    if (dropDepth > 0) return;
    if (raw.trim() === "") return;
    out.push(raw);
  };

  TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN.exec(html)) !== null) {
    if (match.index >= cursor) emitText(html.slice(cursor, match.index));
    cursor = TOKEN.lastIndex;

    const name = match[2]?.toLowerCase();
    // A comment or CDATA block: consumed, contributes nothing.
    if (!name) continue;

    const isClosing = match[1] === "/";
    const selfClosing = match[0].endsWith("/>");

    if (LINE_BREAKING.has(name)) out.push("\n");

    if (isClosing) {
      // Pop to the matching open element. Popping THROUGH unclosed elements is
      // what keeps a malformed page from corrupting every ancestry test after it.
      const at = stack.map((e) => e.name).lastIndexOf(name);
      if (at === -1) continue;
      for (const popped of stack.splice(at)) {
        if (popped.drops) dropDepth -= 1;
      }
      continue;
    }

    if (RAW_TEXT.has(name) && !selfClosing) {
      cursor = skipRawText(html, name, cursor);
      TOKEN.lastIndex = cursor;
      continue;
    }

    if (VOID_ELEMENTS.has(name) || selfClosing) continue;

    const drops =
      ALWAYS_CHROME.has(name) ||
      (CHROME_AT_PAGE_LEVEL.has(name) && !stack.some((e) => CONTENT_CONTAINERS.has(e.name)));
    if (drops) dropDepth += 1;
    stack.push({ name, drops });
  }
  emitText(html.slice(cursor));

  const text = decodeEntities(out.join(""))
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");

  if (!text) return null;
  if (text.length <= limit) return text;

  // Cut on a line boundary where there is one. A page sliced mid-card leaves a
  // half-item that reads like a whole one, and the extraction would report it as
  // a complete entry with most of its fields "not stated".
  const head = text.slice(0, limit);
  const lastBreak = head.lastIndexOf("\n");
  const kept = lastBreak > limit / 2 ? head.slice(0, lastBreak) : head;
  return `${kept}\n${PAGE_TEXT_TRUNCATION_MARKER}`;
}

export async function scrapeProductPage(
  url: string,
  options?: ScrapeProductPageOptions
): Promise<ProductPageMeta> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Page fetch failed: ${res.status} ${res.statusText}`);
  const html = await res.text();

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch?.[1]?.trim() ?? null;

  return {
    title,
    description: extractMeta(html, "description"),
    ogTitle: extractOg(html, "title"),
    ogDescription: extractOg(html, "description"),
    ogImage: extractOg(html, "image"),
    pageText: options?.includeText ? extractPageText(html) : null,
  };
}
