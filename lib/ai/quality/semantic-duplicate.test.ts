import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cosineSimilarity,
  decisionFor,
  evaluateSemanticNeighbors,
  type SemanticNeighbor,
} from "./semantic-duplicate";

// A unit vector whose cosine to CANDIDATE ([1,0,0,0]) equals `c`.
function neighborWithCosine(postId: string, c: number, dims = 4): SemanticNeighbor {
  const v = new Array<number>(dims).fill(0);
  v[0] = c;
  v[1] = Math.sqrt(Math.max(0, 1 - c * c));
  return { postId, coreMessage: `core-${postId}`, vector: v };
}

const CANDIDATE = [1, 0, 0, 0];

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
  });

  it("returns 0 for orthogonal vectors", () => {
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  });

  it("returns 0 when either vector has zero magnitude", () => {
    assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  });

  it("throws on a dimension mismatch", () => {
    assert.throws(() => cosineSimilarity([1, 2], [1, 2, 3]), /dimension mismatch/);
  });
});

describe("decisionFor — threshold bands", () => {
  it("accepts when there is no history (null)", () => {
    assert.equal(decisionFor(null), "accept");
  });

  it("accepts below 0.80", () => {
    assert.equal(decisionFor(0.79), "accept");
    assert.equal(decisionFor(0), "accept");
  });

  it("flags the gray zone in [0.80, 0.86)", () => {
    assert.equal(decisionFor(0.8), "gray_zone");
    assert.equal(decisionFor(0.85), "gray_zone");
    assert.equal(decisionFor(0.8599), "gray_zone");
  });

  it("regenerates at or above 0.86", () => {
    assert.equal(decisionFor(0.86), "regenerate");
    assert.equal(decisionFor(0.95), "regenerate");
    assert.equal(decisionFor(1), "regenerate");
  });
});

describe("evaluateSemanticNeighbors", () => {
  it("accepts with null similarity when there is no history", () => {
    const result = evaluateSemanticNeighbors(CANDIDATE, []);
    assert.deepEqual(result, {
      decision: "accept",
      topSimilarity: null,
      matchedPostId: null,
      matchedCoreMessage: null,
    });
  });

  it("accepts a distant candidate but still reports the closest match", () => {
    const result = evaluateSemanticNeighbors(CANDIDATE, [neighborWithCosine("p1", 0.5)]);
    assert.equal(result.decision, "accept");
    assert.equal(result.topSimilarity, 0.5);
    assert.equal(result.matchedPostId, "p1");
  });

  it("flags the gray zone", () => {
    const result = evaluateSemanticNeighbors(CANDIDATE, [neighborWithCosine("p1", 0.83)]);
    assert.equal(result.decision, "gray_zone");
    assert.equal(result.topSimilarity, 0.83);
  });

  it("regenerates on a near-identical claim and returns its coreMessage", () => {
    const result = evaluateSemanticNeighbors(CANDIDATE, [neighborWithCosine("p9", 0.99)]);
    assert.equal(result.decision, "regenerate");
    assert.equal(result.matchedPostId, "p9");
    assert.equal(result.matchedCoreMessage, "core-p9");
  });

  it("returns the closest of several neighbors", () => {
    const result = evaluateSemanticNeighbors(CANDIDATE, [
      neighborWithCosine("far", 0.3),
      neighborWithCosine("closest", 0.9),
      neighborWithCosine("mid", 0.6),
    ]);
    assert.equal(result.matchedPostId, "closest");
    assert.equal(result.topSimilarity, 0.9);
    assert.equal(result.decision, "regenerate");
  });

  it("skips neighbors whose dimension does not match the candidate", () => {
    const mismatched: SemanticNeighbor = { postId: "bad", coreMessage: "x", vector: [1, 0] };
    const result = evaluateSemanticNeighbors(CANDIDATE, [mismatched]);
    // Only the mismatched neighbor exists → treated as no comparable history.
    assert.equal(result.decision, "accept");
    assert.equal(result.topSimilarity, null);
    assert.equal(result.matchedPostId, null);
  });
});
