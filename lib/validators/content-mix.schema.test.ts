import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contentMixSchema } from "./content-mix.schema";

function body(source: Record<string, unknown>) {
  return {
    sources: [{ sourceId: "rss-a", postsPerWeek: 3, ...source }],
    companyContentPostsPerWeek: 2,
  };
}

describe("contentMixSchema — fallbackPolicy", () => {
  it("accepts skip", () => {
    const parsed = contentMixSchema.safeParse(body({ fallbackPolicy: "skip" }));
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.sources[0].fallbackPolicy, "skip");
  });

  it("accepts use_another_source", () => {
    const parsed = contentMixSchema.safeParse(body({ fallbackPolicy: "use_another_source" }));
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.sources[0].fallbackPolicy, "use_another_source");
  });

  it("rejects a policy the scheduler cannot honour yet", () => {
    // The column carries the wider v2-8 vocabulary for phases that are not
    // built. Until they are, the API must not let one through — the scheduler
    // would reject the saved mix and the company would stop generating.
    for (const policy of ["use_company_profile", "allow_reuse"]) {
      assert.equal(
        contentMixSchema.safeParse(body({ fallbackPolicy: policy })).success,
        false,
        `${policy} must be rejected`
      );
    }
  });

  it("rejects an unknown policy", () => {
    assert.equal(contentMixSchema.safeParse(body({ fallbackPolicy: "nonsense" })).success, false);
    assert.equal(contentMixSchema.safeParse(body({ fallbackPolicy: "SKIP" })).success, false);
    assert.equal(contentMixSchema.safeParse(body({ fallbackPolicy: 1 })).success, false);
    assert.equal(contentMixSchema.safeParse(body({ fallbackPolicy: null })).success, false);
  });

  it("accepts a source with no policy at all", () => {
    // Optional on purpose: a client may submit quotas alone, and an absent
    // policy means "keep the stored one" rather than "reset to default".
    const parsed = contentMixSchema.safeParse(body({}));
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.sources[0].fallbackPolicy, undefined);
  });

  it("still rejects an invalid quota alongside a valid policy", () => {
    assert.equal(
      contentMixSchema.safeParse(body({ postsPerWeek: 2.5, fallbackPolicy: "skip" })).success,
      false
    );
    assert.equal(
      contentMixSchema.safeParse(body({ postsPerWeek: -1, fallbackPolicy: "skip" })).success,
      false
    );
  });
});
