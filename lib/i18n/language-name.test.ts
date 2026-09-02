import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { languageDisplayName } from "./language-name";

describe("languageDisplayName", () => {
  it("renders the code in the VIEWER's locale, not the code's own", () => {
    // The exact leak this closes: a Bulgarian UI printing a bare "en" for
    // `CompetitorIntelligence.originalLanguage`.
    assert.equal(languageDisplayName("en", "bg"), "английски");
    assert.equal(languageDisplayName("bg", "bg"), "български");
    assert.equal(languageDisplayName("bg", "en"), "Bulgarian");
    assert.equal(languageDisplayName("en", "en"), "English");
  });

  it("handles codes outside the app's own two locales", () => {
    // The extractor may report ANY ISO 639-1 code — a competitor's feed is not
    // limited to the languages this app's UI is translated into.
    assert.equal(languageDisplayName("de", "en"), "German");
    assert.equal(languageDisplayName("fr", "bg"), "френски");
  });

  it("returns null for an absent code so the field can be omitted entirely", () => {
    assert.equal(languageDisplayName(null, "bg"), null);
    assert.equal(languageDisplayName(undefined, "bg"), null);
    assert.equal(languageDisplayName("", "bg"), null);
    assert.equal(languageDisplayName("   ", "bg"), null);
  });

  it("falls back to the upper-cased code for a value it cannot resolve", () => {
    // Model output is not guaranteed well-formed. Upper-casing signals "this
    // is a code" rather than rendering a broken half-word as if it were a name.
    assert.equal(languageDisplayName("english", "bg"), "ENGLISH");
    assert.equal(languageDisplayName("zz", "en"), "ZZ");
  });

  it("never throws, whatever the stored value looks like", () => {
    for (const code of ["!!", "e", "en_US_x_very_long", "12", "-"]) {
      assert.doesNotThrow(() => languageDisplayName(code, "bg"));
    }
  });
});
