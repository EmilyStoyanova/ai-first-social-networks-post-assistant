import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { deleteImageFromCloudinary } from "./delete-image";

const realFetch = globalThis.fetch;
const realEnv = { ...process.env };

function configure() {
  process.env.CLOUDINARY_CLOUD_NAME = "demo";
  process.env.CLOUDINARY_API_KEY = "key";
  process.env.CLOUDINARY_API_SECRET = "secret";
}

function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
  globalThis.fetch = ((url: string, init: RequestInit) =>
    Promise.resolve(handler(url, init))) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => configure());

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...realEnv };
});

describe("deleteImageFromCloudinary", () => {
  it("destroys the resource and reports success", async () => {
    let calledUrl = "";
    let body: FormData | null = null;
    stubFetch((url, init) => {
      calledUrl = url;
      body = init.body as FormData;
      return jsonResponse({ result: "ok" });
    });

    const result = await deleteImageFromCloudinary("folder/asset-1");

    assert.equal(result.success, true);
    assert.equal(calledUrl, "https://api.cloudinary.com/v1_1/demo/image/destroy");
    assert.equal((body as unknown as FormData).get("public_id"), "folder/asset-1");
    // Every signed request carries a signature over the params actually sent.
    assert.ok((body as unknown as FormData).get("signature"));
  });

  it("treats an already-missing resource as success, so cleanup is idempotent", async () => {
    stubFetch(() => jsonResponse({ result: "not found" }));
    assert.equal((await deleteImageFromCloudinary("gone")).success, true);
  });

  it("reports a Cloudinary error instead of throwing", async () => {
    stubFetch(() => jsonResponse({ error: { message: "Invalid Signature" } }, 401));
    const result = await deleteImageFromCloudinary("folder/asset-1");
    assert.equal(result.success, false);
    assert.equal(result.success === false && result.message, "Invalid Signature");
  });

  it("reports a network failure instead of throwing", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("ECONNRESET"))) as unknown as typeof fetch;
    const result = await deleteImageFromCloudinary("folder/asset-1");
    assert.equal(result.success, false);
  });

  it("is a no-op success when Cloudinary is not configured", async () => {
    delete process.env.CLOUDINARY_API_SECRET;
    let called = false;
    stubFetch(() => {
      called = true;
      return jsonResponse({ result: "ok" });
    });

    assert.equal((await deleteImageFromCloudinary("folder/asset-1")).success, true);
    assert.equal(called, false);
  });

  it("refuses an empty public id rather than posting a blank destroy", async () => {
    let called = false;
    stubFetch(() => {
      called = true;
      return jsonResponse({ result: "ok" });
    });

    assert.equal((await deleteImageFromCloudinary("")).success, false);
    assert.equal(called, false);
  });
});
