import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  requiredIdentifiers,
  watchedEntities,
  verifyPolishedChunk,
  chunkParagraphs,
  buildContentPolishPrompt,
  buildTitlePolishPrompt,
  parsePolishReply,
  checkUntranslatedEnglish,
  verifyNumbers,
  verifyRetention,
  verifySegmentPolish,
  selectSuspiciousSegments,
  MIN_RETENTION_RATIO,
  type ReconstructedSegment,
} from "./experiment-translation-polish";

/**
 * Pure functions only — no network, no DB. These exercise the SAME verification
 * primitives (`unpreservedValues`, `protectTokens`) the real MADLAD repair mechanism
 * uses, applied to a different failure mode: a polish that damages an identifier the
 * article already carried correctly.
 */

describe("requiredIdentifiers", () => {
  it("finds the genuine identifiers protectTokens would freeze", () => {
    // "44GB" and "300GB/sec" are glued MEASUREMENTS, not identities — protectTokens
    // stopped freezing that shape once the classifier was narrowed to exclude
    // number-plus-known-unit tokens (see protected-tokens.ts's MEASUREMENT_SHAPE),
    // so only the genuine model identifier survives here now.
    const ids = requiredIdentifiers("The WSE-3 has 44GB of SRAM and 300GB/sec bandwidth.");
    assert.deepEqual(
      ids.map((v) => v.value),
      ["WSE-3"]
    );
  });

  it("does not flag plain words as identifiers", () => {
    assert.deepEqual(requiredIdentifiers("Cerebras uses TSMC and NVIDIA chips."), []);
  });
});

describe("watchedEntities", () => {
  it("catches all-caps acronyms, Cerebras, and mixed-case-plus-digit standards", () => {
    const found = watchedEntities(
      "Cerebras uses TSMC silicon and NVIDIA rivals it. RoCEv2 networking connects the SRAM."
    );
    assert.ok(found.includes("Cerebras"));
    assert.ok(found.includes("TSMC"));
    assert.ok(found.includes("NVIDIA"));
    assert.ok(found.includes("SRAM"));
    assert.ok(found.includes("RoCEv2"));
  });

  it("does not fire on ordinary capitalised prose", () => {
    assert.deepEqual(watchedEntities("The Company Announced A New Product Today."), []);
  });
});

describe("verifyPolishedChunk", () => {
  it("accepts a polish that keeps every identifier and entity exactly", () => {
    const v = verifyPolishedChunk(
      "The WSE-3 has 44GB of SRAM, built by TSMC.",
      "WSE-3 разполага с 44GB SRAM памет, произведена от TSMC."
    );
    assert.equal(v.ok, true);
    assert.deepEqual(v.lostIdentifiers, []);
    assert.deepEqual(v.lostEntities, []);
  });

  it("rejects a polish that transliterates a protected identifier", () => {
    const v = verifyPolishedChunk(
      "The WSE-3 has 44GB of SRAM.",
      "УСЕ-3 разполага с 44GB памет." // WSE-3 transliterated to Cyrillic
    );
    assert.equal(v.ok, false);
    assert.deepEqual(v.lostIdentifiers, ["WSE-3"]);
  });

  it("rejects a polish that transliterates a watched entity", () => {
    const v = verifyPolishedChunk(
      "Cerebras announced the chip.",
      "Церебра обяви чипа." // "Cerebras" transliterated — the exact production defect
    );
    assert.equal(v.ok, false);
    assert.ok(v.lostEntities.includes("Cerebras"));
  });

  it("rejects a polish that changes an identifier's multiplicity", () => {
    const v = verifyPolishedChunk(
      "The CS-4 replaces the CS-3, which replaced the earlier CS-3.",
      "CS-4 замества CS-3." // one "CS-3" occurrence dropped
    );
    assert.equal(v.ok, false);
    assert.ok(v.lostIdentifiers.includes("CS-3"));
  });

  it("rejects a polish that degenerates into a repetition loop", () => {
    const v = verifyPolishedChunk(
      "The system is fast.",
      "Системата е бърза, бърза, бърза, бърза, бърза, бърза, бърза, бърза."
    );
    assert.equal(v.ok, false);
    assert.equal(v.isDegenerate, true);
  });

  it("rejects a polish that reverted to English", () => {
    const v = verifyPolishedChunk("The system is fast.", "The system remained in English.");
    assert.equal(v.ok, false);
    assert.equal(v.isBulgarian, false);
  });
});

