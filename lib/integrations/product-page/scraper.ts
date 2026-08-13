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
 * Storage cap for extracted page text. Generously above what a prompt will ever
 * quote (see INSTRUCTED_PAGE_TEXT_LIMIT in lib/ai/source-content.ts) so the
 * stored item survives a later change to how much of it is rendered, but bounded
 * so one enormous page cannot inflate a FeedItem row without limit.
 */
export const PAGE_TEXT_LIMIT = 8_000;

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

/** Whole elements whose text is chrome, code, or markup — never page content. */
const CHROME_BLOCKS =
  /<(script|style|noscript|template|svg|head|nav|header|footer|form|aside|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** Elements that end a line of reading — a list of events must not run together. */
const LINE_BREAKING_TAGS = /<\/?(p|div|li|ul|ol|tr|td|th|h[1-6]|section|article|br|hr)\b[^>]*>/gi;

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
      .replace(/ /g, " ")
  );
}

/**
 * The page's visible text, as a model would read it.
 *
 * Deliberately NOT Readability (which the RSS path uses): Readability is built
 * for articles and prunes exactly the lists, tables and cards that a catalogue
 * or listing page consists of — the pages an extraction instruction is most
 * often pointed at. This keeps the body and only removes chrome.
 *
 * Exported so tests can run it without network I/O.
 */
export function extractPageText(html: string, limit: number = PAGE_TEXT_LIMIT): string | null {
  const text = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(CHROME_BLOCKS, " ")
      .replace(LINE_BREAKING_TAGS, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");

  if (!text) return null;
  return text.length > limit ? text.slice(0, limit) + "…" : text;
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
