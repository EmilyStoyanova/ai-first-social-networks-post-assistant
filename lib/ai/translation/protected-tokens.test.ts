import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractUrls, protectTokens, restoreTokens } from "./protected-tokens";
import { TranslationParseError } from "@/lib/ai/feed-item-translation";

/**
 * What must never reach the decoder, and what must never be repaired.
 *
 * The placeholder syntax itself was chosen by measurement against the running model
 * (see the header of protected-tokens.ts); these tests are about the two things that
 * measurement cannot cover: that the right values are captured, and that ANY defect in
 * what comes back is rejected instead of guessed at.
 */

const parseFailure = (reason: string) => (err: unknown) =>
  err instanceof TranslationParseError && err.reason === reason;

// ─── Capture ──────────────────────────────────────────────────────────────────

describe("protectTokens — URLs", () => {
  it("replaces a URL inside a sentence", () => {
    const { text, values } = protectTokens("Read https://example.com/test for more information.");
    assert.equal(text, "Read [[0]] for more information.");
    assert.deepEqual(values, [{ kind: "url", value: "https://example.com/test" }]);
  });

  it("numbers multiple URLs in order", () => {
    const { text, values } = protectTokens("See https://example.com/a and https://example.com/b.");
    assert.equal(text, "See [[0]] and [[1]].");
    assert.deepEqual(
      values.map((v) => v.value),
      ["https://example.com/a", "https://example.com/b"]
    );
  });

  it("gives a repeated URL its own placeholder each time, so multiplicity is structural", () => {
    const { text, values } = protectTokens("Both https://example.com/a and https://example.com/a.");
    assert.equal(text, "Both [[0]] and [[1]].");
    assert.equal(values[0].value, values[1].value);
  });

  it("leaves the sentence's own punctuation behind", () => {
    for (const [source, expected] of [
      ["Go to https://example.com/a.", "Go to [[0]]."],
      ["Go to https://example.com/a, then stop.", "Go to [[0]], then stop."],
      ["(see https://example.com/a)", "(see [[0]])"],
      ["Details at https://example.com/a: read them.", "Details at [[0]]: read them."],
      ["Ask why https://example.com/a?", "Ask why [[0]]?"],
    ]) {
      const { text, values } = protectTokens(source);
      assert.equal(text, expected);
      assert.equal(values[0].value, "https://example.com/a");
    }
  });

  it("keeps a query string and a fragment inside the protected value", () => {
    const { values } = protectTokens("Open https://example.com/a?id=42&ref=b.c#top now.");
    assert.equal(values[0].value, "https://example.com/a?id=42&ref=b.c#top");
  });

  it("protects a bare www host", () => {
    const { text, values } = protectTokens("Visit www.example.com today.");
    assert.equal(text, "Visit [[0]] today.");
    assert.equal(values[0].kind, "url");
  });
});

describe("protectTokens — the other justified classes", () => {
  it("protects an e-mail address, which the model deletes outright", () => {
    const { text, values } = protectTokens("Write to service@example.com before it expires.");
    assert.equal(text, "Write to [[0]] before it expires.");
    assert.deepEqual(values, [{ kind: "email", value: "service@example.com" }]);
  });

  it("protects a model code", () => {
    const { text, values } = protectTokens("The model is DCD-800 P2 and it weighs 1.6 kg.");
    assert.equal(text, "The model is [[0]] [[1]] and it weighs 1.6 kg.");
    assert.deepEqual(
      values.map((v) => v.value),
      ["DCD-800", "P2"]
    );
  });

  it("protects a version string", () => {
    const { text } = protectTokens("Firmware v2.14.3 fixes the charging fault.");
    assert.equal(text, "Firmware [[0]] fixes the charging fault.");
  });
});

