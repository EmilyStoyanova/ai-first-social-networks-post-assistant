import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkOpeningDiversity,
  extractOpeningSignature,
  OPENING_PREFIX_TOKENS,
  QUESTION_FORM_LIMIT,
  RHETORICAL_FAMILY_LIMIT,
} from "./opening-diversity";

const post = (id: string, text: string) => ({ id, text });

// ─── Signature extraction ────────────────────────────────────────────────────

describe("extractOpeningSignature", () => {
  it("takes only the first sentence, not the whole post", () => {
    const sig = extractOpeningSignature(
      "Смесителят е сърцето на банята. Всичко останало се подрежда около него. Ето защо изборът има значение."
    );
    assert.ok(sig.normalized.startsWith("смесителят е сърцето"));
    assert.ok(!sig.normalized.includes("всичко останало"));
  });

  it("strips URLs, emoji and punctuation before comparing", () => {
    const sig = extractOpeningSignature("🚿 Смесителят, е сърцето! https://example.com/x");
    assert.deepEqual(sig.tokens.slice(0, 3), ["смесителят", "е", "сърцето"]);
  });

  it("collapses whitespace and lowercases", () => {
    const sig = extractOpeningSignature("  ПРИ   РЕМОНТ\t на банята...");
    assert.ok(sig.normalized.startsWith("при ремонт на банята"));
  });

  it("treats a line break as an opening boundary — a Facebook hook is its own line", () => {
    const sig = extractOpeningSignature("Смесителят е сърцето на банята\n\nЕто защо изборът тежи.");
    assert.ok(!sig.normalized.includes("ето защо"));
  });

  it("classifies the malformed rhetorical opener as the rhetorical family", () => {
    const sig = extractOpeningSignature(
      "Има ли ти мислил, че един смесител може да промени всичко?"
    );
    assert.strictEqual(sig.form, "rhetorical_question");
  });

  it("classifies correct Bulgarian reflection openers as the same family", () => {
    for (const text of [
      "Мислил ли си някога дали смесителят ти пести вода?",
      "Замислял ли си се дали правилният смесител променя банята?",
      "Знаеш ли, че един смесител може да намали разхода с една трета?",
      "Чувал ли си за керамичните картуши?",
    ]) {
      assert.strictEqual(extractOpeningSignature(text).form, "rhetorical_question", text);
    }
  });

  it("classifies an ordinary question as a question, not the rhetorical family", () => {
    const sig = extractOpeningSignature("Кой смесител пасва на малка баня?");
    assert.strictEqual(sig.form, "question");
  });

  it("classifies a declarative opening as a statement", () => {
    const sig = extractOpeningSignature(
      "При ремонт на банята най-малките решения често имат най-голям ефект."
    );
    assert.strictEqual(sig.form, "statement");
  });

  it("recognises the English reflection family too", () => {
    assert.strictEqual(
      extractOpeningSignature("Have you ever wondered how much water a tap wastes?").form,
      "rhetorical_question"
    );
    assert.strictEqual(
      extractOpeningSignature("Did you know a cartridge lasts ten years?").form,
      "rhetorical_question"
    );
  });
});

// ─── Scenario 1 — exact/near-exact repeated opening ──────────────────────────

