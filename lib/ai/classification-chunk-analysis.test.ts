import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateChunkAnalyses,
  buildChunkAnalysisRepairPrompt,
  buildChunkAnalysisSystemPrompt,
  buildChunkAnalysisUserPrompt,
  planClassificationChunks,
  parseChunkAnalysisResponse,
  ChunkAnalysisParseError,
  ClassificationChunkPartialProgressError,
  CLASSIFICATION_CHUNK_MAX_CHARS,
  MAX_CHUNK_ENTITIES,
  MAX_CHUNK_FACTS,
  MAX_CHUNK_TOPICS,
  type ChunkAnalysis,
} from "./classification-chunk-analysis";

function analysis(overrides: Partial<ChunkAnalysis> = {}): ChunkAnalysis {
  return {
    mainPoint: "A point.",
    topics: [],
    entities: [],
    importantFacts: [],
    centrality: "supporting",
    ...overrides,
  };
}

// ─── Chunking ───────────────────────────────────────────────────────────────

describe("planClassificationChunks", () => {
  it("does not split a short article", () => {
    const chunked = planClassificationChunks("Title", "A short article body.");
    assert.equal(chunked.chunks.length, 1);
  });

  it("splits a long article into several bounded, ordered chunks", () => {
    // Real sentences, not "a".repeat — planClassificationChunks delegates to
    // the real sentence/paragraph splitter, which needs sentence punctuation
    // to find boundaries.
    const sentence = "This is one ordinary sentence about home renovation topics today. ";
    const body = sentence.repeat(400); // well over the single-chunk cap
    const chunked = planClassificationChunks("Title", body);

    assert.ok(chunked.chunks.length > 1, "a long article must be split into multiple chunks");
    for (const chunk of chunked.chunks) {
      assert.ok(
        chunk.text.length <= CLASSIFICATION_CHUNK_MAX_CHARS,
        `chunk exceeded the cap: ${chunk.text.length}`
      );
    }
  });

  it("reuses translation's own natural-boundary splitter — no chunk starts or ends mid-sentence", () => {
    const body =
      "First sentence here for the article. Second sentence follows right after. ".repeat(200);
    const chunked = planClassificationChunks("Title", body);
    for (const chunk of chunked.chunks) {
      const trimmed = chunk.text.trim();
      assert.ok(
        /[.!?]$/.test(trimmed) || trimmed.length === 0,
        `chunk did not end on a sentence boundary: ${JSON.stringify(trimmed.slice(-40))}`
      );
    }
  });
});

// ─── Per-chunk reply parsing ────────────────────────────────────────────────

describe("parseChunkAnalysisResponse", () => {
  const okReply = () =>
    JSON.stringify({
      mainPoint: "The section describes a protest.",
      topics: ["protest", "tourism development"],
      entities: ["Albania"],
      importantFacts: ["Hundreds gathered on the coast."],
      centrality: "central",
    });

  it("accepts a well-formed reply", () => {
    const out = parseChunkAnalysisResponse(okReply());
    assert.equal(out.status, "ok");
    if (out.status === "ok") {
      assert.equal(out.mainPoint, "The section describes a protest.");
      assert.deepEqual(out.topics, ["protest", "tourism development"]);
      assert.deepEqual(out.entities, ["Albania"]);
      assert.deepEqual(out.importantFacts, ["Hundreds gathered on the coast."]);
      assert.equal(out.centrality, "central");
    }
  });

  it("accepts empty topics/entities/facts — a section may genuinely have none", () => {
    const out = parseChunkAnalysisResponse(
      JSON.stringify({
        mainPoint: "Scene-setting only.",
        topics: [],
        entities: [],
        importantFacts: [],
        centrality: "supporting",
      })
    );
    assert.equal(out.status, "ok");
  });

  it("throws on a genuinely empty response", () => {
    assert.throws(() => parseChunkAnalysisResponse(""), ChunkAnalysisParseError);
    assert.throws(() => parseChunkAnalysisResponse(null), ChunkAnalysisParseError);
  });

  it("rejects prose instead of JSON, with actionable feedback", () => {
    const out = parseChunkAnalysisResponse("This section is about a protest.");
    assert.equal(out.status, "invalid");
    if (out.status === "invalid") assert.match(out.feedback, /JSON/);
  });

  it("rejects a missing mainPoint", () => {
    const out = parseChunkAnalysisResponse(
      JSON.stringify({ topics: [], entities: [], importantFacts: [], centrality: "central" })
    );
    assert.equal(out.status, "invalid");
  });

  it("rejects a centrality that is not central/supporting", () => {
    const out = parseChunkAnalysisResponse(
      JSON.stringify({
        mainPoint: "x",
        topics: [],
        entities: [],
        importantFacts: [],
        centrality: "important",
      })
    );
    assert.equal(out.status, "invalid");
  });

  it("caps list length and per-item length so one reply cannot dominate the aggregate", () => {
    const out = parseChunkAnalysisResponse(
      JSON.stringify({
        mainPoint: "x",
        topics: Array.from({ length: 50 }, (_, i) => `topic ${i}`),
        entities: Array.from({ length: 50 }, (_, i) => `entity ${i}`),
        importantFacts: Array.from({ length: 50 }, (_, i) => `fact ${i} ${"x".repeat(300)}`),
        centrality: "central",
      })
    );
    assert.equal(out.status, "ok");
    if (out.status === "ok") {
      assert.ok(out.topics.length <= MAX_CHUNK_TOPICS);
      assert.ok(out.entities.length <= MAX_CHUNK_ENTITIES);
      assert.ok(out.importantFacts.length <= MAX_CHUNK_FACTS);
      for (const fact of out.importantFacts) assert.ok(fact.length <= 220);
    }
  });
});

