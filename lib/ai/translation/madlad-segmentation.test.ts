import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_SEGMENT_CHARS, reassembleArticle, segmentArticle } from "./madlad-segmentation";
import type { SegmentPlan } from "./madlad-segmentation";
import { TRANSLATION_FIXTURES } from "./translation-fixtures";
import { sanitiseTranslationContent } from "@/lib/ai/feed-item-translation";

/**
 * The split is the part of the MADLAD path that can be got wrong quietly: a lost
 * segment does not throw, it just removes a paragraph from an article nobody reads in
 * the original. So the properties asserted here are mostly conservation ones —
 * everything that goes in comes back, in order, with its shape intact.
 *
 * The strongest of them is the identity round trip: split an article, "translate" each
 * segment to itself, reassemble, and require the result to equal the sanitised input
 * character for character. That single assertion covers gluing, lost blank lines,
 * duplicated punctuation and altered numbers at once, which is why every fixture is
 * run through it.
 */

const PARA_A = "First paragraph, short enough to stay whole.";
const PARA_B = "Second paragraph, also short.";

/** The body as the pipeline will actually hand it over — sanitised, not raw. */
const sanitised = (content: string): string => sanitiseTranslationContent(content) ?? "";

/** Splits, translates each segment to itself, and puts it back together. */
function roundTrip(title: string | null, content: string | null, maxSegmentChars?: number) {
  const { segments, plan } = segmentArticle(title, content, {
    maxContentChars: 100_000,
    ...(maxSegmentChars === undefined ? {} : { maxSegmentChars }),
  });
  return { ...reassembleArticle(plan, segments), segments, plan };
}

/** The separators the plan recorded, in document order. */
const separators = (plan: SegmentPlan): string[] => plan.body.map((p) => p.separator);

describe("segmentArticle", () => {
  it("puts the title first and the body after it", () => {
    const { segments, plan } = segmentArticle("A title", `${PARA_A}\n\n${PARA_B}`);
    assert.equal(plan.titleIndex, 0);
    assert.equal(segments[0], "A title");
    assert.equal(segments[1], PARA_A);
    assert.equal(segments[2], PARA_B);
    assert.deepEqual(
      plan.body.map((p) => p.index),
      [1, 2]
    );
  });

  it("has no title segment when the article has no title", () => {
    const { segments, plan } = segmentArticle(null, PARA_A);
    assert.equal(plan.titleIndex, null);
    assert.equal(segments[0], PARA_A);
    assert.deepEqual(plan.body, [{ separator: "", prefix: "", index: 0 }]);
  });

  it("sends no body at all in title-only mode", () => {
    const { segments, plan, contentChars } = segmentArticle("A title", PARA_A, {
      mode: "title_only",
    });
    assert.deepEqual(segments, ["A title"]);
    assert.deepEqual(plan.body, []);
    assert.equal(contentChars, 0);
  });

  it("cuts a single unbroken sentence rather than sending more than the model holds", () => {
    const runOn = "дума ".repeat(300).trim(); // no sentence punctuation at all
    const { segments } = segmentArticle(null, runOn, { maxSegmentChars: 120 });
    assert.ok(segments.length > 1);
    for (const segment of segments) assert.ok(segment.length <= 120);
  });

  it("loses no words when a long sentence is divided", () => {
    const sentence = `Батериите ${"трябва да бъдат напълно заредени преди употреба ".repeat(20)}днес.`;
    const { segments } = segmentArticle(null, sentence, {
      maxSegmentChars: 150,
      maxContentChars: 100_000,
    });

    const wordsIn = sentence.split(/\s+/).length;
    const wordsOut = segments.join(" ").split(/\s+/).length;
    assert.equal(wordsOut, wordsIn, "the split must not drop or duplicate words");
  });

  it("drops blank paragraphs instead of sending empty segments", () => {
    const { segments, plan } = segmentArticle(null, `${PARA_A}\n\n   \n\n${PARA_B}`);
    assert.equal(segments.length, 2);
    assert.equal(plan.body.length, 2);
    assert.ok(segments.every((s) => s.trim().length > 0));
  });

  it("caps the body with the same budget the prompt-based engine uses", () => {
    const huge = "Изречение за проверка. ".repeat(1000);
    const { contentChars } = segmentArticle("t", huge, { maxContentChars: 500 });
    assert.ok(contentChars <= 500, `sent ${contentChars} chars against a 500 budget`);
  });

  it("defaults the segment cap to MAX_SEGMENT_CHARS", () => {
    const paragraph = `Начало ${"дума ".repeat(400)}край.`;
    const { segments } = segmentArticle(null, paragraph, { maxContentChars: 100_000 });
    for (const segment of segments) assert.ok(segment.length <= MAX_SEGMENT_CHARS);
  });

  it("produces no segments for an article with nothing in it", () => {
    const { segments } = segmentArticle(null, null);
    assert.deepEqual(segments, []);
  });
});

