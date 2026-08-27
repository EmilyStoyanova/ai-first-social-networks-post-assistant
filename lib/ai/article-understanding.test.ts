import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ARTICLE_TYPES,
  ArticleUnderstandingParseError,
  buildArticleUnderstandingDirectPrompt,
  buildArticleUnderstandingRepairPrompt,
  buildArticleUnderstandingSynthesisPrompt,
  buildArticleUnderstandingSystemPrompt,
  computeConfidenceSignals,
  confidenceCeiling,
  parseArticleUnderstandingResponse,
  reduceForSynthesis,
  SAFE_SYNTHESIS_POINT_COUNT,
  topicPhraseAgreement,
  type EvidencePoint,
} from "./article-understanding";
import type { ChunkAnalysis } from "./classification-chunk-analysis";

function chunk(overrides: Partial<ChunkAnalysis> = {}): ChunkAnalysis {
  return {
    mainPoint: "A point.",
    topics: [],
    entities: [],
    importantFacts: [],
    centrality: "supporting",
    ...overrides,
  };
}

function okReply(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    mainSubject: "Residents are protesting a new coastal tourism development.",
    centralThesis: "Development threatens a protected coastal area.",
    centralConflict: "Residents versus developers over the protected coast.",
    articleType: "news",
    secondaryTopics: ["tourism development", "coastal protection"],
    incidentalTopics: ["local hotels"],
    entities: ["Albania"],
    confidence: 0.8,
    evidence: [{ chunkIndex: 0, reason: "Describes the protest directly." }],
    ...overrides,
  });
}

// ─── parseArticleUnderstandingResponse ─────────────────────────────────────

