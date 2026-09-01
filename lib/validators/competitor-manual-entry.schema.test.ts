import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { competitorManualEntrySchema } from "./competitor-manual-entry.schema";

const VALID = {
  sourceType: "facebook",
  postType: "organic",
  content: "Check out our new winter collection!",
};

describe("competitorManualEntrySchema", () => {
  it("accepts a minimal valid entry with no url or capturedAt", () => {
    const result = competitorManualEntrySchema.safeParse(VALID);
    assert.ok(result.success);
    assert.equal(result.data.url, undefined);
    assert.equal(result.data.capturedAt, undefined);
  });

  it("accepts every documented sourceType/postType combination", () => {
    for (const sourceType of [
      "facebook",
      "instagram",
      "linkedin",
      "tiktok",
      "youtube",
      "x",
      "website",
      "other",
    ]) {
      for (const postType of ["organic", "ad"]) {
        assert.ok(
          competitorManualEntrySchema.safeParse({ ...VALID, sourceType, postType }).success,
          `${sourceType}/${postType} should be accepted`
        );
      }
    }
  });

  it("rejects an unknown sourceType or postType", () => {
    assert.equal(
      competitorManualEntrySchema.safeParse({ ...VALID, sourceType: "snapchat" }).success,
      false
    );
    assert.equal(
      competitorManualEntrySchema.safeParse({ ...VALID, postType: "sponsored" }).success,
      false
    );
  });

  it("requires non-empty content", () => {
    assert.equal(competitorManualEntrySchema.safeParse({ ...VALID, content: "" }).success, false);
  });

  it("rejects a URL that is not http(s) — reference metadata, not an escape hatch", () => {
    assert.equal(
      competitorManualEntrySchema.safeParse({ ...VALID, url: "javascript:alert(1)" }).success,
      false
    );
  });

  it("accepts a valid http(s) URL", () => {
    assert.ok(
      competitorManualEntrySchema.safeParse({ ...VALID, url: "https://facebook.com/post/1" })
        .success
    );
  });

  it("never accepts companyId — it is always server-derived, never client input (§5/§25.10)", () => {
    const result = competitorManualEntrySchema.safeParse({ ...VALID, companyId: "co-other" });
    assert.ok(result.success);
    assert.ok(!("companyId" in result.data));
  });

  it("accepts an ISO date string for capturedAt and leaves it a plain string (no implicit 'now' default)", () => {
    const result = competitorManualEntrySchema.safeParse({ ...VALID, capturedAt: "2026-01-15" });
    assert.ok(result.success);
    assert.equal(result.data.capturedAt, "2026-01-15");
  });
});
