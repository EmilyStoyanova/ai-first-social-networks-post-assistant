import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MADLAD_CONCURRENCY,
  DEFAULT_MADLAD_HTTP_BATCH_SIZE,
  DEFAULT_MADLAD_MODEL,
  isTranslationProviderKind,
  MADLAD_MAX_HTTP_BATCH_SIZE,
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

  it("defaults concurrency to 1 and the HTTP batch size to 30", () => {
    const config = resolveTranslationProviderConfig({});
    assert.equal(config.madladConcurrency, DEFAULT_MADLAD_CONCURRENCY);
    assert.equal(config.madladConcurrency, 1);
    assert.equal(config.madladHttpBatchSize, DEFAULT_MADLAD_HTTP_BATCH_SIZE);
    assert.equal(config.madladHttpBatchSize, 30);
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

  it("honours an explicit HTTP batch size within [1, 32]", () => {
    assert.equal(
      resolveTranslationProviderConfig({ TRANSLATION_MADLAD_HTTP_BATCH_SIZE: "1" })
        .madladHttpBatchSize,
      1
    );
    assert.equal(
      resolveTranslationProviderConfig({ TRANSLATION_MADLAD_HTTP_BATCH_SIZE: "15" })
        .madladHttpBatchSize,
      15
    );
    assert.equal(
      resolveTranslationProviderConfig({
        TRANSLATION_MADLAD_HTTP_BATCH_SIZE: String(MADLAD_MAX_HTTP_BATCH_SIZE),
      }).madladHttpBatchSize,
      MADLAD_MAX_HTTP_BATCH_SIZE
    );
  });

  it("honours an explicit concurrency", () => {
    assert.equal(
      resolveTranslationProviderConfig({ TRANSLATION_MADLAD_CONCURRENCY: "3" }).madladConcurrency,
      3
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

  it("falls back to the default HTTP batch size when the value exceeds the worker's ceiling", () => {
    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
      const config = resolveTranslationProviderConfig({
        TRANSLATION_MADLAD_HTTP_BATCH_SIZE: String(MADLAD_MAX_HTTP_BATCH_SIZE + 1),
      });
      assert.equal(config.madladHttpBatchSize, DEFAULT_MADLAD_HTTP_BATCH_SIZE);
    } finally {
      console.warn = original;
    }
    assert.equal(warnings.length, 1, "an out-of-range batch size must be loud, not silent");
  });

  it("falls back to the default HTTP batch size on zero, negative, or non-numeric values", () => {
    for (const bad of ["0", "-5", "thirty"]) {
      const original = console.warn;
      console.warn = () => {};
      let config;
      try {
        config = resolveTranslationProviderConfig({ TRANSLATION_MADLAD_HTTP_BATCH_SIZE: bad });
      } finally {
        console.warn = original;
      }
      assert.equal(
        config.madladHttpBatchSize,
        DEFAULT_MADLAD_HTTP_BATCH_SIZE,
        `expected "${bad}" to degrade to the default`
      );
    }
  });

  it("falls back to the default concurrency on zero, negative, or non-numeric values", () => {
    for (const bad of ["0", "-1", "many"]) {
      const original = console.warn;
      console.warn = () => {};
      let config;
      try {
        config = resolveTranslationProviderConfig({ TRANSLATION_MADLAD_CONCURRENCY: bad });
      } finally {
        console.warn = original;
      }
      assert.equal(
        config.madladConcurrency,
        DEFAULT_MADLAD_CONCURRENCY,
        `expected "${bad}" to degrade to the default`
      );
    }
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
