import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contentMixSchema } from "./content-mix.schema";

function body(source: Record<string, unknown>) {
  return {
    sources: [{ sourceId: "rss-a", postsPerWeek: 3, ...source }],
    companyContentPostsPerWeek: 2,
  };
}

describe("contentMixSchema", () => {
  it("accepts a distribution of quotas", () => {
    const parsed = contentMixSchema.safeParse(body({}));
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.sources[0].postsPerWeek, 3);
    assert.equal(parsed.data?.companyContentPostsPerWeek, 2);
  });

  it("accepts null to clear a quota", () => {
    // null ("takes no part in the mix") is meaningfully different from 0
    // ("contribute nothing"), so both must survive parsing.
    const parsed = contentMixSchema.safeParse(body({ postsPerWeek: null }));
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.sources[0].postsPerWeek, null);
  });

  it("accepts a quota of zero", () => {
    assert.equal(contentMixSchema.safeParse(body({ postsPerWeek: 0 })).success, true);
  });

  it("rejects a fractional or negative quota", () => {
    assert.equal(contentMixSchema.safeParse(body({ postsPerWeek: 2.5 })).success, false);
    assert.equal(contentMixSchema.safeParse(body({ postsPerWeek: -1 })).success, false);
  });

  it("rejects a quota above the per-channel weekly ceiling", () => {
    assert.equal(contentMixSchema.safeParse(body({ postsPerWeek: 8 })).success, false);
  });

  it("ignores a fallbackPolicy a stale client still sends", () => {
    // The selector is gone and transfer is unconditional. An old tab must not be
    // rejected for it — the value is simply stripped and never reaches the DB.
    const parsed = contentMixSchema.safeParse(body({ fallbackPolicy: "use_another_source" }));
    assert.equal(parsed.success, true);
    assert.equal(
      "fallbackPolicy" in (parsed.data?.sources[0] ?? {}),
      false,
      "the field must not survive parsing"
    );
  });
});
