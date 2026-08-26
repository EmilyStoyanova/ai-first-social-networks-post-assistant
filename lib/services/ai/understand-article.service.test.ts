import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { understandArticle } from "./understand-article.service";
import { planClassificationChunks } from "@/lib/ai/classification-chunk-analysis";
import type { ILlmProvider, LlmRequest, LlmResponse } from "@/lib/ai/types";

function chunkReply(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    mainPoint: "A section of the article.",
    topics: [],
    entities: [],
    importantFacts: [],
    centrality: "supporting",
    ...overrides,
  });
}

function understandingReply(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    mainSubject: "Residents are protesting a new coastal tourism development.",
    centralThesis: "Development threatens a protected coastal area.",
    centralConflict: "Residents versus developers over the protected coast.",
    articleType: "news",
    secondaryTopics: ["tourism"],
    incidentalTopics: ["hotels"],
    entities: ["Albania"],
    confidence: 0.95,
    evidence: [{ chunkIndex: 0, reason: "shows the protest" }],
    ...overrides,
  });
}

function scriptedProvider(replies: string[]): { provider: ILlmProvider; prompts: string[] } {
  const queue = [...replies];
  const prompts: string[] = [];
  return {
    provider: {
      generate: async (req: LlmRequest): Promise<LlmResponse> => {
        prompts.push(req.userPrompt);
        return { text: queue.shift() ?? "" };
      },
    },
    prompts,
  };
}

/** Well under MAX_CLASSIFICATION_CONTENT_CHARS — takes the direct (unchunked) path. */
const SHORT_BODY = "A short article about choosing paint colours for a nursery room.";

/** Real sentences, not `.repeat("a")` — the splitter needs sentence punctuation. */
function longBody(): string {
  const sentence = "This is one ordinary sentence about coastal tourism development today. ";
  return sentence.repeat(400);
}

const CHUNK_COUNT = planClassificationChunks(null, longBody()).chunks.length;

describe("understandArticle — direct path (short article)", () => {
  it("reads the article in one call and returns chunkCount 1 / usedChunking false", async () => {
    const { provider, prompts } = scriptedProvider([understandingReply()]);
    const outcome = await understandArticle(
      { title: "Nursery paint", body: SHORT_BODY },
      { provider }
    );

    assert.equal(outcome.status, "ok");
    if (outcome.status === "ok") {
      assert.equal(outcome.chunkCount, 1);
      assert.equal(outcome.usedChunking, false);
      assert.equal(
        outcome.understanding.mainSubject,
        "Residents are protesting a new coastal tourism development."
      );
    }
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /Section 0:/);
  });

  it("does not apply the chunked-path confidence ceiling — a single direct read is already the strongest evidence", async () => {
    const { provider } = scriptedProvider([understandingReply({ confidence: 0.99 })]);
    const outcome = await understandArticle({ title: null, body: SHORT_BODY }, { provider });
    assert.equal(outcome.status, "ok");
    if (outcome.status === "ok") assert.equal(outcome.understanding.confidence, 0.99);
  });

  it("fails (not repairs) a genuinely empty first response", async () => {
    const { provider, prompts } = scriptedProvider(["", understandingReply()]);
    const outcome = await understandArticle({ title: null, body: SHORT_BODY }, { provider });
    assert.equal(outcome.status, "failed");
    assert.equal(prompts.length, 1, "an empty response is a failure, not something to repair");
  });

  it("repairs once, then fails, when the reply keeps citing an out-of-range evidence chunk", async () => {
    const bad = understandingReply({ evidence: [{ chunkIndex: 7, reason: "nonexistent" }] });
    const { provider, prompts } = scriptedProvider([bad, bad]);
    const outcome = await understandArticle({ title: null, body: SHORT_BODY }, { provider });
    assert.equal(outcome.status, "failed");
    assert.equal(prompts.length, 2, "one original call plus one repair call");
  });
});

