import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ANALYSIS_LANGUAGES,
  analysisLanguageEnglishName,
  resolveAnalysisLanguage,
} from "./analysis-language";

describe("resolveAnalysisLanguage", () => {
  it("passes through the two supported languages", () => {
    assert.equal(resolveAnalysisLanguage("en"), "en");
    assert.equal(resolveAnalysisLanguage("bg"), "bg");
  });

  it("normalizes casing and surrounding whitespace", () => {
    // `Company.defaultLang` is a plain String column — nothing at the DB level
    // guarantees the shape the write validator produces.
    assert.equal(resolveAnalysisLanguage("BG"), "bg");
    assert.equal(resolveAnalysisLanguage("  bg  "), "bg");
  });

  it("falls back to English for anything unrecognized, rather than throwing", () => {
    // A mislabelled company must still get analyzed; refusing to analyze is a
    // worse outcome than analyzing in the column's own default language.
    for (const value of [null, undefined, "", "   ", "de", "en-GB", "bulgarian"]) {
      assert.equal(resolveAnalysisLanguage(value), "en", `for ${JSON.stringify(value)}`);
    }
  });

  it("only ever returns a member of the declared vocabulary", () => {
    for (const value of ["en", "bg", "de", "", null]) {
      assert.ok((ANALYSIS_LANGUAGES as readonly string[]).includes(resolveAnalysisLanguage(value)));
    }
  });
});

describe("analysisLanguageEnglishName", () => {
  it("names the language in English, for interpolation into an English prompt", () => {
    assert.equal(analysisLanguageEnglishName("en"), "English");
    assert.equal(analysisLanguageEnglishName("bg"), "Bulgarian");
  });
});
