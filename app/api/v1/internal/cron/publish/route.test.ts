import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GET, POST } from "./route";

// These exercise ONLY the auth gate, which returns before enqueueJob (and thus
// before any DB access). The enqueue + dedupe behaviour is covered by the
// enqueue-job service unit tests, and the sweep itself by run-publish-cron.
//
// The gate matters more on this route than on its siblings: it is the endpoint a
// third party on the public internet will be calling every 30 minutes, so an
// unauthenticated caller must never be able to make the app talk to Buffer.

const ORIGINAL = process.env.CRON_SECRET;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL;
});

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://app.test/api/v1/internal/cron/publish", { headers });
}

describe("cron/publish route — authentication", () => {
  it("returns 500 CONFIGURATION_ERROR when CRON_SECRET is not set", async () => {
    // Not 401: an unset secret is an operator mistake, and answering "unauthorized"
    // would send whoever set up the scheduler hunting for a wrong token.
    delete process.env.CRON_SECRET;
    const res = await GET(req());
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error.code, "CONFIGURATION_ERROR");
  });

  it("returns 401 UNAUTHORIZED when no credentials are sent", async () => {
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
    // Both accepted header forms must be gated; schedulers that cannot send
    // "Bearer" use this one, and it is easy for a second path to go unchecked.
    process.env.CRON_SECRET = "s3cret";
    const res = await GET(req({ "x-api-key": "nope" }));
    assert.equal(res.status, 401);
  });

  it("rejects a bearer token that merely starts with the secret", async () => {
    // Guards the comparison itself: a prefix match would let a truncated or
    // padded token through.
    process.env.CRON_SECRET = "s3cret";
    const res = await GET(req({ authorization: "Bearer s3cret-extra" }));
    assert.equal(res.status, 401);
  });

  it("gates POST exactly as it gates GET", async () => {
    // Both methods enqueue the same job, so both must be behind the same gate —
    // an external scheduler may use either.
    process.env.CRON_SECRET = "s3cret";
    const [get, post] = await Promise.all([GET(req()), POST(req())]);
    assert.equal(get.status, 401);
    assert.equal(post.status, 401);
  });
});