describe("checkOpeningDiversity — repeated openings", () => {
  it("flags an opening that repeats the same lead phrase as a recent post", () => {
    const result = checkOpeningDiversity({
      candidateText:
        "Има ли ти мислил, че изборът на ръчка може да промени цялата визуална структура на банята?",
      recentPosts: [
        post(
          "p1",
          "Има ли ти мислил, че един смесител може да промени цялата атмосфера на банята?"
        ),
      ],
    });

    assert.strictEqual(result.flagged, true);
    assert.strictEqual(result.matchType, "near_exact");
    assert.strictEqual(result.matchedPostId, "p1");
    assert.ok(result.matchedOpening && result.matchedOpening.length > 0);
  });

  it("reports the shared lead as a short signature, never the whole matched post", () => {
    const long = `Има ли ти мислил, че един смесител може да промени всичко? ${"допълнителен текст ".repeat(60)}`;
    const result = checkOpeningDiversity({
      candidateText: "Има ли ти мислил, че изборът на ръчка променя банята?",
      recentPosts: [post("p1", long)],
    });

    assert.strictEqual(result.flagged, true);
    assert.ok(result.matchedOpening!.length < 200);
    assert.ok(!result.matchedOpening!.includes("допълнителен текст допълнителен текст"));
  });

  // Scenario 2 — the same rhetorical DEVICE, different words.
  it("flags a paraphrased member of the same rhetorical-question family", () => {
    const result = checkOpeningDiversity({
      candidateText: "Мислил ли си някога дали смесителят в банята ти има значение?",
      recentPosts: [post("p1", "Замислял ли си се дали правилният смесител променя банята?")],
    });

    assert.strictEqual(result.flagged, true);
    assert.strictEqual(result.matchType, "repeated_form");
    assert.strictEqual(result.matchedPostId, "p1");
    assert.strictEqual(result.candidateForm, "rhetorical_question");
  });

  // Scenario 3 — same topic, genuinely different rhetorical form.
  it("allows the same topic when the opening form is genuinely different", () => {
    const result = checkOpeningDiversity({
      candidateText:
        "При ремонт на банята най-малките решения често имат най-голям ефект. Смесителят е точно такова решение.",
      recentPosts: [post("p1", "Замислял ли си се дали правилният смесител променя банята?")],
    });

    assert.strictEqual(result.flagged, false);
    assert.strictEqual(result.matchType, null);
  });

  it("allows a legitimate second post about the same product category", () => {
    const result = checkOpeningDiversity({
      candidateText: "Керамичният картуш издържа над десет години при ежедневна употреба.",
      recentPosts: [
        post("p1", "Смесителят с керамичен картуш капе много по-рядко от гумения."),
        post("p2", "Три неща издават евтин смесител още при първото завъртане."),
      ],
    });

    assert.strictEqual(result.flagged, false);
  });
});

// ─── Contextual, not a global ban ────────────────────────────────────────────

describe("checkOpeningDiversity — the rule is contextual, not a blanket ban", () => {
  it("allows a rhetorical question when recent history has none", () => {
    const result = checkOpeningDiversity({
      candidateText: "Мислил ли си някога колко вода тече напразно всеки ден?",
      recentPosts: [
        post("p1", "Смесителят е сърцето на банята."),
        post("p2", "Три грешки правят ремонта два пъти по-скъп."),
        post("p3", "Керамичният картуш издържа над десет години."),
      ],
    });

    assert.strictEqual(result.flagged, false);
    assert.strictEqual(result.candidateForm, "rhetorical_question");
  });

  it("allows an ordinary question when questions do not dominate recent history", () => {
    const result = checkOpeningDiversity({
      candidateText: "Кой смесител пасва на малка баня?",
      recentPosts: [
        post("p1", "Смесителят е сърцето на банята."),
        post("p2", "Три грешки правят ремонта два пъти по-скъп."),
      ],
    });

    assert.strictEqual(result.flagged, false);
  });

  it("flags an ordinary question once question openings saturate recent history", () => {
    const questions = Array.from({ length: QUESTION_FORM_LIMIT }, (_, i) =>
      post(`q${i}`, `Кой ${"смесител".repeat(1)} пасва на баня номер ${i}?`)
    );
    const result = checkOpeningDiversity({
      candidateText: "Коя ръчка пасва на модерна баня?",
      recentPosts: questions,
    });

    assert.strictEqual(result.flagged, true);
    assert.strictEqual(result.matchType, "saturated_form");
  });

  it("never flags a declarative opening on form grounds, however many questions precede it", () => {
    const questions = Array.from({ length: 9 }, (_, i) =>
      post(`q${i}`, `Мислил ли си някога за банята номер ${i}?`)
    );
    const result = checkOpeningDiversity({
      candidateText: "Керамичният картуш издържа над десет години при ежедневна употреба.",
      recentPosts: questions,
    });

    assert.strictEqual(result.flagged, false);
  });

  it("exposes its thresholds as the contract they are", () => {
    assert.strictEqual(RHETORICAL_FAMILY_LIMIT, 1);
    assert.ok(QUESTION_FORM_LIMIT > RHETORICAL_FAMILY_LIMIT);
    assert.ok(OPENING_PREFIX_TOKENS >= 3);
  });
});