// ─── The benchmark failure: one segment per SENTENCE ──────────────────────────

describe("segmentArticle — one sentence per segment", () => {
  /**
   * The exact defect the first real benchmark produced. Two sentences in one segment
   * came back from MADLAD joined without a space ("…съхранение.Датата на…"), because a
   * sentence-level NMT model runs them together. It cannot be repaired at the join —
   * by then the boundary is inside a single returned string — so each sentence must be
   * its own segment and its separator must be recorded.
   */
  const TWO = "Sentence one. Sentence two.";

  it("sends two sentences of one paragraph as two separate segments", () => {
    const { segments } = segmentArticle(null, TWO, { maxContentChars: 100_000 });
    assert.deepEqual(segments, ["Sentence one.", "Sentence two."]);
  });

  it("records the space between them as the separator", () => {
    const { plan } = segmentArticle(null, TWO, { maxContentChars: 100_000 });
    assert.deepEqual(separators(plan), ["", " "]);
  });

  it("never glues the translations together", () => {
    const { plan } = segmentArticle(null, TWO, { maxContentChars: 100_000 });
    const out = reassembleArticle(plan, ["Превод едно.", "Превод две."]);
    assert.equal(out.translatedContent, "Превод едно. Превод две.");
    assert.ok(
      !out.translatedContent?.includes("едно.Превод"),
      "this is the exact benchmark failure and must never come back"
    );
  });

  it("handles many sentences in one paragraph", () => {
    const many = "One. Two. Three. Four! Five?";
    const { segments, plan } = segmentArticle(null, many, { maxContentChars: 100_000 });
    assert.equal(segments.length, 5);
    assert.deepEqual(separators(plan), ["", " ", " ", " ", " "]);
    assert.equal(reassembleArticle(plan, segments).translatedContent, many);
  });

  it("reproduces the fire-extinguisher paragraph as separate sentences", () => {
    const source =
      "A fire extinguisher can last between 5 and 15 years, depending on its type and how it has been stored. " +
      "The manufacturing date is stamped on the cylinder or printed on the label.";
    const { segments, plan } = segmentArticle(null, source, { maxContentChars: 100_000 });

    assert.equal(segments.length, 2);
    const out = reassembleArticle(plan, [
      "Пожарогасителят може да издържи между 5 и 15 години, в зависимост от вида му и начина на съхранение.",
      "Датата на производство е отпечатана върху цилиндъра или върху етикета.",
    ]);
    assert.ok(out.translatedContent?.includes("съхранение. Датата"));
    assert.ok(!out.translatedContent?.includes("съхранение.Датата"));
  });
});

// ─── Structure ────────────────────────────────────────────────────────────────

