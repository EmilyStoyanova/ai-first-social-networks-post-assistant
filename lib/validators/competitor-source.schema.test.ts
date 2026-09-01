import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { competitorSourceSchema } from "./competitor-source.schema";

describe("competitorSourceSchema", () => {
  it("accepts a valid labeled RSS feed", () => {
    const result = competitorSourceSchema.safeParse({
      label: "Blog",
      url: "https://competitor.example.com/feed.xml",
    });
    assert.ok(result.success);
  });

  it("requires a non-empty label", () => {
    assert.equal(
      competitorSourceSchema.safeParse({ label: "", url: "https://x.example.com/feed.xml" })
        .success,
      false
    );
  });

  it("requires a valid URL", () => {
    assert.equal(
      competitorSourceSchema.safeParse({ label: "Blog", url: "not a url" }).success,
      false
    );
  });

  it("carries no companyId or competitorId field — always server-derived, never client input", () => {
    const result = competitorSourceSchema.safeParse({
      label: "Blog",
      url: "https://x.example.com/feed.xml",
      companyId: "co-other",
      competitorId: "c-other",
    });
    assert.ok(result.success);
    assert.ok(!("companyId" in result.data));
    assert.ok(!("competitorId" in result.data));
  });

  it("defaults enabled to undefined (the service applies the true default)", () => {
    const result = competitorSourceSchema.safeParse({
      label: "Blog",
      url: "https://x.example.com/feed.xml",
    });
    assert.ok(result.success);
    assert.equal(result.data.enabled, undefined);
  });
});