// ─── Regression: real production failure (MADLAD, feed item 825c8475, 2026-08-20) ──
//
// "13th-century" matched the internal-punctuation identifier shape (a digit run and a
// letter run joined by a hyphen — the same shape as "DCD-800") and was protected as
// [[0]]. That placed the placeholder in an ATTRIBUTIVE-ADJECTIVE slot immediately before
// the noun it modifies ("a [[0]] church"); measured live against the real worker, MADLAD
// drops (or hallucinates a real adjective over) a placeholder in exactly that position,
// and restoreTokens correctly rejected the result rather than storing a corrupted
// translation:
//   "Translation dropped [[0]] in segment 9/17 — the protected value(s) 1 could not be
//    restored unambiguously (13th-century)."
// Left unprotected, the SAME live worker translates the phrase correctly and faithfully
// on its own ("13th-century church" → "църква от 13-ти век"), so the token never needed
// protection: this is prose, not a code, and the fix removes it from the identifier
// shape rather than changing the placeholder syntax.
describe("protectTokens — ordinal/decade compounds are prose, not identifiers", () => {
  it("does not protect the exact failing production sentence (segment 9/17)", () => {
    const source =
      "At the whole-village resort, which sprawls over 2,700 acres and has 146 rooms, " +
      "one main cobblestoned street leads down from the castle to a 13th-century church, " +
      "a row of boutiques, gelaterias, and pizzerias, and the two hotel buildings.";
    const { text, values } = protectTokens(source);
    assert.equal(text, source, "the sentence must reach MADLAD completely untouched");
    assert.deepEqual(values, []);
  });

  it("does not protect the other two ordinal/decade compounds from the same real article", () => {
    // Segment 10/17 of the same feed item — "19th-century" and "1980s-built" matched the
    // identical over-broad shape and would have failed the same way had this segment been
    // reached first.
    const source =
      "The older of the two—a repurposed 19th-century tobacco warehouse—sits opposite " +
      "the 1980s-built low-slung main building, which has sublime valley views.";
    assert.deepEqual(protectTokens(source).values, []);
  });

  it("does not protect other ordinal/decade-compound shapes", () => {
    for (const source of [
      "Built in the 21st-century style.",
      "A 1st-place finish for the team.",
      "The 90s-style decor was intentional.",
    ]) {
      assert.deepEqual(protectTokens(source).values, [], `expected "${source}" to stay untouched`);
    }
  });

  it("still protects a genuine model code of the identical digit-hyphen-letter shape", () => {
    // "DCD-800" and "13th-century" share the same raw shape (digits, a hyphen, letters):
    // the fix must tell them apart by CONTENT (an ordinal/decade suffix followed by a
    // plain lowercase word), not by narrowing the shape check itself, or a real identifier
    // would leak through untranslated-and-unprotected.
    const { text, values } = protectTokens("The model is DCD-800 and it weighs 1.6 kg.");
    assert.equal(text, "The model is [[0]] and it weighs 1.6 kg.");
    assert.deepEqual(values, [{ kind: "identifier", value: "DCD-800" }]);
  });
});

describe("protectTokens — what is deliberately left translatable", () => {
  /**
   * Measured against the real model: it renders these CORRECTLY and localises them
   * ("12.5 bar" → "12,5 бара", "90 Nm" → "90 Нм"). Freezing them behind a placeholder
   * would force English formatting into Bulgarian text — a regression, not a safeguard.
   */
  const UNTOUCHED = [
    "A fire extinguisher can last between 5 and 15 years.",
    "The needle should sit at approx. 12.5 bar for a powder unit.",
    "Maximum torque is 90 Nm and the chuck is 13 mm keyless.",
    "The same 5.0 Ah pack drives more screws per charge.",
    "A rating of 250 kg per horse is enough.",
    "It weighs 1.6 kg and costs 1,299.00 BGN.",
  ];

  for (const source of UNTOUCHED) {
    it(`leaves "${source.slice(0, 40)}…" alone`, () => {
      const { text, values } = protectTokens(source);
      assert.equal(text, source);
      assert.deepEqual(values, []);
    });
  }

  it("does not protect an ordinary word or an acronym without digits", () => {
    const source = "The USB port on the DRILL is covered.";
    assert.deepEqual(protectTokens(source).values, []);
  });
});