describe("chunkParagraphs", () => {
  it("keeps paragraphs together under the char budget and never splits one", () => {
    const en = ["Para one.", "Para two.", "Para three is a bit longer than the others."].join(
      "\n\n"
    );
    const bg = ["Параграф едно.", "Параграф две.", "Параграф три е малко по-дълъг."].join("\n\n");
    const chunks = chunkParagraphs(en, bg, 1000);
    assert.equal(chunks.length, 1, "everything fits in one chunk under a generous budget");
    assert.equal(chunks[0].firstParagraph, 0);
    assert.equal(chunks[0].lastParagraph, 2);
  });

  it("splits into multiple chunks once the budget is tight, on paragraph boundaries only", () => {
    const en = ["First paragraph here.", "Second paragraph here.", "Third paragraph here."].join(
      "\n\n"
    );
    const bg = ["Първи параграф тук.", "Втори параграф тук.", "Трети параграф тук."].join("\n\n");
    const chunks = chunkParagraphs(en, bg, 25); // each paragraph alone is ~22 chars
    assert.ok(chunks.length >= 2);
    // Every English paragraph appears in exactly one chunk, in order, nothing merged
    // across a boundary that would exceed the budget.
    const covered = chunks.flatMap((c) =>
      Array.from({ length: c.lastParagraph - c.firstParagraph + 1 }, (_, i) => c.firstParagraph + i)
    );
    assert.deepEqual(covered, [0, 1, 2]);
  });

  it("throws rather than guessing when English and Bulgarian paragraph counts disagree", () => {
    assert.throws(
      () => chunkParagraphs("One.\n\nTwo.\n\nThree.", "Едно.\n\nДве.", 1000),
      /Paragraph count mismatch/
    );
  });

  it("pairs the Nth English paragraph with the Nth Bulgarian paragraph", () => {
    const chunks = chunkParagraphs("A.\n\nB.", "Едно.\n\nДве.", 1000);
    assert.equal(chunks[0].en, "A.\n\nB.");
    assert.equal(chunks[0].bg, "Едно.\n\nДве.");
  });
});

describe("buildContentPolishPrompt / buildTitlePolishPrompt", () => {
  it("names every required identifier and entity explicitly in the system prompt", () => {
    const p = buildContentPolishPrompt(
      "The WSE-3 has 44GB.",
      "УСЕ-3 разполага с 44GB.",
      ["WSE-3", "44GB"],
      ["Cerebras"]
    );
    assert.ok(p.systemPrompt.includes("WSE-3"));
    assert.ok(p.systemPrompt.includes("44GB"));
    assert.ok(p.systemPrompt.includes("Cerebras"));
  });

  it("states editing, not translating from scratch", () => {
    const p = buildContentPolishPrompt("English.", "Bulgarian.", [], []);
    assert.match(p.systemPrompt, /EDITING/);
    assert.match(p.systemPrompt, /you are NOT/);
    assert.match(p.systemPrompt, /translating the English source from scratch/);
  });

  it("forbids shortening, adding, or removing facts", () => {
    const p = buildContentPolishPrompt("English.", "Bulgarian.", [], []);
    assert.match(p.systemPrompt, /Do not shorten/);
    assert.match(p.systemPrompt, /Do not add facts/);
    assert.match(p.systemPrompt, /remove facts/);
  });

  it("sends both the English source and the Bulgarian draft in the user prompt", () => {
    const p = buildContentPolishPrompt("The English text.", "Текстът на български.", [], []);
    assert.ok(p.userPrompt.includes("The English text."));
    assert.ok(p.userPrompt.includes("Текстът на български."));
  });

  it("requests a content-only JSON shape for chunks, and title-only for titles", () => {
    const content = buildContentPolishPrompt("E", "B", [], []);
    const title = buildTitlePolishPrompt("E", "B", [], []);
    assert.match(content.systemPrompt, /\{"content": "\.\.\."\}/);
    assert.match(title.systemPrompt, /\{"title": "\.\.\."\}/);
  });
});