describe("understandArticle — chunked path", () => {
  it("analyzes every chunk once, then makes exactly one global synthesis call", async () => {
    const replies = [
      ...Array.from({ length: CHUNK_COUNT }, () => chunkReply()),
      understandingReply(),
    ];
    const { provider, prompts } = scriptedProvider(replies);
    const outcome = await understandArticle(
      { title: "Coastal region", body: longBody() },
      { provider }
    );

    assert.equal(outcome.status, "ok");
    if (outcome.status === "ok") {
      assert.equal(outcome.chunkCount, CHUNK_COUNT);
      assert.equal(outcome.usedChunking, true);
    }
    assert.equal(prompts.length, CHUNK_COUNT + 1);
  });

  it("fails without ever reaching synthesis when a chunk cannot be reliably analyzed", async () => {
    const unparsable = "not json at all";
    const replies = [
      unparsable,
      unparsable,
      ...Array.from({ length: CHUNK_COUNT }, () => chunkReply()),
    ];
    const { provider, prompts } = scriptedProvider(replies);
    const outcome = await understandArticle({ title: null, body: longBody() }, { provider });

    assert.equal(outcome.status, "failed");
    // One original call + one repair call for chunk 0, then nothing further.
    assert.equal(prompts.length, 2);
  });

  it("fails when every chunk analyzes fine but the synthesis reply cannot be trusted after repair", async () => {
    const badSynthesis = "not json at all";
    const replies = [
      ...Array.from({ length: CHUNK_COUNT }, () => chunkReply()),
      badSynthesis,
      badSynthesis,
    ];
    const { provider, prompts } = scriptedProvider(replies);
    const outcome = await understandArticle({ title: null, body: longBody() }, { provider });

    assert.equal(outcome.status, "failed");
    assert.equal(prompts.length, CHUNK_COUNT + 2);
  });

  it("misleading opening — a supporting first chunk does not out-rank a central chunk found later", async () => {
    const replies = [
      chunkReply({
        mainPoint: "Beaches draw record numbers of tourists this year.",
        topics: ["tourism"],
      }),
      ...Array.from({ length: CHUNK_COUNT - 2 }, () => chunkReply({ topics: ["tourism"] })),
      chunkReply({
        mainPoint: "Residents filed a lawsuit to block the new coastal resort.",
        topics: ["lawsuit", "coastal development"],
        centrality: "central",
      }),
      understandingReply({
        mainSubject: "Residents are suing to block a new coastal resort development.",
        evidence: [{ chunkIndex: CHUNK_COUNT - 1, reason: "names the lawsuit directly" }],
      }),
    ];
    const { provider, prompts } = scriptedProvider(replies);
    const outcome = await understandArticle(
      { title: "Coastal region roundup", body: longBody() },
      { provider }
    );

    assert.equal(outcome.status, "ok");
    if (outcome.status === "ok") {
      assert.equal(
        outcome.understanding.mainSubject,
        "Residents are suing to block a new coastal resort development."
      );
      assert.deepEqual(outcome.understanding.evidence[0], {
        chunkIndex: CHUNK_COUNT - 1,
        reason: "names the lawsuit directly",
      });
    }

    const synthesisPrompt = prompts[prompts.length - 1];
    const centralSection = synthesisPrompt.split("CONTEXT —")[0];
    assert.match(centralSection, /lawsuit to block the new coastal resort/);
    assert.doesNotMatch(centralSection, /Beaches draw record numbers/);
  });

  it("real topic appears only in the final chunk — still reaches the synthesis call with the right evidence bound", async () => {
    const replies = [
      ...Array.from({ length: CHUNK_COUNT - 1 }, () => chunkReply({ topics: ["scenery"] })),
      chunkReply({
        mainPoint: "The region's mayor announces the development permit was revoked.",
        topics: ["permit revoked"],
        centrality: "central",
      }),
      understandingReply({
        mainSubject: "A coastal development permit was revoked after resident pressure.",
        evidence: [{ chunkIndex: CHUNK_COUNT - 1, reason: "reports the revoked permit" }],
      }),
    ];
    const { provider } = scriptedProvider(replies);
    const outcome = await understandArticle({ title: null, body: longBody() }, { provider });

    assert.equal(outcome.status, "ok");
    if (outcome.status === "ok") {
      assert.equal(
        outcome.understanding.mainSubject,
        "A coastal development permit was revoked after resident pressure."
      );
      assert.equal(outcome.understanding.evidence[0].chunkIndex, CHUNK_COUNT - 1);
    }
  });

  it("many repeated incidental mentions of one topic do not raise confidence above the deterministic ceiling", async () => {
    const replies = [
      chunkReply({
        mainPoint: "Residents filed suit against the resort developer.",
        topics: ["lawsuit"],
        centrality: "central",
      }),
      ...Array.from({ length: CHUNK_COUNT - 1 }, () =>
        chunkReply({
          mainPoint: "Another paragraph about the popular local hotels.",
          topics: ["hotels"],
        })
      ),
      understandingReply({ confidence: 0.97 }),
    ];
    const { provider } = scriptedProvider(replies);
    const outcome = await understandArticle({ title: null, body: longBody() }, { provider });

    assert.equal(outcome.status, "ok");
    if (outcome.status === "ok") {
      assert.ok(
        outcome.understanding.confidence < 0.97,
        `expected the ceiling to suppress the model's claimed 0.97, got ${outcome.understanding.confidence}`
      );
    }
  });

  it("multiple related central sections with one clear thesis keep confidence close to the model's own estimate", async () => {
    const replies = [
      chunkReply({
        mainPoint: "The lawsuit was filed in the district court.",
        topics: ["lawsuit", "coastal development"],
        centrality: "central",
      }),
      chunkReply({
        mainPoint: "The developer denies wrongdoing.",
        topics: ["lawsuit", "coastal development"],
        centrality: "central",
      }),
      ...Array.from({ length: Math.max(0, CHUNK_COUNT - 3) }, () =>
        chunkReply({ topics: ["scenery"] })
      ),
      chunkReply({
        mainPoint: "A court date is set for next month.",
        topics: ["lawsuit", "coastal development"],
        centrality: "central",
      }),
      understandingReply({ confidence: 0.9 }),
    ];
    const { provider } = scriptedProvider(replies);
    const outcome = await understandArticle({ title: null, body: longBody() }, { provider });

    assert.equal(outcome.status, "ok");
    if (outcome.status === "ok") {
      assert.ok(
        outcome.understanding.confidence >= 0.75,
        `expected a high, near-model confidence, got ${outcome.understanding.confidence}`
      );
    }
  });

  it("genuinely multi-topic article — unrelated central sections get a low confidence even when the model is sure", async () => {
    const replies = [
      chunkReply({
        mainPoint: "A protest over coastal development.",
        topics: ["coastal protest"],
        centrality: "central",
      }),
      chunkReply({
        mainPoint: "The local football team won a championship.",
        topics: ["football"],
        centrality: "central",
      }),
      chunkReply({
        mainPoint: "A museum reopens after renovation.",
        topics: ["museum"],
        centrality: "central",
      }),
      ...Array.from({ length: Math.max(0, CHUNK_COUNT - 3) }, () => chunkReply()),
      understandingReply({ confidence: 0.95 }),
    ];
    const { provider } = scriptedProvider(replies);
    const outcome = await understandArticle({ title: null, body: longBody() }, { provider });

    assert.equal(outcome.status, "ok");
    if (outcome.status === "ok") {
      assert.ok(
        outcome.understanding.confidence <= 0.55,
        `expected a suppressed confidence for disagreeing central sections, got ${outcome.understanding.confidence}`
      );
    }
  });

  it("Albania-style case — tourism/beaches/hotels are frequent but incidental; the protest is the mainSubject", async () => {
    const replies = [
      chunkReply({
        mainPoint: "Albania's coastline has drawn record tourist numbers.",
        topics: ["tourism"],
      }),
      chunkReply({
        mainPoint: "New beach resorts are under construction.",
        topics: ["beaches", "hotels"],
      }),
      ...Array.from({ length: Math.max(0, CHUNK_COUNT - 3) }, () =>
        chunkReply({ mainPoint: "Scenic description of the coast.", topics: ["scenery"] })
      ),
      chunkReply({
        mainPoint: "Hundreds gathered to protest development in a protected coastal area.",
        topics: ["protest", "protected coastal area"],
        entities: ["Albania"],
        centrality: "central",
      }),
      understandingReply({
        mainSubject:
          "Residents in Albania are protesting new tourism development in a protected coastal area.",
        secondaryTopics: ["protected coastal area"],
        incidentalTopics: ["tourism", "beaches", "hotels"],
        entities: ["Albania"],
        evidence: [
          { chunkIndex: CHUNK_COUNT - 1, reason: "names the protest and the protected area" },
        ],
      }),
    ];
    const { provider, prompts } = scriptedProvider(replies);
    const outcome = await understandArticle(
      { title: "Albania's coast", body: longBody() },
      { provider }
    );

    assert.equal(outcome.status, "ok");
    if (outcome.status === "ok") {
      assert.match(outcome.understanding.mainSubject, /protest/i);
      assert.match(outcome.understanding.mainSubject, /protected coastal area/i);
      assert.deepEqual(outcome.understanding.incidentalTopics, ["tourism", "beaches", "hotels"]);
    }

    const synthesisPrompt = prompts[prompts.length - 1];
    const centralSection = synthesisPrompt.split("CONTEXT —")[0];
    assert.match(centralSection, /protest development in a protected coastal area/);
    assert.doesNotMatch(centralSection, /record tourist numbers/);
  });
});