describe("parseArticleUnderstandingResponse", () => {
  it("accepts a well-formed reply", () => {
    const out = parseArticleUnderstandingResponse(okReply(), 3);
    assert.equal(out.status, "ok");
    if (out.status === "ok") {
      assert.equal(out.mainSubject, "Residents are protesting a new coastal tourism development.");
      assert.equal(out.articleType, "news");
      assert.equal(out.confidence, 0.8);
      assert.deepEqual(out.evidence, [
        { chunkIndex: 0, reason: "Describes the protest directly." },
      ]);
    }
  });

  it("throws on a genuinely empty response", () => {
    assert.throws(() => parseArticleUnderstandingResponse("", 1), ArticleUnderstandingParseError);
    assert.throws(() => parseArticleUnderstandingResponse(null, 1), ArticleUnderstandingParseError);
  });

  it("rejects prose instead of JSON", () => {
    const out = parseArticleUnderstandingResponse("This article is about a protest.", 1);
    assert.equal(out.status, "invalid");
    if (out.status === "invalid") assert.match(out.feedback, /JSON/);
  });

  // ─── JSON wrapper recovery ────────────────────────────────────────────────

  it("accepts pure valid JSON with no wrapper", () => {
    const out = parseArticleUnderstandingResponse(okReply(), 1);
    assert.equal(out.status, "ok");
  });

  it("accepts one valid JSON object wrapped in a fenced ```json block", () => {
    const out = parseArticleUnderstandingResponse("```json\n" + okReply() + "\n```", 1);
    assert.equal(out.status, "ok");
  });

  it("accepts one valid JSON object preceded by harmless prose", () => {
    const out = parseArticleUnderstandingResponse("Here is the result:\n" + okReply(), 1);
    assert.equal(out.status, "ok");
  });

  it("rejects malformed JSON rather than repairing it silently", () => {
    // Structurally balanced braces (findJsonObject extracts it), but a trailing
    // comma makes it invalid JSON — the JSON.parse failure path, not the "no
    // object found at all" path exercised by the prose test above.
    const malformed = '{"mainSubject": "x",}';
    const out = parseArticleUnderstandingResponse(malformed, 1);
    assert.equal(out.status, "invalid");
    if (out.status === "invalid") assert.match(out.problem, /could not be parsed/);
  });

  it("rejects a reply that contains more than one competing JSON object", () => {
    const out = parseArticleUnderstandingResponse(okReply() + "\n" + okReply(), 1);
    assert.equal(out.status, "invalid");
    if (out.status === "invalid") assert.match(out.problem, /more than one/);
  });

  it("rejects two competing JSON objects even when only the first is schema-valid", () => {
    const out = parseArticleUnderstandingResponse(
      okReply() + "\n" + JSON.stringify({ note: "an unrelated second object" }),
      1
    );
    assert.equal(out.status, "invalid");
    if (out.status === "invalid") assert.match(out.problem, /more than one/);
  });

  it("still rejects valid JSON that fails ArticleUnderstanding's own schema", () => {
    const out = parseArticleUnderstandingResponse(JSON.stringify({ not: "the right shape" }), 1);
    assert.equal(out.status, "invalid");
  });

  it("never invents a missing semantic field while recovering a wrapped reply", () => {
    const out = parseArticleUnderstandingResponse(
      "Here you go:\n" + okReply({ centralThesis: null }),
      1
    );
    assert.equal(out.status, "ok");
    if (out.status === "ok") assert.equal(out.centralThesis, null);
  });

  it("rejects a missing mainSubject", () => {
    const out = parseArticleUnderstandingResponse(okReply({ mainSubject: undefined }), 3);
    assert.equal(out.status, "invalid");
  });

  it("rejects a bag-of-keywords mainSubject (too few words)", () => {
    const out = parseArticleUnderstandingResponse(okReply({ mainSubject: "Coastal tourism" }), 3);
    assert.equal(out.status, "invalid");
    if (out.status === "invalid") assert.match(out.problem, /keywords/);
  });

  it("rejects a bag-of-keywords mainSubject (comma list with no connecting word)", () => {
    const out = parseArticleUnderstandingResponse(
      okReply({ mainSubject: "tourism, beaches, hotels, scenery, Albania" }),
      3
    );
    assert.equal(out.status, "invalid");
    if (out.status === "invalid") assert.match(out.problem, /keywords/);
  });

  it("accepts a genuine sentence containing commas", () => {
    const out = parseArticleUnderstandingResponse(
      okReply({
        mainSubject:
          "Although the piece opens with beaches and hotels, it is really about residents fighting a tourism development.",
      }),
      3
    );
    assert.equal(out.status, "ok");
  });

  /**
   * The production defect: the keyword check's connector list was English-only,
   * so a grammatically perfect Bulgarian sentence with three or more
   * comma-separated clauses could not possibly contain one and was always
   * refused. Every article this system classifies for a Bulgarian company
   * produces exactly this shape of mainSubject.
   */
  it("accepts a real multi-clause Bulgarian sentence — the English-only connector bug", () => {
    const out = parseArticleUnderstandingResponse(
      okReply({
        mainSubject:
          "Теракотовите цветове са представени като модерни, земни и гостоприемни опции за интериорно боядисване, с акцент върху топлината, дълбочината и уютното усещане, които те създават в различни стаи.",
      }),
      3
    );
    assert.equal(out.status, "ok");
  });

  it("accepts a Bulgarian sentence whose clauses are short but connected", () => {
    const out = parseArticleUnderstandingResponse(
      okReply({ mainSubject: "Статията обяснява как се избира боя, кога се грундира, и защо." }),
      3
    );
    assert.equal(out.status, "ok");
  });

  it("still rejects a real keyword dump", () => {
    const out = parseArticleUnderstandingResponse(
      okReply({ mainSubject: "paint, brushes, rollers, primer, walls, colors" }),
      3
    );
    assert.equal(out.status, "invalid");
    if (out.status === "invalid") assert.match(out.problem, /keywords/);
  });

  it("still rejects a keyword dump written in Bulgarian", () => {
    const out = parseArticleUnderstandingResponse(
      okReply({ mainSubject: "бои, четки, валяци, грундове, стени, цветове" }),
      3
    );
    assert.equal(out.status, "invalid");
    if (out.status === "invalid") assert.match(out.problem, /keywords/);
  });

  it("still rejects a bag of short noun phrases, not just single words", () => {
    const out = parseArticleUnderstandingResponse(
      okReply({ mainSubject: "interior paint colours, bathroom tile options, kitchen finishes" }),
      3
    );
    assert.equal(out.status, "invalid");
  });

  it("rejects an unknown articleType", () => {
    const out = parseArticleUnderstandingResponse(okReply({ articleType: "listicle" }), 3);
    assert.equal(out.status, "invalid");
  });

  it("accepts every documented articleType", () => {
    for (const type of ARTICLE_TYPES) {
      const out = parseArticleUnderstandingResponse(okReply({ articleType: type }), 3);
      assert.equal(out.status, "ok", `expected ${type} to be accepted`);
    }
  });

  it("rejects a non-numeric confidence", () => {
    const out = parseArticleUnderstandingResponse(okReply({ confidence: "high" }), 3);
    assert.equal(out.status, "invalid");
  });

  it("clamps an out-of-range confidence rather than rejecting it", () => {
    const out = parseArticleUnderstandingResponse(okReply({ confidence: 1.4 }), 3);
    assert.equal(out.status, "ok");
    if (out.status === "ok") assert.equal(out.confidence, 1);
  });

  it("allows centralThesis and centralConflict to be null", () => {
    const out = parseArticleUnderstandingResponse(
      okReply({ centralThesis: null, centralConflict: null }),
      3
    );
    assert.equal(out.status, "ok");
    if (out.status === "ok") {
      assert.equal(out.centralThesis, null);
      assert.equal(out.centralConflict, null);
    }
  });

  it("rejects a reply with no evidence", () => {
    const out = parseArticleUnderstandingResponse(okReply({ evidence: [] }), 3);
    assert.equal(out.status, "invalid");
  });

  it("rejects evidence citing a chunkIndex outside the article's real range", () => {
    const out = parseArticleUnderstandingResponse(
      okReply({ evidence: [{ chunkIndex: 5, reason: "made up" }] }),
      3
    );
    assert.equal(out.status, "invalid");
    if (out.status === "invalid") assert.match(out.problem, /outside/);
  });

  it("rejects evidence with a non-integer chunkIndex", () => {
    const out = parseArticleUnderstandingResponse(
      okReply({ evidence: [{ chunkIndex: 1.5, reason: "x" }] }),
      3
    );
    assert.equal(out.status, "invalid");
  });

  it("rejects an evidence entry with no reason", () => {
    const out = parseArticleUnderstandingResponse(
      okReply({ evidence: [{ chunkIndex: 0, reason: "" }] }),
      3
    );
    assert.equal(out.status, "invalid");
  });
});