describe("segmentArticle — lines, paragraphs and markers", () => {
  const LIST = "Проверете следното:\n- Манометърът\n- Осигурителният щифт\n- Маркучът";

  it("records a newline between lines and a blank line between paragraphs", () => {
    const { plan } = segmentArticle(null, "Ред едно\nРед две\n\nПараграф две.", {
      maxContentChars: 100_000,
    });
    assert.deepEqual(separators(plan), ["", "\n", "\n\n"]);
  });

  it("holds the bullet marker back so the model never sees it", () => {
    const { segments, plan } = segmentArticle(null, LIST, { maxContentChars: 100_000 });
    assert.ok(
      segments.every((s) => !s.startsWith("-")),
      "a marker sent to the model can be dropped, translated or doubled by it"
    );
    assert.deepEqual(
      plan.body.map((p) => p.prefix),
      ["", "- ", "- ", "- "]
    );
  });

  it("keeps the numbers of a numbered list out of the decoder entirely", () => {
    const { segments, plan } = segmentArticle(null, "1. Първо\n2. Второ\n3. Трето", {
      maxContentChars: 100_000,
    });
    assert.deepEqual(segments, ["Първо", "Второ", "Трето"]);
    assert.deepEqual(
      plan.body.map((p) => p.prefix),
      ["1. ", "2. ", "3. "]
    );
  });

  it("re-attaches every marker exactly once", () => {
    const { translatedContent } = roundTrip(null, LIST);
    assert.equal(translatedContent, LIST);
    assert.equal((translatedContent ?? "").match(/- /g)?.length, 3, "no duplicated markers");
  });

  it("does not split on a mid-sentence colon", () => {
    // A colon joins a clause to what introduces it. Splitting there hands the model a
    // fragment, which it translates as a fresh sentence and capitalises — the
    // "…е измерима: Същият пакет…" defect from the power-tools benchmark.
    const source = "That difference is measurable: the same pack drives more screws.";
    const { segments } = segmentArticle(null, source, { maxContentChars: 100_000 });
    assert.deepEqual(segments, [source]);
  });

  it("keeps a heading on its own line, above its paragraph", () => {
    const source = "What to inspect:\nCheck the pressure gauge.";
    const { segments, plan } = segmentArticle(null, source, { maxContentChars: 100_000 });
    assert.deepEqual(segments, ["What to inspect:", "Check the pressure gauge."]);
    assert.deepEqual(separators(plan), ["", "\n"]);
    assert.equal(reassembleArticle(plan, segments).translatedContent, source);
  });

  it("keeps bullets on their own lines under a heading", () => {
    const source = "What to inspect:\n- Check the pressure gauge\n- Check the safety pin";
    const { translatedContent } = roundTrip(null, source);
    assert.equal(translatedContent, source);
  });

  it("does not glue bullets together when every line must be chunked", () => {
    const long = `Заглавие на списъка:\n${Array.from(
      { length: 12 },
      (_, i) => `- Точка номер ${i + 1} с достатъчно дълъг текст, за да надхвърли лимита.`
    ).join("\n")}`;

    const { translatedContent } = roundTrip(null, long, 40);
    assert.equal(translatedContent, long);
    assert.equal((translatedContent ?? "").split("\n").length, 13);
  });

  it("drops a line that is nothing but its own marker", () => {
    const { segments, plan } = segmentArticle(null, "Текст\n-\nОще текст", {
      maxContentChars: 100_000,
    });
    assert.equal(segments.length, 2);
    assert.equal(plan.body.length, 2);
  });

  it("does not mistake a dash opening a sentence for a bullet", () => {
    const line = "—това е тире, не булет.";
    const { segments } = segmentArticle(null, line, { maxContentChars: 100_000 });
    assert.deepEqual(segments, [line]);
  });

  it("handles multiple paragraphs", () => {
    const source = "Paragraph one.\n\nParagraph two.";
    const { segments, plan, translatedContent } = roundTrip(null, source);
    assert.equal(segments.length, 2);
    assert.deepEqual(separators(plan), ["", "\n\n"]);
    assert.equal(translatedContent, source);
  });
});

// ─── The things a reassembly must never do ────────────────────────────────────

describe("round trip — numbers, punctuation, URLs and blank lines survive", () => {
  const TRICKY = [
    "Уредът издържа между 5 и 15 години.",
    "Налягането е 12.5 bar (около 181 psi), а цената е 1,299.00 лв.",
    "Виж https://example.com/safety/checklist?id=42&ref=a.b за подробности.",
    "Проверявайте прибл. веднъж месечно.",
  ].join(" ");

  it("changes no digit anywhere", () => {
    const { translatedContent } = roundTrip(null, TRICKY, 60);
    const digitsIn = TRICKY.match(/\d/g)?.join("") ?? "";
    const digitsOut = (translatedContent ?? "").match(/\d/g)?.join("") ?? "";
    assert.equal(digitsOut, digitsIn);
  });

  it("never splits a decimal, a price or a unit apart", () => {
    const { segments } = segmentArticle(null, TRICKY, {
      maxSegmentChars: 60,
      maxContentChars: 100_000,
    });
    const joined = segments.join(" ");
    for (const token of ["12.5 bar", "1,299.00", "5 и 15"]) {
      assert.ok(joined.includes(token), `"${token}" was broken up`);
    }
  });

  it("keeps a URL in one piece", () => {
    const { segments } = segmentArticle(null, TRICKY, {
      maxSegmentChars: 40,
      maxContentChars: 100_000,
    });
    assert.ok(
      segments.some((s) => s.includes("https://example.com/safety/checklist?id=42&ref=a.b")),
      "a URL split across two segments is a URL the model will not reassemble"
    );
  });

  it("does not split on an abbreviation's full stop", () => {
    const { segments } = segmentArticle(
      null,
      "Проверявайте прибл. веднъж месечно според указанията. След това затворете капака.",
      { maxContentChars: 100_000 }
    );
    assert.equal(segments.length, 2, "an abbreviation is not a sentence end");
    assert.ok(segments[0].includes("прибл. веднъж"));
  });

  it("does not split on an initial", () => {
    const { segments } = segmentArticle(
      null,
      "Дизайнът е на J. Wilson и оттогава не се е променил. Оттогава мина време.",
      { maxContentChars: 100_000 }
    );
    assert.equal(segments.length, 2);
    assert.ok(segments[0].includes("J. Wilson"));
  });

  it("duplicates no punctuation", () => {
    const source = "Готово. Край! Наистина?";
    const { translatedContent } = roundTrip(null, source, 12);
    assert.equal(translatedContent, source);
  });

  it("keeps blank lines between paragraphs and single newlines inside them", () => {
    const source = "Заглавие\nПодзаглавие\n\nПараграф едно.\n\nПараграф две.";
    const { translatedContent } = roundTrip(null, source);
    assert.equal(translatedContent, source);
  });

  it("inserts no space where a blind mid-token cut was made", () => {
    // A single token longer than the whole budget: the cut cannot fall on whitespace,
    // so the recorded separator must be empty or the halves rejoin with a space in them.
    const token = "a".repeat(120);
    const { plan, translatedContent } = roundTrip(null, token, 40);
    assert.ok(plan.body.length > 1);
    assert.equal(translatedContent, token);
  });
});

