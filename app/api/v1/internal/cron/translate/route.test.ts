import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GET, POST } from "./route";

// These exercise ONLY the auth gate, which returns before enqueueJob (and thus
// before any DB access). The enqueue + dedupe behaviour is covered by the
// enqueue-job service unit tests.

const ORIGINAL = process.env.CRON_SECRET;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL;
});

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://app.test/api/v1/internal/cron/translate", { headers });
}

describe("cron/translate route — authentication", () => {
  it("returns 500 CONFIGURATION_ERROR when CRON_SECRET is not set", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(req());
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error.code, "CONFIGURATION_ERROR");
  });

  it("returns 401 UNAUTHORIZED when the bearer token is missing", async () => {
    process.env.CRON_SECRET = "s3cret";
    const res = await GET(req());
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, "UNAUTHORIZED");
  });

  it("returns 401 UNAUTHORIZED when the bearer token is wrong", async () => {
    process.env.CRON_SECRET = "s3cret";
    const res = await POST(req({ authorization: "Bearer nope" }));
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, "UNAUTHORIZED");
  });

  it("rejects a wrong x-api-key too", async () => {
    process.env.CRON_SECRET = "s3cret";
    const res = await GET(req({ "x-api-key": "nope" }));
    assert.equal(res.status, 401);
  });
});