// ─── Recursive reduction ────────────────────────────────────────────────────

describe("reduceForSynthesis", () => {
  it("passes chunks through unchanged when already under the safe count", () => {
    const analyses = [chunk({ mainPoint: "A" }), chunk({ mainPoint: "B" })];
    const points = reduceForSynthesis(analyses);
    assert.equal(points.length, 2);
    assert.deepEqual(
      points.map((p) => p.chunkIndices),
      [[0], [1]]
    );
  });

  it("never silently drops a chunk — every original index survives reduction for a very long article", () => {
    const analyses = Array.from({ length: 97 }, (_, i) =>
      chunk({ mainPoint: `Point ${i}`, centrality: i % 13 === 0 ? "central" : "supporting" })
    );
    const points = reduceForSynthesis(analyses);

    assert.ok(
      points.length <= SAFE_SYNTHESIS_POINT_COUNT,
      `reduction should fit under the safe count, got ${points.length}`
    );
    const seen = new Set(points.flatMap((p) => p.chunkIndices));
    assert.equal(seen.size, 97, "every original chunk index must still be traceable");
    for (let i = 0; i < 97; i++) assert.ok(seen.has(i), `missing chunk index ${i}`);
  });

  it("never demotes a group containing a central chunk to supporting", () => {
    const analyses = Array.from({ length: 40 }, (_, i) =>
      chunk({ mainPoint: `Point ${i}`, centrality: i === 39 ? "central" : "supporting" })
    );
    const points = reduceForSynthesis(analyses);
    const group = points.find((p) => p.chunkIndices.includes(39));
    assert.ok(group, "the group containing the last (central) chunk must exist");
    assert.equal(group!.centrality, "central");
  });

  it("terminates and keeps a real topic that appears only in the last chunk reachable", () => {
    // The real-topic-appears-late shape: 60 supporting chunks about one thing,
    // then one central chunk with the article's real subject, right at the end.
    const analyses = [
      ...Array.from({ length: 60 }, (_, i) =>
        chunk({ mainPoint: `Scenic description ${i}`, topics: ["scenery"] })
      ),
      chunk({
        mainPoint: "Residents announce a lawsuit against the resort developer.",
        topics: ["lawsuit", "development"],
        centrality: "central",
      }),
    ];
    const points = reduceForSynthesis(analyses);
    const centralPoints = points.filter((p) => p.centrality === "central");
    assert.equal(centralPoints.length, 1);
    assert.ok(centralPoints[0].chunkIndices.includes(60));
  });
});

