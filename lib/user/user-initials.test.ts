import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { userInitials } from "./user-initials";

describe("userInitials — from a display name", () => {
  it("takes the first letter of the first two words", () => {
    assert.equal(userInitials("Ada Lovelace", "ada@example.com"), "AL");
  });

  it("ignores words beyond the second", () => {
    assert.equal(userInitials("Ada Byron King Lovelace", null), "AB");
  });

  it("handles a single-word name", () => {
    assert.equal(userInitials("Ada", null), "A");
  });

  it("uppercases a lowercase name", () => {
    assert.equal(userInitials("ada lovelace", null), "AL");
  });

  it("collapses extra whitespace rather than producing empty initials", () => {
    assert.equal(userInitials("  Ada   Lovelace  ", null), "AL");
  });

  it("works in Cyrillic", () => {
    assert.equal(userInitials("Емили Стоянова", null), "ЕС");
  });
});

describe("userInitials — falling back to the email", () => {
  it("uses the first letter of the local part when the name is missing", () => {
    assert.equal(userInitials(null, "ada@example.com"), "A");
  });

  it("uses the email when the name is blank rather than returning nothing", () => {
    assert.equal(userInitials("   ", "ada@example.com"), "A");
  });

  it("does not fall through to the domain for an email with no local part", () => {
    assert.equal(userInitials(null, "@example.com"), null);
  });
});

describe("userInitials — no identity at all", () => {
  it("returns null so the caller can render a generic icon", () => {
    assert.equal(userInitials(null, null), null);
    assert.equal(userInitials(undefined, undefined), null);
    assert.equal(userInitials("", ""), null);
    assert.equal(userInitials("   ", "   "), null);
  });
});