// ─── History scope is the caller's, and only the caller's ────────────────────
// Scenarios 4 and 5. The check compares against exactly the posts it is handed
// and performs no lookup of its own, so a caller that scopes its history to one
// company + one channel (generate-draft-post.service.ts does) cannot leak.

describe("checkOpeningDiversity — history scope", () => {
  it("passes cleanly when there is no history at all", () => {
    const result = checkOpeningDiversity({
      candidateText: "Има ли ти мислил, че един смесител може да промени банята?",
      recentPosts: [],
    });

    assert.strictEqual(result.flagged, false);
    assert.strictEqual(result.similarity, null);
    assert.strictEqual(result.matchedPostId, null);
  });

  it("another company's identical opening cannot flag it — it is not in the given history", () => {
    // The identical text exists, but scoped out by the caller's query, so the
    // check never sees it. This is the whole of the cross-company guarantee.
    const anotherCompanysPost = post(
      "other-co",
      "Има ли ти мислил, че един смесител може да промени банята?"
    );

    const scopedToThisCompany = checkOpeningDiversity({
      candidateText: "Има ли ти мислил, че един смесител може да промени банята?",
      recentPosts: [],
    });
    assert.strictEqual(scopedToThisCompany.flagged, false);

    // Sanity: the same text WOULD flag if the caller wrongly included it.
    const unscoped = checkOpeningDiversity({
      candidateText: "Има ли ти мислил, че един смесител може да промени банята?",
      recentPosts: [anotherCompanysPost],
    });
    assert.strictEqual(unscoped.flagged, true);
  });

  it("an Instagram opening cannot block a Facebook candidate — channels are separate histories", () => {
    const instagramHistory = [
      post("ig1", "Има ли ти мислил, че един смесител може да промени банята?"),
    ];

    // The Facebook generation is handed its OWN channel's history, which is empty.
    const facebook = checkOpeningDiversity({
      candidateText: "Има ли ти мислил, че един смесител може да промени банята?",
      recentPosts: [],
    });
    assert.strictEqual(facebook.flagged, false);

    // And Instagram's own history still works for Instagram.
    const instagram = checkOpeningDiversity({
      candidateText: "Има ли ти мислил, че изборът на ръчка променя банята?",
      recentPosts: instagramHistory,
    });
    assert.strictEqual(instagram.flagged, true);
  });
});

// ─── False-positive protections ──────────────────────────────────────────────

describe("checkOpeningDiversity — false-positive protections", () => {
  it("does not flag two short openings that merely share stop words", () => {
    const result = checkOpeningDiversity({
      candidateText: "При избор на смесител важното е дебитът.",
      recentPosts: [post("p1", "При ремонт на банята бюджетът се изчерпва бързо.")],
    });

    assert.strictEqual(result.flagged, false);
  });

  it("ignores an empty or whitespace-only candidate rather than flagging it", () => {
    const result = checkOpeningDiversity({
      candidateText: "   \n  ",
      recentPosts: [post("p1", "Има ли ти мислил, че един смесител променя банята?")],
    });

    assert.strictEqual(result.flagged, false);
  });

  it("ignores recent posts with no usable opening", () => {
    const result = checkOpeningDiversity({
      candidateText: "Керамичният картуш издържа над десет години.",
      recentPosts: [post("p1", ""), post("p2", "   ")],
    });

    assert.strictEqual(result.flagged, false);
  });

  it("a URL-heavy opening does not collapse into a false match", () => {
    const result = checkOpeningDiversity({
      candidateText: "Виж новата серия тук: https://example.com/a",
      recentPosts: [post("p1", "Разгледай каталога тук: https://example.com/b")],
    });

    assert.strictEqual(result.flagged, false);
  });
});