// ─── Confidence ─────────────────────────────────────────────────────────────

describe("computeConfidenceSignals / confidenceCeiling", () => {
  it("gives a low ceiling when no chunk is central", () => {
    const analyses = Array.from({ length: 6 }, () => chunk({ centrality: "supporting" }));
    const ceiling = confidenceCeiling(computeConfidenceSignals(analyses));
    assert.ok(ceiling <= 0.3, `expected a low ceiling, got ${ceiling}`);
  });

  it("gives a high ceiling for many central chunks that agree on topic", () => {
    const analyses = Array.from({ length: 6 }, () =>
      chunk({ centrality: "central", topics: ["coastal protest", "tourism development"] })
    );
    const ceiling = confidenceCeiling(computeConfidenceSignals(analyses));
    assert.ok(ceiling >= 0.8, `expected a high ceiling, got ${ceiling}`);
  });

  it("gives a low ceiling for central chunks pointing at unrelated subjects", () => {
    const analyses = [
      chunk({ centrality: "central", topics: ["coastal protest"] }),
      chunk({ centrality: "central", topics: ["local football results"] }),
      chunk({ centrality: "central", topics: ["a museum renovation"] }),
      chunk({ centrality: "supporting", topics: ["scenery"] }),
    ];
    const ceiling = confidenceCeiling(computeConfidenceSignals(analyses));
    assert.ok(ceiling <= 0.5, `expected a suppressed ceiling for disagreement, got ${ceiling}`);
  });

  it("gives a moderate, not full, ceiling for a single uncorroborated central chunk", () => {
    const analyses = [
      chunk({ centrality: "central", topics: ["coastal protest"] }),
      ...Array.from({ length: 9 }, () => chunk({ centrality: "supporting" })),
    ];
    const ceiling = confidenceCeiling(computeConfidenceSignals(analyses));
    assert.ok(ceiling > 0.3 && ceiling < 0.85, `expected a moderate ceiling, got ${ceiling}`);
  });

  it("does not let repeated incidental (supporting) mentions raise the ceiling", () => {
    const withoutRepeats = confidenceCeiling(
      computeConfidenceSignals([
        chunk({ centrality: "central", topics: ["protest"] }),
        chunk({ centrality: "central", topics: ["protest"] }),
      ])
    );
    const withManyRepeatedIncidentals = confidenceCeiling(
      computeConfidenceSignals([
        chunk({ centrality: "central", topics: ["protest"] }),
        chunk({ centrality: "central", topics: ["protest"] }),
        ...Array.from({ length: 20 }, () =>
          chunk({ centrality: "supporting", topics: ["hotels"] })
        ),
      ])
    );
    assert.ok(
      withManyRepeatedIncidentals <= withoutRepeats,
      "piling on supporting chunks about an incidental topic must not raise the ceiling"
    );
  });
});

/**
 * The production defect: `topicCoherence` compared whole freeform topic strings
 * for EXACT equality, so two sections of one paint article that wrote "wall and
 * trim colors" and "color combinations" scored 0 agreement — and 0 coherence is
 * the largest term in `confidenceCeiling`, which pinned every such article at a
 * 0.4 ceiling. These test the STRUCTURE of the replacement (differently-worded
 * related phrases agree, generic vocabulary alone does not, unrelated phrases
 * still score ~0), not the numbers of any one article.
 */
