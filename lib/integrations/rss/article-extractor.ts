import { lookup } from "node:dns/promises";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

// ─── Constants ────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 8_000;
/** Extracted text shorter than this is treated as a paywall stub and discarded. */
const MIN_ARTICLE_LENGTH = 300;

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

// ─── HTML → text ─────────────────────────────────────────────────────────────

/**
 * Parses raw HTML with jsdom + Readability and returns clean article text,
 * or null if no substantial content can be extracted.
 * Exported so tests can call it directly without network I/O.
 */
export function extractReadableText(html: string, baseUrl: string): string | null {
  try {
    const dom = new JSDOM(html, { url: baseUrl });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    const text = article?.textContent?.trim() ?? null;
    if (!text || text.length < MIN_ARTICLE_LENGTH) return null;
    return text;
  } catch {
    return null;
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export interface ExtractOptions {
  /** Injectable DNS resolver — used in tests to avoid real network lookups. */
  resolve?: DnsResolver;
  /** Injectable fetch — used in tests to avoid real network requests. */
  fetch?: typeof globalThis.fetch;
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
  if (!rawUrl) return null;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const fetchFn = options?.fetch ?? fetch;

  if (!(await checkSsrf(url, options?.resolve))) return null;

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
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) return null;
    html = await res.text();
  } catch {
    clearTimeout(timer);
    return null;
  }

  return extractReadableText(html, rawUrl);
}