describe("buildChunkAnalysisSystemPrompt / buildChunkAnalysisUserPrompt / buildChunkAnalysisRepairPrompt", () => {
  it("tells the model centrality is about the article's thesis, not length or density", () => {
    const prompt = buildChunkAnalysisSystemPrompt();
    assert.match(prompt, /central/i);
    assert.match(prompt, /supporting/i);
    assert.match(prompt, /never by its length/i);
  });

  it("carries the article title and the chunk's position for context", () => {
    const prompt = buildChunkAnalysisUserPrompt({
      title: "Along Albania's coast",
      chunkText: "The scenery here is remarkable.",
      chunkIndex: 2,
      chunkCount: 5,
    });
    assert.match(prompt, /Along Albania's coast/);
    assert.match(prompt, /Section 3 of 5/);
    assert.match(prompt, /The scenery here is remarkable\./);
  });

  it("repair prompt carries the original request plus the exact problem", () => {
    const original = buildChunkAnalysisUserPrompt({
      title: "t",
      chunkText: "body",
      chunkIndex: 0,
      chunkCount: 1,
    });
    const repair = buildChunkAnalysisRepairPrompt(original, "not json", "Answer with JSON.");
    assert.match(repair, /not json/);
    assert.match(repair, /Answer with JSON\./);
    assert.ok(repair.includes(original));
  });
});

// ─── Resumability ───────────────────────────────────────────────────────────

describe("ClassificationChunkPartialProgressError", () => {
  it("carries the banked analyses and the progress counters", () => {
    const banked = { "0": analysis({ mainPoint: "first" }) };
    const err = new ClassificationChunkPartialProgressError("ran out of budget", banked, 1, 5);
    assert.equal(err.processedChunkCount, 1);
    assert.equal(err.totalChunkCount, 5);
    assert.equal(err.analyzedChunks["0"].mainPoint, "first");
  });
});

// ─── Aggregation ────────────────────────────────────────────────────────────

describe("aggregateChunkAnalyses", () => {
  it("keeps central and supporting points in SEPARATE lists, in article order", () => {
    const result = aggregateChunkAnalyses([
      analysis({ mainPoint: "c1", centrality: "central" }),
      analysis({ mainPoint: "s1", centrality: "supporting" }),
      analysis({ mainPoint: "c2", centrality: "central" }),
      analysis({ mainPoint: "s2", centrality: "supporting" }),
    ]);
    assert.deepEqual(result.centralPoints, ["c1", "c2"]);
    assert.deepEqual(result.supportingPoints, ["s1", "s2"]);
    assert.equal(result.chunkCount, 4);
  });

  it("deduplicates topics and entities case-insensitively across chunks", () => {
    const result = aggregateChunkAnalyses([
      analysis({ topics: ["Paint", "boilers"], entities: ["Acme Corp"] }),
      analysis({ topics: ["paint", "ventilation"], entities: ["acme corp", "Beta Inc"] }),
    ]);
    assert.deepEqual(result.topics, ["Paint", "boilers", "ventilation"]);
    assert.deepEqual(result.entities, ["Acme Corp", "Beta Inc"]);
  });

  it("prefers central chunks' facts over supporting chunks' when both exist", () => {
    const result = aggregateChunkAnalyses([
      analysis({ importantFacts: ["central fact"], centrality: "central" }),
      analysis({ importantFacts: ["supporting fact"], centrality: "supporting" }),
    ]);
    assert.deepEqual(result.importantFacts, ["central fact", "supporting fact"]);
  });

  it("stays bounded by COUNT however many chunks a huge article produces", () => {
    const many: ChunkAnalysis[] = Array.from({ length: 500 }, (_, i) =>
      analysis({
        mainPoint: `point ${i}`,
        topics: [`topic ${i}`],
        entities: [`entity ${i}`],
        importantFacts: [`fact ${i}`],
        centrality: i % 2 === 0 ? "central" : "supporting",
      })
    );
    const result = aggregateChunkAnalyses(many);
    assert.ok(result.centralPoints.length <= 10);
    assert.ok(result.supportingPoints.length <= 6);
    assert.ok(result.topics.length <= 15);
    assert.ok(result.entities.length <= 15);
    assert.ok(result.importantFacts.length <= 12);
    assert.equal(result.truncated, true);
  });

  it("reports truncated=false when nothing was actually dropped", () => {
    const result = aggregateChunkAnalyses([
      analysis({ mainPoint: "c1", centrality: "central", topics: ["a"] }),
      analysis({ mainPoint: "s1", centrality: "supporting", topics: ["b"] }),
    ]);
    assert.equal(result.truncated, false);
  });

  it("handles an article with no central chunk at all — an honest empty list, not a crash", () => {
    const result = aggregateChunkAnalyses([
      analysis({ mainPoint: "s1", centrality: "supporting" }),
      analysis({ mainPoint: "s2", centrality: "supporting" }),
    ]);
    assert.deepEqual(result.centralPoints, []);
    assert.deepEqual(result.supportingPoints, ["s1", "s2"]);
  });
});