describe("topicPhraseAgreement", () => {
  it("scores differently-worded phrases about the same subject as related", () => {
    const wallTrim = ["wall and trim colors"];
    const combinations = ["color combinations"];
    const selection = ["paint color selection"];

    for (const [a, b] of [
      [wallTrim, combinations],
      [wallTrim, selection],
      [combinations, selection],
    ]) {
      const score = topicPhraseAgreement(a, b);
      assert.ok(score > 0, `expected ${JSON.stringify(a)} ~ ${JSON.stringify(b)} to agree`);
    }
  });

  it("does the same for Bulgarian, where the inflection differs rather than the stem", () => {
    const walls = ["цветове за стени"];
    const combinations = ["комбинации от цветове"];
    const choice = ["избор на цветове"];

    for (const [a, b] of [
      [walls, combinations],
      [walls, choice],
      [combinations, choice],
    ]) {
      assert.ok(
        topicPhraseAgreement(a, b) > 0,
        `expected ${JSON.stringify(a)} ~ ${JSON.stringify(b)} to agree`
      );
    }
  });

  it("matches an inflected form to its stem in either language", () => {
    assert.ok(topicPhraseAgreement(["paint colours"], ["colour"]) > 0);
    assert.ok(topicPhraseAgreement(["painting walls"], ["wall"]) > 0);
    // Bulgarian suffixing, and Bulgarian substitution — the ending changes
    // without the word getting longer, which a prefix-containment rule misses.
    assert.ok(topicPhraseAgreement(["цветове"], ["цветовете"]) > 0);
    assert.ok(topicPhraseAgreement(["цветове"], ["цветови"]) > 0);
    assert.ok(topicPhraseAgreement(["стени"], ["стена"]) > 0);
  });

  it("does not join two different words that merely start alike", () => {
    // The classic truncation-stemmer failure: both become "inter" under a fixed
    // prefix cut, but neither is a prefix of the other.
    assert.equal(topicPhraseAgreement(["interior"], ["internal"]), 0);
    assert.equal(topicPhraseAgreement(["colour"], ["colourblindness"]), 0);
  });

  /**
   * KNOWN LIMITATION, deliberately left unfixed — see the module comment above
   * `tokensMatch`. "pain" is a full 4-character prefix of "paint", and 4 is
   * both `MIN_STEM_MATCH_CHARS` and (for a 4-letter shorter side) the required
   * prefix length, so the two unrelated words are indistinguishable from a real
   * inflection pair by this rule. This is a genuine false positive, not a
   * tolerated edge case — pinned here as a CURRENT-BEHAVIOR regression, not an
   * endorsement, so a change to `tokensMatch`'s thresholds is a visible,
   * deliberate decision rather than a silent tuning drift. Do not "fix" this
   * assertion by loosening it further; if the threshold changes, this test
   * should be revisited alongside the module comment and the classifier's own
   * regression suite, not adjusted in isolation.
   */
  it("[KNOWN LIMITATION] a bare near-homograph can still score as a full match", () => {
    assert.equal(
      topicPhraseAgreement(["paint"], ["pain"]),
      1,
      "if this changes, the near-homograph risk noted in tokensMatch's comment may have been addressed — update the comment, don't just retune this number"
    );
    // Diluted, but not eliminated, once the phrase carries a second word — real
    // topic phrases are rarely a single bare token, which is what keeps this
    // from being worse in practice than the isolated case above.
    const diluted = topicPhraseAgreement(["paint colors"], ["pain relief"]);
    assert.ok(
      diluted > 0 && diluted < 1,
      `expected a partial, non-zero false match, got ${diluted}`
    );
  });

  it("does not let shared generic vocabulary alone create strong agreement", () => {
    const generic = topicPhraseAgreement(["interior lighting"], ["interior furniture"]);
    const real = topicPhraseAgreement(["wall and trim colors"], ["color combinations"]);
    assert.ok(generic < 0.2, `generic-only overlap should stay weak, got ${generic}`);
    assert.ok(
      generic < real,
      `a shared generic word (${generic}) must score below a shared subject (${real})`
    );
  });

  it("keeps unrelated subjects at zero", () => {
    assert.equal(topicPhraseAgreement(["paint colors"], ["garden irrigation"]), 0);
    assert.equal(topicPhraseAgreement(["бои за стени"], ["градинско напояване"]), 0);
  });

  it("ignores stop words in both languages rather than counting them as agreement", () => {
    // "and"/"for" and "за"/"на" are the only tokens these pairs share.
    assert.equal(topicPhraseAgreement(["paint and primer"], ["hiking and camping"]), 0);
    assert.equal(topicPhraseAgreement(["бои за стени"], ["обувки за бягане"]), 0);
  });

  it("is symmetric and self-identical", () => {
    const a = ["wall and trim colors", "interior design"];
    const b = ["color combinations", "paint finishes"];
    assert.equal(topicPhraseAgreement(a, b), topicPhraseAgreement(b, a));
    assert.equal(topicPhraseAgreement(a, a), 1);
  });

  it("does not count one phrase's repeated word-forms as several agreements", () => {
    const many = ["colour", "colours", "coloured", "colouring"];
    const once = ["colour"];
    const score = topicPhraseAgreement(many, once);
    assert.ok(score > 0, "the shared word should still agree once");
    assert.ok(score < 1, `four word-forms must not claim perfect agreement, got ${score}`);
  });

  it("returns 0 when either side has no scoreable token", () => {
    assert.equal(topicPhraseAgreement([], ["paint colors"]), 0);
    assert.equal(topicPhraseAgreement(["and the"], ["paint colors"]), 0);
  });
});

