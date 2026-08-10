import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchRemoteImage } from "./fetch-remote-image";
import type { DnsResolver } from "@/lib/integrations/rss/article-extractor";

const IMAGE_URL = "https://example.com/img/lead.jpg";

function resolver(address: string, family: 4 | 6 = 4): DnsResolver {
  return async () => [{ address, family }];
}

/** Public IP resolver — passes the SSRF gate without real DNS. */
const publicResolver = resolver("93.184.216.34", 4);

/** An image-sized body. Contents are irrelevant — only the length is under test. */
function bytes(size: number): ArrayBuffer {
  return new ArrayBuffer(size);
}

function mockFetch(
  body: BodyInit | null,
  {
    status = 200,
    contentType = "image/jpeg",
    contentLength,
  }: {
    status?: number;
    contentType?: string;
    contentLength?: string;
  } = {}
) {
  return async () => {
    const headers = new Headers({ "content-type": contentType });
    if (contentLength) headers.set("content-length", contentLength);
    return new Response(body, { status, headers }) as Response;
  };
}

// ─── SSRF — the whole reason this helper exists ───────────────────────────────

describe("fetchRemoteImage — SSRF protection", () => {
  it("refuses a URL that resolves to a private address", async () => {
    const result = await fetchRemoteImage(IMAGE_URL, {
      resolve: resolver("10.0.0.1", 4),
      fetch: mockFetch(bytes(100)),
    });
    assert.equal(result.success, false);
    assert.equal(result.success === false && result.code, "UNSAFE_URL");
  });

  it("refuses a URL that resolves to loopback", async () => {
    const result = await fetchRemoteImage(IMAGE_URL, {
      resolve: resolver("127.0.0.1", 4),
      fetch: mockFetch(bytes(100)),
    });
    assert.equal(result.success === false && result.code, "UNSAFE_URL");
  });

  it("refuses an IPv6 unique-local address", async () => {
    const result = await fetchRemoteImage(IMAGE_URL, {
      resolve: resolver("fd12:3456::1", 6),
      fetch: mockFetch(bytes(100)),
    });
    assert.equal(result.success === false && result.code, "UNSAFE_URL");
  });

  it("refuses localhost by hostname, before DNS", async () => {
    const result = await fetchRemoteImage("http://localhost/img.png", {
      resolve: publicResolver,
      fetch: mockFetch(bytes(100)),
    });
    assert.equal(result.success === false && result.code, "UNSAFE_URL");
  });

  it("refuses a non-http(s) scheme", async () => {
    const result = await fetchRemoteImage("file:///etc/passwd", {
      resolve: publicResolver,
      fetch: mockFetch(bytes(100)),
    });
    assert.equal(result.success === false && result.code, "UNSAFE_URL");
  });

  it("refuses a malformed URL", async () => {
    const result = await fetchRemoteImage("not-a-url", { resolve: publicResolver });
    assert.equal(result.success === false && result.code, "UNSAFE_URL");
  });

  it("never calls fetch for a blocked address", async () => {
    let called = false;
    await fetchRemoteImage(IMAGE_URL, {
      resolve: resolver("192.168.1.1", 4),
      fetch: async () => {
        called = true;
        return new Response(null);
      },
    });
    assert.equal(called, false, "the request must not be issued at all");
  });
});

// ─── Response validation ──────────────────────────────────────────────────────

describe("fetchRemoteImage — response validation", () => {
  it("accepts a JPEG and returns its bytes", async () => {
    const result = await fetchRemoteImage(IMAGE_URL, {
      resolve: publicResolver,
      fetch: mockFetch(bytes(2048)),
    });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.contentType, "image/jpeg");
      assert.equal(result.blob.size, 2048);
    }
  });

  it("tolerates a charset parameter on the content type", async () => {
    const result = await fetchRemoteImage(IMAGE_URL, {
      resolve: publicResolver,
      fetch: mockFetch(bytes(64), { contentType: "image/png; charset=binary" }),
    });
    assert.equal(result.success, true);
    assert.equal(result.success && result.contentType, "image/png");
  });

  it("rejects an HTML response — a redirect to an error page, not an image", async () => {
    const result = await fetchRemoteImage(IMAGE_URL, {
      resolve: publicResolver,
      fetch: mockFetch("<html>Gone</html>", { contentType: "text/html" }),
    });
    assert.equal(result.success === false && result.code, "UNSUPPORTED_TYPE");
  });

  it("rejects SVG — scriptable markup, and in practice always a logo", async () => {
    const result = await fetchRemoteImage(IMAGE_URL, {
      resolve: publicResolver,
      fetch: mockFetch("<svg/>", { contentType: "image/svg+xml" }),
    });
    assert.equal(result.success === false && result.code, "UNSUPPORTED_TYPE");
  });

  it("rejects a response with no content type at all", async () => {
    const result = await fetchRemoteImage(IMAGE_URL, {
      resolve: publicResolver,
      fetch: mockFetch(bytes(64), { contentType: "" }),
    });
    assert.equal(result.success === false && result.code, "UNSUPPORTED_TYPE");
  });

  it("reports a 404 as a download failure, with the status in the message", async () => {
    const result = await fetchRemoteImage(IMAGE_URL, {
      resolve: publicResolver,
      fetch: mockFetch("Not Found", { status: 404, contentType: "text/html" }),
    });
    assert.equal(result.success === false && result.code, "FETCH_FAILED");
    assert.match(result.success === false ? result.message : "", /404/);
  });

  it("reports a network error as a download failure rather than throwing", async () => {
    const result = await fetchRemoteImage(IMAGE_URL, {
      resolve: publicResolver,
      fetch: async () => {
        throw new Error("socket hang up");
      },
    });
    assert.equal(result.success === false && result.code, "FETCH_FAILED");
  });

  it("rejects an empty body", async () => {
    const result = await fetchRemoteImage(IMAGE_URL, {
      resolve: publicResolver,
      fetch: mockFetch(bytes(0)),
    });
    assert.equal(result.success === false && result.code, "EMPTY_IMAGE");
  });
});

// ─── Size cap ─────────────────────────────────────────────────────────────────

describe("fetchRemoteImage — size cap", () => {
  it("refuses a body that declares itself over 10 MB, without reading it", async () => {
    let read = false;
    const result = await fetchRemoteImage(IMAGE_URL, {
      resolve: publicResolver,
      fetch: async () => {
        read = true;
        return new Response(bytes(16), {
          headers: {
            "content-type": "image/jpeg",
            "content-length": String(11 * 1024 * 1024),
          },
        }) as Response;
      },
    });
    assert.equal(result.success === false && result.code, "IMAGE_TOO_LARGE");
    assert.equal(read, true, "the request is made; only the body is skipped");
  });

  it("refuses a body that exceeds the cap while streaming, despite a small declared length", async () => {
    // A lying (or absent) content-length must not be the only defence.
    const oversized = bytes(11 * 1024 * 1024);
    const result = await fetchRemoteImage(IMAGE_URL, {
      resolve: publicResolver,
      fetch: mockFetch(oversized, { contentLength: "1024" }),
    });
    assert.equal(result.success === false && result.code, "IMAGE_TOO_LARGE");
  });

  it("accepts a body just under the cap", async () => {
    const result = await fetchRemoteImage(IMAGE_URL, {
      resolve: publicResolver,
      fetch: mockFetch(bytes(10 * 1024 * 1024 - 1)),
    });
    assert.equal(result.success, true);
  });
});
