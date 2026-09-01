import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hasExactlyOneOrigin } from "./competitor-intelligence-origin";

describe("hasExactlyOneOrigin", () => {
  it("accepts feedItemId alone", () => {
    assert.equal(
      hasExactlyOneOrigin({ feedItemId: "fi-1", manualEntryId: null, socialItemId: null }),
      true
    );
  });

  it("accepts manualEntryId alone", () => {
    assert.equal(
      hasExactlyOneOrigin({ feedItemId: null, manualEntryId: "me-1", socialItemId: null }),
      true
    );
  });

  it("accepts socialItemId alone", () => {
    assert.equal(
      hasExactlyOneOrigin({ feedItemId: null, manualEntryId: null, socialItemId: "si-1" }),
      true
    );
  });

  it("rejects all three null", () => {
    assert.equal(
      hasExactlyOneOrigin({ feedItemId: null, manualEntryId: null, socialItemId: null }),
      false
    );
  });

  it("rejects any two set at once", () => {
    assert.equal(
      hasExactlyOneOrigin({ feedItemId: "fi-1", manualEntryId: "me-1", socialItemId: null }),
      false
    );
    assert.equal(
      hasExactlyOneOrigin({ feedItemId: "fi-1", manualEntryId: null, socialItemId: "si-1" }),
      false
    );
    assert.equal(
      hasExactlyOneOrigin({ feedItemId: null, manualEntryId: "me-1", socialItemId: "si-1" }),
      false
    );
  });

  it("rejects all three set at once", () => {
    assert.equal(
      hasExactlyOneOrigin({ feedItemId: "fi-1", manualEntryId: "me-1", socialItemId: "si-1" }),
      false
    );
  });
});