describe("confidenceCeiling — multi-chunk articles worded differently per chunk", () => {
  /**
   * The regression shape itself: several central chunks that agree on the
   * subject but each describe it in their own words. Before the token-level
   * comparison this scored `topicCoherence: 0` and a 0.4 ceiling — the floor of
   * the formula — which is indistinguishable from an article whose sections
   * genuinely point at different subjects.
   */
  const wordedDifferently: ChunkAnalysis[] = [
    chunk({
      centrality: "central",
      topics: ["wall and trim color combinations", "interior design", "color selection"],
    }),
    chunk({
      centrality: "central",
      topics: ["color combinations", "interior atmosphere", "home design"],
    }),
    chunk({
      centrality: "central",
      topics: ["choosing paint colours", "colour pairings"],
    }),
  ];

  const wordedDifferentlyBg: ChunkAnalysis[] = [
    chunk({
      centrality: "central",
      topics: ["цветове за стени", "интериорен дизайн"],
    }),
    chunk({
      centrality: "central",
      topics: ["комбинации от цветове", "избор на цветове"],
    }),
    chunk({
      centrality: "central",
      topics: ["боядисване на стени", "цветови съчетания"],
    }),
  ];

  for (const [label, analyses] of [
    ["English", wordedDifferently],
    ["Bulgarian", wordedDifferentlyBg],
  ] as const) {
    it(`(${label}) agreeing chunks are no longer pinned at the formula's floor`, () => {
      const signals = computeConfidenceSignals(analyses);
      assert.ok(
        signals.topicCoherence > 0,
        `expected non-zero coherence, got ${signals.topicCoherence}`
      );
      // 0.4 is what `0.2 + 0.6 * 0 + 0.2 * 1` produces — the ceiling every such
      // article used to receive purely because the wording differed.
      const ceiling = confidenceCeiling(signals);
      assert.ok(ceiling > 0.4, `expected a ceiling above the 0.4 floor, got ${ceiling}`);
    });
  }

  it("still suppresses chunks that genuinely point at different subjects", () => {
    // Same shape, same chunk count, same centrality — only the subjects differ.
    const disagreeing: ChunkAnalysis[] = [
      chunk({ centrality: "central", topics: ["wall and trim color combinations"] }),
      chunk({ centrality: "central", topics: ["garden irrigation schedules"] }),
      chunk({ centrality: "central", topics: ["mortgage interest rates"] }),
    ];
    const agreeing = confidenceCeiling(computeConfidenceSignals(wordedDifferently));
    const scattered = confidenceCeiling(computeConfidenceSignals(disagreeing));
    assert.ok(
      scattered < agreeing,
      `disagreement (${scattered}) must still score below agreement (${agreeing})`
    );
    assert.ok(scattered <= 0.5, `expected a suppressed ceiling, got ${scattered}`);
  });

  it("does not let a shared vertical vocabulary pass as agreement", () => {
    // Every chunk says "interior" and "design" and nothing else in common.
    const genericOnly: ChunkAnalysis[] = [
      chunk({ centrality: "central", topics: ["interior lighting", "design"] }),
      chunk({ centrality: "central", topics: ["interior furniture", "design"] }),
      chunk({ centrality: "central", topics: ["interior flooring", "design"] }),
    ];
    const ceiling = confidenceCeiling(computeConfidenceSignals(genericOnly));
    const agreeing = confidenceCeiling(computeConfidenceSignals(wordedDifferently));
    assert.ok(
      ceiling < agreeing,
      `shared genericisms (${ceiling}) must score below a shared subject (${agreeing})`
    );
  });
});

// ─── Prompts ────────────────────────────────────────────────────────────────

