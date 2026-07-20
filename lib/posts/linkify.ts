/**
 * Splits post text into plain runs and the URLs inside it, so a card can render
 * links without touching the text itself.
 *
 * Two rules shape what counts as a URL here:
 *
 *   • Only `http://`, `https://` and `www.` starts are matched. Bare domains are
 *     deliberately excluded — post copy is full of "Node.js", "e.g." and
 *     sentence-ending abbreviations that a domain-shaped pattern would turn into
 *     broken links.
 *
 *   • Trailing punctuation is pushed back into the surrounding text. "Read
 *     https://example.com." ends a sentence; the period is not part of the link.
 *     Closing brackets are only trimmed when they are unbalanced, which keeps
 *     URLs like https://en.wikipedia.org/wiki/Foo_(bar) intact.
 *
 * Concatenating every segment's `value` reproduces the input exactly — the text
 * is never rewritten, only marked up.
 */

export type TextSegment =
  | { type: "text"; value: string }
  /** `value` is shown verbatim; `href` is where it points. */
  | { type: "url"; value: string; href: string };

/**
 * Stops at whitespace and at the angle brackets and quotes that would mean the
 * URL was already wrapped in markup or quoted.
 */
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;

/** Punctuation that ends a sentence rather than a URL. */
const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", "'", '"', "…"]);

const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/**
 * Walks back off the end of a match until what remains plausibly ends a URL.
 * Returns the number of characters that belong to the following text instead.
 */
function overshoot(match: string): number {
  let end = match.length;

  while (end > 0) {
    const char = match[end - 1];

    if (TRAILING_PUNCTUATION.has(char)) {
      end--;
      continue;
    }

    const opener = CLOSERS[char];
    if (opener) {
      const url = match.slice(0, end);
      const opened = url.split(opener).length - 1;
      const closed = url.split(char).length - 1;
      // Balanced brackets are part of the URL; a lone closer is not.
      if (closed > opened) {
        end--;
        continue;
      }
    }

    break;
  }

  return match.length - end;
}

export function splitLinks(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;

  // A fresh regex per call — the global flag makes lastIndex stateful, and this
  // function must be safe to call on every render.
  const pattern = new RegExp(URL_PATTERN.source, URL_PATTERN.flags);

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const trailing = overshoot(match[0]);
    const url = match[0].slice(0, match[0].length - trailing);

    // A match that was punctuation all the way down is not a link.
    if (url === "" || url === "www.") continue;

    if (match.index > cursor) {
      segments.push({ type: "text", value: text.slice(cursor, match.index) });
    }

    segments.push({
      type: "url",
      value: url,
      // A `www.` link has no scheme, and a schemeless href would resolve
      // relative to the app's own origin.
      href: url.toLowerCase().startsWith("www.") ? `https://${url}` : url,
    });

    cursor = match.index + url.length;
    pattern.lastIndex = cursor;
  }

  if (cursor < text.length) {
    segments.push({ type: "text", value: text.slice(cursor) });
  }

  return segments;
}
