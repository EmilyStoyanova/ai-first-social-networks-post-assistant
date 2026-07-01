export interface ProductPageMeta {
  title: string | null;
  description: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
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

export async function scrapeProductPage(url: string): Promise<ProductPageMeta> {
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
  };
}