describe("buildArticleUnderstandingSystemPrompt", () => {
  it("tells the direct-mode model to cite chunk 0", () => {
    const prompt = buildArticleUnderstandingSystemPrompt("direct");
    assert.match(prompt, /chunkIndex 0/);
  });

  it("tells the synthesis-mode model to cite only sections it was shown", () => {
    const prompt = buildArticleUnderstandingSystemPrompt("synthesis");
    assert.match(prompt, /section numbers actually shown/);
  });

  /**
   * The signal-preservation half of the cross-lingual fix. A mainSubject that
   * abstracts "choosing a wall colour" up into "how daylight affects colour
   * perception" is not wrong, but it has thrown away the one concrete noun the
   * verdict call needs to match a configured topic against — and that call never
   * re-reads the article, so nothing downstream can recover it.
   */
  for (const mode of ["direct", "synthesis"] as const) {
    it(`tells the ${mode}-mode model to keep the concrete product or practice`, () => {
      const prompt = buildArticleUnderstandingSystemPrompt(mode);
      assert.match(prompt, /Keep the concrete subject CONCRETE/);
      assert.match(prompt, /choosing, buying, using, installing, repairing or caring for/);
      // And, when it genuinely does not belong in mainSubject, that it must
      // survive somewhere rather than vanish.
      assert.match(prompt, /secondaryTopics" or "entities"/);
    });
  }
});

describe("buildArticleUnderstandingDirectPrompt", () => {
  it("renders the whole body as section 0", () => {
    const prompt = buildArticleUnderstandingDirectPrompt({
      title: "A title",
      body: "The article body text.",
    });
    assert.match(prompt, /Section 0:/);
    assert.match(prompt, /The article body text\./);
  });
});

describe("buildArticleUnderstandingSynthesisPrompt", () => {
  const misleadingOpening: EvidencePoint[] = [
    {
      text: "Beaches draw thousands of tourists every summer.",
      chunkIndices: [0],
      centrality: "supporting",
    },
    {
      text: "Hotels along the coast report record bookings.",
      chunkIndices: [1],
      centrality: "supporting",
    },
    {
      text: "Residents filed a lawsuit to block a new coastal resort.",
      chunkIndices: [2],
      centrality: "central",
    },
  ];

  it("renders central points under CENTRAL and keeps supporting points under CONTEXT — a misleading opening does not dominate", () => {
    const prompt = buildArticleUnderstandingSynthesisPrompt({
      title: "Coastal region",
      totalChunkCount: 3,
      points: misleadingOpening,
      topics: [],
      entities: [],
      importantFacts: [],
    });

    const centralSection = prompt.split("CONTEXT —")[0];
    assert.match(centralSection, /lawsuit to block a new coastal resort/);
    assert.doesNotMatch(centralSection, /Beaches draw thousands/);

    const contextSection = prompt.slice(prompt.indexOf("CONTEXT —"));
    assert.match(contextSection, /Beaches draw thousands/);
    assert.match(contextSection, /record bookings/);
  });

  it("cites the reduced points' real chunk indices, even after merging", () => {
    const merged: EvidencePoint = {
      text: "Scenic description of the coastline.",
      chunkIndices: [4, 5, 6, 7],
      centrality: "supporting",
    };
    const prompt = buildArticleUnderstandingSynthesisPrompt({
      title: null,
      totalChunkCount: 8,
      points: [merged],
      topics: [],
      entities: [],
      importantFacts: [],
    });
    assert.match(prompt, /\[section 4,5,6,7\]/);
  });

  it("warns that CENTRAL should not be read alone, and that order/frequency is not significance", () => {
    const prompt = buildArticleUnderstandingSynthesisPrompt({
      title: null,
      totalChunkCount: 1,
      points: [{ text: "x", chunkIndices: [0], centrality: "central" }],
      topics: [],
      entities: [],
      importantFacts: [],
    });
    assert.match(prompt, /never from CENTRAL alone/);
    assert.match(prompt, /never by which point is listed first or mentioned most/);
  });
});

describe("buildArticleUnderstandingRepairPrompt", () => {
  it("carries the original prompt, the bad reply, and the feedback forward", () => {
    const repaired = buildArticleUnderstandingRepairPrompt(
      "original",
      "bad reply text",
      "fix this"
    );
    assert.match(repaired, /original/);
    assert.match(repaired, /bad reply text/);
    assert.match(repaired, /fix this/);
  });
});