// ─── Restoration ──────────────────────────────────────────────────────────────

describe("restoreTokens — the happy path", () => {
  it("puts the values back exactly", () => {
    const { values } = protectTokens("Read https://example.com/test for more information.");
    const out = restoreTokens("Прочетете [[0]] за повече информация.", values, "segment 1/1");
    assert.equal(out, "Прочетете https://example.com/test за повече информация.");
  });

  it("accepts a reordering — restoration is by index, so the URLs stay correct", () => {
    const { values } = protectTokens("See https://example.com/a and https://example.com/b.");
    const out = restoreTokens("Вижте [[1]] и [[0]].", values, "segment 1/1");
    assert.equal(out, "Вижте https://example.com/b и https://example.com/a.");
  });

  it("passes a segment with nothing protected straight through", () => {
    assert.equal(
      restoreTokens("Проверете манометъра.", [], "segment 1/1"),
      "Проверете манометъра."
    );
  });
});

describe("restoreTokens — anything ambiguous is rejected, never repaired", () => {
  const twoValues = protectTokens("See https://example.com/a and https://example.com/b.").values;
  const oneValue = protectTokens("Read https://example.com/test now.").values;

  it("rejects a DROPPED placeholder — the benchmark's URL loss", () => {
    assert.throws(
      () => restoreTokens("Прочетете за повече информация.", oneValue, "segment 1/1"),
      parseFailure("protected_token")
    );
  });

  it("names the value that was lost, so the failure is actionable", () => {
    assert.throws(
      () => restoreTokens("Прочетете сега.", oneValue, "segment 3/9"),
      (err: unknown) =>
        err instanceof TranslationParseError &&
        /segment 3\/9/.test(err.message) &&
        /https:\/\/example\.com\/test/.test(err.message)
    );
  });

  it("rejects a DUPLICATED placeholder", () => {
    assert.throws(
      () => restoreTokens("Вижте [[0]] и [[0]].", oneValue, "segment 1/1"),
      parseFailure("protected_token")
    );
  });

  it("rejects a MODIFIED placeholder", () => {
    assert.throws(
      () => restoreTokens("Прочетете [[7]] сега.", oneValue, "segment 1/1"),
      parseFailure("protected_token")
    );
  });

  it("rejects a partially dropped set", () => {
    assert.throws(
      () => restoreTokens("Вижте само [[0]].", twoValues, "segment 1/1"),
      parseFailure("protected_token")
    );
  });

  it("rejects an INVENTED placeholder in a segment that had none", () => {
    assert.throws(
      () => restoreTokens("Вижте [[0]].", [], "segment 1/1"),
      parseFailure("protected_token")
    );
  });

  it("rejects a mangled placeholder — the shape the model must not alter", () => {
    for (const mangled of [
      "Прочетете __ сега.",
      "Прочетете [0] сега.",
      "Прочетете [[ 0 ]] сега.",
    ]) {
      assert.throws(
        () => restoreTokens(mangled, oneValue, "segment 1/1"),
        parseFailure("protected_token")
      );
    }
  });
});

// ─── The article-level invariant's primitive ──────────────────────────────────

describe("extractUrls", () => {
  it("finds every URL in order", () => {
    assert.deepEqual(extractUrls("See https://example.com/a and https://example.com/b."), [
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  it("keeps a duplicate twice", () => {
    assert.deepEqual(extractUrls("https://example.com/a then https://example.com/a"), [
      "https://example.com/a",
      "https://example.com/a",
    ]);
  });

  it("strips the punctuation that ends the sentence, not the URL", () => {
    assert.deepEqual(extractUrls("Go to https://example.com/a."), ["https://example.com/a"]);
    assert.deepEqual(extractUrls("(https://example.com/a),"), ["https://example.com/a"]);
  });

  it("finds none where there are none", () => {
    assert.deepEqual(extractUrls("Проверете манометъра веднъж месечно."), []);
  });
});
