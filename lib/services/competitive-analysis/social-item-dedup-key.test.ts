import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSameSocialItem, socialItemDedupKey } from "./social-item-dedup-key";

describe("socialItemDedupKey", () => {
  it("is deterministic for the same (profile, externalItemId) pair", () => {
    assert.equal(
      socialItemDedupKey("profile-1", "fb-post-123"),
      socialItemDedupKey("profile-1", "fb-post-123")
    );
  });

  it("differs across profiles even with the same externalItemId", () => {
    assert.notEqual(
      socialItemDedupKey("profile-1", "fb-post-123"),
      socialItemDedupKey("profile-2", "fb-post-123")
    );
  });

  it("differs across externalItemId within the same profile", () => {
    assert.notEqual(
      socialItemDedupKey("profile-1", "fb-post-123"),
      socialItemDedupKey("profile-1", "fb-post-456")
    );
  });

  it("returns null when externalItemId is unknown — no dedup guarantee", () => {
    assert.equal(socialItemDedupKey("profile-1", null), null);
  });
});

describe("isSameSocialItem", () => {
  it("a repeated sync of the SAME external item is recognized as a duplicate", () => {
    const first = { socialProfileId: "profile-1", externalItemId: "fb-post-123" };
    const second = { socialProfileId: "profile-1", externalItemId: "fb-post-123" };
    assert.equal(isSameSocialItem(first, second), true);
  });

  it("a different external item on the same profile is NOT a duplicate", () => {
    const first = { socialProfileId: "profile-1", externalItemId: "fb-post-123" };
    const second = { socialProfileId: "profile-1", externalItemId: "fb-post-456" };
    assert.equal(isSameSocialItem(first, second), false);
  });

  it("the same external item id on a DIFFERENT profile is NOT a duplicate", () => {
    const first = { socialProfileId: "profile-1", externalItemId: "fb-post-123" };
    const second = { socialProfileId: "profile-2", externalItemId: "fb-post-123" };
    assert.equal(isSameSocialItem(first, second), false);
  });

  it("two unknown-external-id items are never treated as duplicates of each other", () => {
    const first = { socialProfileId: "profile-1", externalItemId: null };
    const second = { socialProfileId: "profile-1", externalItemId: null };
    assert.equal(isSameSocialItem(first, second), false);
  });
});
