import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractUrls,
  normaliseGluedSentenceBoundaries,
  protectTokens,
  restoreTokens,
} from "./protected-tokens";
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

// ─── Regression: real production failure, cardinal form (MADLAD, feed item 825c8475,
// segment 32/120, 2026-08-20) ──────────────────────────────────────────────────────
//
// "15-minute" matches the SAME internal-punctuation identifier shape as "13th-century"
// (a digit run and a letter run joined by a hyphen), but has no ordinal/decade suffix, so
// the earlier ORDINAL_OR_DECADE_COMPOUND exclusion did not cover it. Protecting it placed
// [[0]] in the same unreliable attributive-adjective slot; measured against the real
// worker, MADLAD did not just drop the placeholder, it invented a DIFFERENT number in its
// place ("10 минути" for source "15-minute"), and restoreTokens correctly rejected the
// result rather than storing a silently wrong translation:
//   "Translation dropped [[0]] in segment 32/120 — the protected value(s) 1 could not be
//    restored unambiguously (15-minute)."
// Left unprotected, the same live worker translates the phrase correctly and faithfully
// ("a 15-minute drive" → "на 15 минути път"), so the fix widens the existing exclusion to
// make the ordinal/decade suffix optional rather than adding a second, parallel rule.
describe("protectTokens — plain cardinal-number-hyphen-word compounds are prose too", () => {
  it("does not protect the exact failing production sentence (segment 32/120)", () => {
    const source =
      "Should you want to venture off the property, the towns of Montepulciano and Pienza " +
      "are a 15-minute drive by car and offer rich Italian history and some of the area's " +
      "best Pecorino cheese.";
    const { text, values } = protectTokens(source);
    assert.equal(text, source, "the sentence must reach MADLAD completely untouched");
    assert.deepEqual(values, []);
  });

  it("does not protect other ordinary cardinal-number prose compounds", () => {
    for (const source of [
      "A 3-day itinerary through Tuscany.",
      "The hotel earned a 5-star rating.",
      "A 10-year renovation project.",
      "The estate has a 20-room main house.",
      "A quick 2-hour transfer from the airport.",
      "It ships with 4-wheel drive.",
      "The 100-acre estate borders the vineyard.",
    ]) {
      assert.deepEqual(protectTokens(source).values, [], `expected "${source}" to stay untouched`);
    }
  });

  it("still protects genuine identifiers of unrelated shapes", () => {
    for (const [source, expected] of [
      ["The model is DCD-800 and it weighs 1.6 kg.", "DCD-800"],
      ["Configured as TX-2/B on the panel.", "TX-2/B"],
      ["Firmware v2.14.3 fixes the charging fault.", "v2.14.3"],
      ["The unit is rated P2 for this duty cycle.", "P2"],
    ] as const) {
      const { values } = protectTokens(source);
      assert.deepEqual(
        values.map((v) => v.value),
        [expected],
        `expected "${expected}" to remain protected in "${source}"`
      );
    }
  });

  it("still protects DCI-P3, a real hyphenated identifier", () => {
    const { values } = protectTokens("The panel covers 100% of DCI-P3 color space.");
    assert.deepEqual(
      values.map((v) => v.value),
      ["DCI-P3"]
    );
  });

  // ─── Regression: real production failure, number-word glue with NO punctuation at
  // all (Ollama/Qwen live logs, 2026-08-26) ──────────────────────────────────────
  //
  // "3.0During" — no space AND no sentence-ending punctuation between "3.0" and
  // "During" at all (a lost paragraph break, not merely a lost space), so
  // `normaliseGluedSentenceBoundaries` (which needs a `.`/`!`/`?` to find the boundary)
  // never saw it. It matched the same internal-punctuation shape as "v2.14.3" and was
  // protected; the placeholder was dropped on every retry.
  describe("protectTokens — a number glued straight to a capitalised word is an artifact, not a version", () => {
    it("does not protect the exact failing production token", () => {
      const source = "The port supports USB 3.0During testing, temperatures stayed low.";
      assert.deepEqual(protectTokens(source).values, []);
    });

    it("does not protect other number-word glue shapes", () => {
      for (const token of ["3.0During", "12Once", "1.5After", "4Since"]) {
        const { values } = protectTokens(`Reached ${token} the test concluded.`);
        assert.deepEqual(values, [], `expected "${token}" to stay untouched`);
      }
    });

    it("still protects a real version string once whitespace is intact", () => {
      const { values } = protectTokens("Firmware v2.14.3 fixes the charging fault.");
      assert.deepEqual(
        values.map((v) => v.value),
        ["v2.14.3"]
      );
    });

    it("does not misfire on a genuine version suffix of only ONE lowercase letter", () => {
      // "3.0Ti" has the identical digit-dot-digit-letter shape as "3.0During" but only
      // one lowercase letter after the capital ("i"), unlike a real glued word
      // ("During" has five) — the two-lowercase-letter floor is what keeps a short,
      // real suffix from being wrongly excluded.
      const { values } = protectTokens("Configured as 3.0Ti on the panel.");
      assert.deepEqual(
        values.map((v) => v.value),
        ["3.0Ti"]
      );
    });
  });

  // ─── Regression: real production failure, glued sentence boundary (MADLAD, feed item
  // 825c8475, segment 69/120, 2026-08-20) ────────────────────────────────────────────
  //
  // The scraped source is missing a whitespace after a sentence-ending period —
  // "...the area's sine qua non grande dame since 1965.In the 55 rooms..." — so
  // `protectTokens`'s whitespace tokeniser saw "1965.In" as ONE token, which matched the
  // internal-punctuation identifier/version shape (the same branch that legitimately
  // protects "v2.14.3") and was protected as [[0]]. MADLAD dropped it, and the whole
  // translation was correctly rejected:
  //   "Translation dropped [[0]] in segment 69/120 — the protected value(s) 1 could not
  //    be restored unambiguously (1965.In)."
  // The fix is a normalisation pass, `normaliseGluedSentenceBoundaries`, run before
  // tokenisation: it inserts the missing space so "1965.In" is never a candidate token
  // at all, using the same abbreviation/initial judgement `endsSentence` already makes
  // for the ordinary, whitespace-preceded case, and explicitly refusing to touch a URL
  // or e-mail address (where a "." is data, not punctuation).
  describe("normaliseGluedSentenceBoundaries — the exact production failure", () => {
    it("inserts the missing space in the exact failing production sentence (segment 69/120)", () => {
      const source =
        "La Roqqa, a cliffside retreat whose distinctive coral-orange façade and secluded " +
        "views of the Tyrrhenian Sea created ripples upon opening in 2023, has provided a " +
        "forward-looking alternative to Hotel Il Pellicano (which you'll see below), the " +
        "area’s sine qua non grande dame since 1965.In the 55 rooms and suites, " +
        "floor-to-ceiling windows let sunshine flood onto walls of sage green or Terra di " +
        "Siena orange, which pop against crisp white bed linens.";
      const fixed = normaliseGluedSentenceBoundaries(source);
      assert.ok(fixed.includes("since 1965. In the 55 rooms"), fixed);
      assert.deepEqual(
        protectTokens(source).values,
        [],
        "1965.In must never become a protected token"
      );
    });

    it("fixes at least three other glued boundaries from the same real article", () => {
      const cases: [string, string][] = [
        ["…boltholes nestled in hilltop towns.August 17, 2026Tobias Kaser…", "towns. August"],
        ["…Il Salviatino feels worlds away. —S.M.Read Full Review…", "—S.M. Read"],
        ["…the top picks in Florence.Powered By: Booking.com", "Florence. Powered"],
      ];
      for (const [source, expectedSubstring] of cases) {
        const fixed = normaliseGluedSentenceBoundaries(source);
        assert.ok(
          fixed.includes(expectedSubstring),
          `expected "${expectedSubstring}" in normalised output, got ${JSON.stringify(fixed)}`
        );
      }
    });

    it("fixes ordinary glued prose boundaries generically", () => {
      for (const [source, expected] of [
        ["The hotel.It was lovely.", "The hotel. It was lovely."],
        ["Loved the great view.The room was clean.", "Loved the great view. The room was clean."],
        [
          "Do you need to plan ahead?Planning ahead helps.",
          "Do you need to plan ahead? Planning ahead helps.",
        ],
      ] as const) {
        assert.equal(normaliseGluedSentenceBoundaries(source), expected);
      }
    });
  });

  describe("normaliseGluedSentenceBoundaries — must not touch real versions, decimals, URLs, emails, initials, or abbreviations", () => {
    const UNTOUCHED = [
      "Firmware v2.14.3 fixes the charging fault.",
      "The pack costs 1.5 for the base unit.",
      "The needle should sit at approx. 12.5 bar for a powder unit.",
      "Visit example.com for details.",
      "Read https://example.com/a for more.",
      "Write to service@example.com before it expires.",
      "J.K. Rowling wrote the series.",
      "It happened in the U.S.A. after the war.",
      "It happened in the U.K. last year.",
      "See fig. 3 for the diagram.",
      "The model is DCD-800 and it weighs 1.6 kg.",
    ];

    for (const source of UNTOUCHED) {
      it(`leaves "${source.slice(0, 40)}…" completely unchanged`, () => {
        assert.equal(normaliseGluedSentenceBoundaries(source), source);
      });
    }

    it("never disturbs what protectTokens protects for these sentences", () => {
      assert.deepEqual(protectTokens("Firmware v2.14.3 fixes the charging fault.").values, [
        { kind: "identifier", value: "v2.14.3" },
      ]);
      assert.deepEqual(protectTokens("Read https://example.com/a for more.").values, [
        { kind: "url", value: "https://example.com/a" },
      ]);
      assert.deepEqual(protectTokens("Write to service@example.com before it expires.").values, [
        { kind: "email", value: "service@example.com" },
      ]);
      assert.deepEqual(protectTokens("The model is DCD-800 and it weighs 1.6 kg.").values, [
        { kind: "identifier", value: "DCD-800" },
      ]);
    });

    it("never splits a glued URL or e-mail even when a capital letter follows the domain", () => {
      // A "." inside a URL or e-mail is data, never a sentence boundary — even when the
      // glued word after it happens to start with a capital letter, which would
      // otherwise match the glued-boundary shape.
      const urlCase = "See www.example.com.The article covers it in full.";
      assert.equal(normaliseGluedSentenceBoundaries(urlCase), urlCase);

      const emailCase = "Write to service@example.com.The reply comes within a day.";
      assert.equal(normaliseGluedSentenceBoundaries(emailCase), emailCase);
    });
  });
});