describe("parsePolishReply", () => {
  it("parses a clean JSON reply", () => {
    assert.equal(parsePolishReply('{"content": "Здравей"}', "content"), "Здравей");
  });

  it("tolerates a markdown code fence around the JSON", () => {
    assert.equal(parsePolishReply('```json\n{"title": "Заглавие"}\n```', "title"), "Заглавие");
  });

  it("returns null for unparseable or empty replies", () => {
    assert.equal(parsePolishReply("not json at all", "content"), null);
    assert.equal(parsePolishReply('{"content": ""}', "content"), null);
    assert.equal(parsePolishReply('{"content": "   "}', "content"), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SELECTIVE SEGMENT-LEVEL ARCHITECTURE
// ═══════════════════════════════════════════════════════════════════════════════

describe("checkUntranslatedEnglish", () => {
  it("flags a genuine untranslated English sentence", () => {
    const c = checkUntranslatedEnglish(
      "By the numbers, we are once again looking at a wafer-sized processor with 44GB of SRAM.",
      "By the numbers, we are once again looking at a wafer-sized processor with 44GB of SRAM."
    );
    assert.equal(c.suspicious, true);
    assert.ok(c.foundStopwords.includes("we"));
  });

  it("does NOT flag a cluster of identifiers and entities alone", () => {
    // Exactly the shape the task warns about: Latin characters, but no prose.
    const c = checkUntranslatedEnglish(
      "The WSE-3 CS-4 NVIDIA AMD TSMC PCIe NVMe SRAM PFLOPS FP16 RoCEv2 system.",
      "Системата WSE-3 CS-4 NVIDIA AMD TSMC PCIe NVMe SRAM PFLOPS FP16 RoCEv2."
    );
    assert.equal(c.suspicious, false);
  });

  it("does not flag a fully translated Bulgarian segment", () => {
    const c = checkUntranslatedEnglish(
      "The WSE-3 has 44GB of SRAM.",
      "WSE-3 разполага с 44GB SRAM памет."
    );
    assert.equal(c.suspicious, false);
  });
});

describe("verifyNumbers", () => {
  it("accepts identical significant numbers, formatting differences aside", () => {
    const v = verifyNumbers(
      "It has 44GB of SRAM and 900,000 cores at 43.2PB/sec.",
      "Разполага с 44GB SRAM и 900 000 ядра при 43,2PB/сек."
    );
    assert.equal(v.ok, true, JSON.stringify(v));
  });

  it("does NOT flag small numbers spelled out as Bulgarian words — the real 'three -> три' case", () => {
    const v = verifyNumbers(
      "Cerebras has produced three iterations of the wafer-scale engine.",
      "Cerebras произвежда три итерации на двигателя."
    );
    assert.equal(v.ok, true, JSON.stringify(v));
  });

  it("rejects a dropped/altered decimal — 42.2 silently became 43.2", () => {
    const v = verifyNumbers(
      "The bandwidth doubled to 42.2PB/second.",
      "Честотната лента се удвои до 43.2PB/секунда."
    );
    assert.equal(v.ok, false);
    assert.ok(v.missingNumbers.includes("42.2"));
    assert.ok(v.inventedNumbers.includes("43.2"));
  });

  it("rejects an invented currency word attached to an otherwise correct number", () => {
    // The exact real regression: "2.6 trillion transistors" gained "долара".
    const v = verifyNumbers(
      "The chip comprises 2.6 trillion transistors.",
      "Чипът съдържа 2.6 трилиона долара транзистори."
    );
    assert.equal(v.ok, false);
    assert.equal(v.inventedCurrency, true);
  });

  it("allows a currency word when the English source actually mentions money", () => {
    const v = verifyNumbers(
      "The device costs $2.6 million.",
      "Устройството струва 2.6 милиона долара."
    );
    assert.equal(v.inventedCurrency, false);
  });
});

describe("verifyRetention — calibrated on the real SRAM collapse", () => {
  it("accepts the real accepted edit's ratio (madlad 1560c -> polished 1564c)", () => {
    const madlad = "x".repeat(1560);
    const polished = "x".repeat(1564);
    const r = verifyRetention(madlad, polished);
    assert.equal(r.ok, true);
  });

  it("rejects the real SRAM collapse (a 141-char fragment reduced to one word)", () => {
    const madladBg =
      "Брой на транзистори / 4 трилиона / 4 трилиона / 2.6 трилиона / TSMC 5nm процес";
    const polishedBg = "SRAM";
    const r = verifyRetention(madladBg, polishedBg);
    assert.equal(r.ok, false);
    assert.ok(r.charRatio < MIN_RETENTION_RATIO);
  });
});

describe("verifySegmentPolish", () => {
  it("accepts a genuinely good edit", () => {
    const v = verifySegmentPolish(
      "Cerebras is not stopping there, with the WSE-3 pushing 44GB of SRAM.",
      "Не спира дотук, с WSE-3 достигащ 44GB SRAM.",
      "Cerebras не спира дотук, като WSE-3 достига 44GB SRAM."
    );
    assert.equal(v.ok, true, v.reason ?? "");
  });

  it("rejects the exact real SRAM collapse end to end", () => {
    const v = verifySegmentPolish(
      "Transistor Count 4 Trillion 4 Trillion 2.6 Trillion",
      "Брой на транзистори 4 трилиона 4 трилиона 2.6 трилиона",
      "SRAM"
    );
    assert.equal(v.ok, false);
    assert.match(v.reason ?? "", /content collapse/);
  });

  it("rejects an entity transliteration even when length and numbers are fine", () => {
    const v = verifySegmentPolish(
      "Cerebras announced the WSE-3 with 44GB of SRAM today.",
      "Церебра обяви WSE-3 с 44GB SRAM днес.",
      "Церебра представи WSE-3 с 44GB SRAM памет днес."
    );
    assert.equal(v.ok, false);
    assert.match(v.reason ?? "", /entities/);
  });
});

describe("selectSuspiciousSegments", () => {
  function seg(
    index: number,
    en: string,
    bg: string,
    provenance: ReconstructedSegment["provenance"]
  ): ReconstructedSegment {
    return { index, en, bg, provenance };
  }

  it("selects a MADLAD-repaired segment (with enough surrounding prose to clear the fragment floor)", () => {
    const segments = [
      seg(
        0,
        "Today, I'm taking a closer look at the WSE-3 which has 44GB of SRAM on board.",
        "Днес разглеждам по-отблизо WSE-3, който разполага с 44GB SRAM на борда.",
        "repaired"
      ),
    ];
    const selected = selectSuspiciousSegments(segments);
    assert.equal(selected.length, 1);
    assert.deepEqual(selected[0].reasons, ["madlad_repaired"]);
  });

  it("selects a MADLAD-fallback segment without redundantly also flagging untranslated English", () => {
    const segments = [
      seg(
        0,
        "The system supports RoCEv2 networking end to end.",
        "The system supports RoCEv2 networking end to end.",
        "fallback"
      ),
    ];
    const selected = selectSuspiciousSegments(segments);
    assert.deepEqual(selected[0].reasons, ["madlad_fallback"]);
  });

  it("selects a native segment that still contains untranslated English prose", () => {
    const segments = [
      seg(
        0,
        "By the numbers, we are once again looking at a wafer-sized processor with 44GB of SRAM.",
        "By the numbers, we are once again looking at a wafer-sized processor with 44GB of SRAM.",
        "native"
      ),
    ];
    const selected = selectSuspiciousSegments(segments);
    assert.deepEqual(selected[0].reasons, ["untranslated_english"]);
  });

  it("does NOT select a healthy native segment", () => {
    const segments = [
      seg(0, "The WSE-3 has 44GB of SRAM.", "WSE-3 разполага с 44GB SRAM памет.", "native"),
    ];
    assert.deepEqual(selectSuspiciousSegments(segments), []);
  });

  it("does NOT select a bypassed data-only segment", () => {
    const segments = [seg(0, "44GB", "44GB", "bypassed")];
    assert.deepEqual(selectSuspiciousSegments(segments), []);
  });

  it("does NOT select a short identifier-only fragment even if repaired", () => {
    // "WSE-3 Turbo" — WSE-3 is an identifier, "Turbo" is prose but under the char floor.
    const segments = [seg(0, "WSE-3 Turbo", "WSE-3 Турбо", "repaired")];
    assert.deepEqual(selectSuspiciousSegments(segments), []);
  });

  it("keeps segments in article order", () => {
    const segments = [
      seg(
        0,
        "Healthy sentence here about nothing technical at all.",
        "Здравословно изречение тук за нищо техническо.",
        "native"
      ),
      seg(
        1,
        "Another sentence that MADLAD needed help repairing here.",
        "Друго изречение, което MADLAD трябваше да поправи тук.",
        "repaired"
      ),
      seg(
        2,
        "A third sentence, also fine and long enough to skip the floor.",
        "A third sentence, also fine and long enough to skip the floor.",
        "fallback"
      ),
    ];
    const selected = selectSuspiciousSegments(segments);
    assert.deepEqual(
      selected.map((s) => s.segment.index),
      [1, 2]
    );
  });
});
