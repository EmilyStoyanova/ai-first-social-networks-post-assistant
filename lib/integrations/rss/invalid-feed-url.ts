/**
 * A genuine RSS article link is always an absolute http(s) URL. The old RSS
 * link-extraction bug (fixed in parser.ts) instead stored embedded stylesheet
 * `<link href="..."/>` values found inside `<content:encoded>` — most notably
 * "//cdn-images.mailchimp.com/embedcode/classic-061523.css" from a Mailchimp
 * signup form. Those protocol-relative asset URLs never point at an article.
 *
 * This predicate distinguishes a real article URL from a bug-created one, so a
 * one-off cleanup can delete only the malformed rows.
 *
 * It is only meaningful for RSS feed items: prompt / product_page /
 * calendar_event sources legitimately use non-http synthetic URLs ("prompt:<id>",
 * "event:<id>"), so any caller must scope to RSS sources before applying it.
 */
export function isValidArticleUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Protocol-relative ("//host/x.css") or otherwise unparseable → not an article.
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}