// ─── Measurements glued to their unit are not identities ──────────────────────
//
// The module header has always stated the policy: measurements stay translatable,
// because the model localises them correctly ("90 Nm … 13 mm" → "90 Нм … 13 мм") and a
// placeholder freezes English formatting into Bulgarian. `isIdentifier` implemented
// that only for the SPACED form. English technical writing glues the unit to the
// number, and once "32GB" is a single token it is indistinguishable by shape from a
// model code: no lowercase letter, so it matched the all-caps branch, while "2.55GHz"
// and "7300MB/s" carry internal punctuation and matched the separator branch.
//
// The consequence is not merely cosmetic. Restoration is a conjunctive gate — every
// index must return exactly once — so an article's survival odds fall geometrically
// with the placeholder count, and a spec-heavy review reaches ~85 of them across the
// 3000-char body cap. These tests pin the line between a QUANTITY (translatable) and an
// IDENTITY (protected), in both directions, because moving it the wrong way in either
// direction is a silent data loss.
describe("protectTokens — measurements glued to a unit are quantities, not identifiers", () => {
  const MEASUREMENTS = [
    // Data size and rate.
    "32GB",
    "16GB",
    "2TB",
    "512MB",
    "1.5TB",
    "7300MB/s",
    "43.2PB/sec",
    "10Gbps",
    // Frequency.
    "2.55GHz",
    "5.4GHz",
    "240Hz",
    "120Hz",
    "3200MHz",
    "60Hz",
    // Power, energy, electricity.
    "320W",
    "90W",
    "65W",
    "230V",
    "5000mAh",
    "12V",
    "1.5A",
    // Temperature.
    "78C",
    "95C",
    "6500K",
    // Resolution shorthand, length, time, imaging.
    "4K",
    "8K",
    "16mm",
    "1.6kg",
    "120fps",
    "50MP",
    "7200rpm",
    "0.5ms",
  ];

  for (const token of MEASUREMENTS) {
    it(`leaves "${token}" translatable`, () => {
      const source = `The unit is rated ${token} in practice.`;
      const { text, values } = protectTokens(source);
      assert.equal(text, source, `"${token}" must reach the model untouched`);
      assert.deepEqual(values, []);
    });
  }

  it("leaves a measurement alone in the sentence positions that used to protect it", () => {
    for (const source of [
      "32GB of memory ships as standard.",
      "It ships with 32GB.",
      "Memory (32GB) is soldered.",
      "Two sticks, 16GB and 16GB, fill the board.",
      "Bandwidth reaches 7300MB/s, well past the older part.",
    ]) {
      assert.deepEqual(protectTokens(source).values, [], `expected "${source}" untouched`);
    }
  });

  it("still protects the product identifiers that sit right beside those measurements", () => {
    // The whole point of the narrowing: a spec sentence keeps its IDENTITIES protected
    // while shedding its QUANTITIES, so the values whose loss would be silent are the
    // only ones the model is asked to carry.
    const { values } = protectTokens(
      "The BE173BU pairs a 7700X3D with 32GB of DDR5-6000 at 2.55GHz and 320W."
    );
    assert.deepEqual(
      values.map((v) => v.value),
      ["BE173BU", "7700X3D", "DDR5-6000"]
    );
  });

  it("keeps an identifier that merely ENDS in something unit-shaped", () => {
    // A closed unit list, anchored to a number that must come FIRST, is what separates
    // these from "32GB": every one of them either starts with a letter or ends in a
    // suffix no unit list contains.
    for (const [source, expected] of [
      ["The BE173BU is the panel in question.", "BE173BU"],
      ["Paired with a 7700X3D processor.", "7700X3D"],
      ["The SN850X is the drive under test.", "SN850X"],
      ["An X670E board hosts the chip.", "X670E"],
      ["Memory is DDR5-6000 throughout.", "DDR5-6000"],
      ["Firmware V1.04 fixed the flicker.", "V1.04"],
      ["The GDDR6X modules run hot.", "GDDR6X"],
      ["Rated HDR10 for the panel.", "HDR10"],
    ] as const) {
      const { values } = protectTokens(source);
      assert.deepEqual(
        values.map((v) => v.value),
        [expected],
        `expected "${expected}" to stay protected in "${source}"`
      );
    }
  });

  it("requires the NUMBER to come first — a letter-led token is never a measurement", () => {
    // "V1.04" is a version, "W3C" is a name; both would be measurements if the unit were
    // allowed to lead. Only "1.04V" and "3W" are quantities.
    assert.deepEqual(
      protectTokens("Firmware V1.04 draws 1.04V at idle.").values.map((v) => v.value),
      ["V1.04"]
    );
  });

  it("requires a KNOWN unit — an unrecognised suffix stays an identifier", () => {
    for (const token of ["7700X3D", "16U", "3D", "5G", "2B12"]) {
      const { values } = protectTokens(`Model ${token} is listed.`);
      assert.equal(values.length, 1, `"${token}" must remain protected`);
      assert.equal(values[0].value, token);
    }
  });

  it("cuts the placeholder count on a real spec-heavy paragraph", () => {
    // The measured basis of the change: a representative hardware-review paragraph of
    // the shape TechPowerUp and ServeTheHome publish. Before the narrowing this produced
    // 22 placeholders — indices past [[20]] in ONE paragraph, and ~85 once extrapolated
    // across the 3000-char body cap, every one of which the model had to reproduce
    // exactly once or lose the whole article.
    const paragraph =
      "The MSI MEG BE173BU monitor pairs a 4K panel with HDR10 support and a 240Hz " +
      "refresh rate. Inside our test rig sat a Ryzen 7 7700X3D paired with 32GB of " +
      "DDR5-6000 memory on an X670E board. Storage came from a 2TB WD_BLACK SN850X " +
      "NVMe SSD rated at 7300MB/s sequential reads. The GPU was an RTX 4080 Super with " +
      "16GB GDDR6X running at 2.55GHz boost. Power draw peaked at 320W under load, and " +
      "the CPU held 5.4GHz on two cores while the package sat at 78C. Firmware V1.04 " +
      "fixed the flicker we saw at 120Hz on the earlier F0.92 build. See " +
      "https://example.com/reviews/be173bu for the full charts.";

    const { values } = protectTokens(paragraph);

    // Exact, in order of appearance — pinned in BOTH directions, because the failure this
    // narrowing fixes and the corruption the module exists to prevent sit on opposite
    // sides of this one list. Every entry is an IDENTITY whose loss would be silent;
    // every quantity in the paragraph (4K, 240Hz, 32GB, 2TB, 7300MB/s, 16GB, 2.55GHz,
    // 320W, 5.4GHz, 78C, 120Hz) is absent and now reaches the model as ordinary text.
    assert.deepEqual(
      values.map((v) => v.value),
      [
        "BE173BU",
        "HDR10",
        "7700X3D",
        "DDR5-6000",
        "X670E",
        "SN850X",
        "GDDR6X",
        "V1.04",
        "F0.92",
        "https://example.com/reviews/be173bu",
      ]
    );
  });

  it("does not disturb the spaced form, which was already translatable", () => {
    const source = "Maximum torque is 90 Nm and the chuck is 13 mm keyless.";
    assert.equal(protectTokens(source).text, source);
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
