import { checkSsrf, type DnsResolver } from "@/lib/integrations/rss/article-extractor";

/**
 * Downloading an image from an address that came off someone else's web page.
 *
 * The URL is attacker-influenced by definition — it is whatever a publisher put
 * in their og:image — so it goes through the SAME SSRF gate the article scraper
 * uses (`checkSsrf`: http/https only, no localhost or *.local/*.internal, and
 * every DNS-resolved address must be public). Nothing else in the app is
 * permitted to fetch one of these URLs.
 *
 * On top of that the response itself is checked before a single byte is passed
 * on: it must be an image content type we accept, and it must fit inside the
 * size cap, enforced while reading rather than afterwards so an unbounded body
 * cannot exhaust memory.
 */

/**
 * A superset of the user-upload allowlist. These are all formats Cloudinary
 * stores and every network renders; SVG is deliberately absent (it is scriptable
 * markup, and in practice always a logo).
 */
const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/pjpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

/** Matches the user-upload ceiling — the same Cloudinary account, same limits. */
const MAX_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

export type FetchRemoteImageCode =
  "UNSAFE_URL" | "FETCH_FAILED" | "UNSUPPORTED_TYPE" | "IMAGE_TOO_LARGE" | "EMPTY_IMAGE";

export type FetchRemoteImageResult =
  | { success: true; blob: Blob; contentType: string }
  | { success: false; code: FetchRemoteImageCode; message: string };

export interface FetchRemoteImageOptions {
  /** Injectable DNS resolver — tests avoid real lookups. */
  resolve?: DnsResolver;
  /** Injectable fetch — tests avoid real network requests. */
  fetch?: typeof globalThis.fetch;
}

/** Reads the body, aborting as soon as it exceeds the cap. */
async function readCapped(res: Response): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) return null;

  if (!res.body) {
    const buffer = new Uint8Array(await res.arrayBuffer());
    return buffer.byteLength > MAX_BYTES ? null : buffer;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Fetches `rawUrl` and returns its bytes, or a code explaining why not.
 * Never throws — a dead link, a redirect to an HTML error page, or a 50 MB
 * poster image all come back as ordinary failures.
 */
export async function fetchRemoteImage(
  rawUrl: string,
  options?: FetchRemoteImageOptions
): Promise<FetchRemoteImageResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { success: false, code: "UNSAFE_URL", message: "The image address is not a valid URL." };
  }

  if (!(await checkSsrf(url, options?.resolve))) {
    return {
      success: false,
      code: "UNSAFE_URL",
      message: "The image address is not a public http(s) URL.",
    };
  }

  const fetchFn = options?.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetchFn(url.toString(), {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; RSS content reader)",
        Accept: "image/*",
      },
      redirect: "follow",
    });
  } catch {
    return { success: false, code: "FETCH_FAILED", message: "The image could not be downloaded." };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    return {
      success: false,
      code: "FETCH_FAILED",
      message: `The image could not be downloaded (HTTP ${res.status}).`,
    };
  }

  // Split on ";" first: real servers send "image/jpeg; charset=binary".
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    return {
      success: false,
      code: "UNSUPPORTED_TYPE",
      message: contentType
        ? `The source image is not a supported image type (${contentType}).`
        : "The source image is not a supported image type.",
    };
  }

  let bytes: Uint8Array | null;
  try {
    bytes = await readCapped(res);
  } catch {
    return { success: false, code: "FETCH_FAILED", message: "The image could not be downloaded." };
  }

  if (bytes === null) {
    return { success: false, code: "IMAGE_TOO_LARGE", message: "The source image is over 10 MB." };
  }
  if (bytes.byteLength === 0) {
    return { success: false, code: "EMPTY_IMAGE", message: "The source image is empty." };
  }

  return {
    success: true,
    blob: new Blob([bytes as unknown as BlobPart], { type: contentType }),
    contentType,
  };
}
