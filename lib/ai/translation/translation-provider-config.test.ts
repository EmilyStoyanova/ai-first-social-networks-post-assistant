import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MADLAD_MODEL,
  isTranslationProviderKind,
  resolveTranslationProviderConfig,
} from "./translation-provider-config";

/**
 * The load-bearing property of this file is the DEFAULT: an empty environment must
 * describe exactly the pipeline that ran before MADLAD existed. Everything else here
 * is a variation on "and it still does".
 */

describe("resolveTranslationProviderConfig — the default is the old behaviour", () => {
  it("selects ollama when nothing is configured", () => {
    const config = resolveTranslationProviderConfig({});
    assert.equal(config.kind, "ollama");
  });

  it("leaves the Ollama model to the admin default when no override is set", () => {
    assert.equal(resolveTranslationProviderConfig({}).ollamaModel, null);
  });

  it("never falls back between engines unless asked to", () => {
    assert.equal(resolveTranslationProviderConfig({}).fallbackToOllamaOnTransportError, false);
    assert.equal(
      resolveTranslationProviderConfig({ TRANSLATION_PROVIDER: "madlad" })
        .fallbackToOllamaOnTransportError,
      false
    );
  });

  it("treats an empty string as unset", () => {
    const config = resolveTranslationProviderConfig({
      TRANSLATION_PROVIDER: "",
      TRANSLATION_OLLAMA_MODEL: "  ",
      TRANSLATION_MADLAD_MODEL: "",
    });
    assert.equal(config.kind, "ollama");
    assert.equal(config.ollamaModel, null);
    assert.equal(config.madladModel, DEFAULT_MADLAD_MODEL);
  });
});

describe("resolveTranslationProviderConfig — explicit selection", () => {
  it("selects madlad when asked", () => {
    assert.equal(
      resolveTranslationProviderConfig({ TRANSLATION_PROVIDER: "madlad" }).kind,
      "madlad"
    );
  });

  it("is case- and whitespace-insensitive", () => {
    assert.equal(
      resolveTranslationProviderConfig({ TRANSLATION_PROVIDER: "  MADLAD " }).kind,
      "madlad"
    );
  });

  it("defaults the MADLAD model to the official checkpoint", () => {
    assert.equal(
      resolveTranslationProviderConfig({ TRANSLATION_PROVIDER: "madlad" }).madladModel,
      "google/madlad400-3b-mt"
    );
  });

  it("honours an explicit model for each engine", () => {
    const config = resolveTranslationProviderConfig({
      TRANSLATION_OLLAMA_MODEL: "qwen3:8b",
      TRANSLATION_MADLAD_MODEL: "google/madlad400-10b-mt",
    });
    assert.equal(config.ollamaModel, "qwen3:8b");
    assert.equal(config.madladModel, "google/madlad400-10b-mt");
  });

  it("enables the fallback only for the exact opt-in value", () => {
    assert.equal(
      resolveTranslationProviderConfig({ TRANSLATION_MADLAD_FALLBACK: "ollama" })
        .fallbackToOllamaOnTransportError,
      true
    );
    assert.equal(
      resolveTranslationProviderConfig({ TRANSLATION_MADLAD_FALLBACK: "true" })
        .fallbackToOllamaOnTransportError,
      false
    );
  });
});

describe("resolveTranslationProviderConfig — a bad value degrades, never breaks", () => {
  it("falls back to ollama on an unrecognised provider rather than translating nothing", () => {
    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
      const config = resolveTranslationProviderConfig({ TRANSLATION_PROVIDER: "madlad400" });
      assert.equal(config.kind, "ollama");
    } finally {
      console.warn = original;
    }
    assert.equal(warnings.length, 1, "a typo must be loud, not silent");
    assert.match(String(warnings[0][0]), /madlad400/);
  });
});

describe("isTranslationProviderKind", () => {
  it("accepts exactly the two supported engines", () => {
    assert.equal(isTranslationProviderKind("ollama"), true);
    assert.equal(isTranslationProviderKind("madlad"), true);
    assert.equal(isTranslationProviderKind("qwen"), false);
    assert.equal(isTranslationProviderKind(""), false);
  });
});