describe("round trip — the known-problem articles", () => {
  for (const fixture of TRANSLATION_FIXTURES) {
    it(`restores "${fixture.name}" exactly (${fixture.traps})`, () => {
      const expected = sanitised(fixture.content);
      const { translatedTitle, translatedContent } = roundTrip(fixture.title, fixture.content);
      assert.equal(translatedTitle, fixture.title);
      assert.equal(translatedContent, expected);
    });

    it(`restores "${fixture.name}" even when every sentence must be chunked`, () => {
      const expected = sanitised(fixture.content);
      const { translatedContent } = roundTrip(fixture.title, fixture.content, 40);
      assert.equal(translatedContent, expected);
    });
  }
});

describe("reassembleArticle", () => {
  it("re-emits the recorded separators verbatim", () => {
    const plan: SegmentPlan = {
      titleIndex: null,
      body: [
        { separator: "", prefix: "", index: 0 },
        { separator: " ", prefix: "", index: 1 },
        { separator: "\n", prefix: "- ", index: 2 },
        { separator: "\n\n", prefix: "", index: 3 },
      ],
    };
    const out = reassembleArticle(plan, ["Едно.", "Две.", "Точка", "Нов параграф."]);
    assert.equal(out.translatedContent, "Едно. Две.\n- Точка\n\nНов параграф.");
  });

  it("returns a null body rather than an empty string when there is none", () => {
    const result = reassembleArticle({ titleIndex: 0, body: [] }, ["Заглавие"]);
    assert.equal(result.translatedTitle, "Заглавие");
    assert.equal(result.translatedContent, null);
  });

  it("returns a null title rather than an empty string when the engine returned nothing", () => {
    const result = reassembleArticle(
      { titleIndex: 0, body: [{ separator: "", prefix: "", index: 1 }] },
      ["   ", "тяло"]
    );
    assert.equal(result.translatedTitle, null);
    assert.equal(result.translatedContent, "тяло");
  });

  it("emits no orphan marker when a line's text came back empty", () => {
    const result = reassembleArticle(
      {
        titleIndex: null,
        body: [
          { separator: "", prefix: "- ", index: 0 },
          { separator: "\n", prefix: "- ", index: 1 },
        ],
      },
      ["", "Втора точка"]
    );
    assert.equal(result.translatedContent, "- Втора точка");
  });

  it("keeps the stronger separator when a piece is dropped", () => {
    // The dropped piece opened a paragraph; the survivor must still open one.
    const result = reassembleArticle(
      {
        titleIndex: null,
        body: [
          { separator: "", prefix: "", index: 0 },
          { separator: "\n\n", prefix: "", index: 1 },
          { separator: " ", prefix: "", index: 2 },
        ],
      },
      ["Едно.", "", "Три."]
    );
    assert.equal(result.translatedContent, "Едно.\n\nТри.");
  });

  it("survives a round trip through an identity translation", () => {
    const source = `${PARA_A}\n\n${PARA_B}`;
    const { translatedTitle, translatedContent } = roundTrip("Title", source);
    assert.equal(translatedTitle, "Title");
    assert.equal(translatedContent, source);
  });
});
