export interface ParsedFeedItem {
  title: string | null;
  url: string | null;
  summary: string | null;
  publishedAt: Date | null;
}

function extractText(xml: string, tag: string): string | null {
  const cdata = xml.match(
    new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, "i")
  );
  if (cdata) return cdata[1].trim() || null;

  const plain = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  if (plain) {
    const text = plain[1].replace(/<[^>]+>/g, "").trim();
    return text || null;
  }
  return null;
}

function extractLink(xml: string): string | null {
  // Atom: <link href="..." /> or <link href="...">
  const attr = xml.match(/<link\s[^>]*href=["']([^"']+)["'][^>]*/i);
  if (attr) return attr[1].trim();
  // RSS 2.0: <link>http://...</link>
  const text = xml.match(/<link>([^<]+)<\/link>/i);
  if (text) return text[1].trim();
  return null;
}

function parseDate(raw: string | null): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

function splitItems(xml: string): string[] {
  const rssItems = [...xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)].map((m) => m[0]);
  if (rssItems.length > 0) return rssItems;
  return [...xml.matchAll(/<entry[\s>]([\s\S]*?)<\/entry>/gi)].map((m) => m[0]);
}

export async function parseFeed(url: string): Promise<ParsedFeedItem[]> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Feed fetch failed: ${res.status} ${res.statusText}`);
  const xml = await res.text();

  return splitItems(xml).map((item) => {
    const pubRaw =
      extractText(item, "pubDate") ??
      extractText(item, "published") ??
      extractText(item, "updated") ??
      extractText(item, "dc:date");

    return {
      title: extractText(item, "title"),
      url: extractLink(item),
      summary:
        extractText(item, "description") ??
        extractText(item, "summary") ??
        extractText(item, "content"),
      publishedAt: parseDate(pubRaw),
    };
  });
}
