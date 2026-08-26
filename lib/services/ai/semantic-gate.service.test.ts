import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SocialChannel } from "@prisma/client";
import type { IEmbeddingProvider } from "@/lib/ai/embedding/embedding-provider";
import { EMBEDDING_DIMENSIONS } from "@/lib/ai/embedding/embedding-provider-factory";
import type { SemanticNeighbor } from "@/lib/ai/quality/semantic-duplicate";
import {
  createSemanticGate,
  MAX_SEMANTIC_NEIGHBORS,
  type SemanticNeighborStore,
} from "./semantic-gate.service";

// ─── Fakes ────────────────────────────────────────────────────────────────────

/** A 1024-dim unit vector with a single hot component. */
function unitVector(hot: number): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  v[hot] = 1;
  return v;
}

const CANDIDATE_VECTOR = unitVector(0);

/** Provider that returns a fixed vector for every input text. */
function fakeProvider(vector: number[] = CANDIDATE_VECTOR): IEmbeddingProvider {
  return {
    provider: "fake",
    model: "fake",
    dims: vector.length,
    embed: async (texts) => ({
      vectors: texts.map(() => vector),
      provider: "fake",
      model: "fake",
      dims: vector.length,
    }),
  };
}

function throwingProvider(): IEmbeddingProvider {
  return {
    provider: "fake",
    model: "fake",
    dims: EMBEDDING_DIMENSIONS,
    embed: async () => {
      throw new Error("worker unreachable");
    },
  };
}

/** Records the texts embedded, so tests can assert the document sent to the provider. */
function capturingProvider(
  sink: string[],
  vector: number[] = CANDIDATE_VECTOR
): IEmbeddingProvider {
  return {
    provider: "fake",
    model: "fake",
    dims: vector.length,
    embed: async (texts) => {
      sink.push(...texts);
      return {
        vectors: texts.map(() => vector),
        provider: "fake",
        model: "fake",
        dims: vector.length,
      };
    },
  };
}

interface Captured {
  companyId?: string;
  channel?: SocialChannel;
  limit?: number;
  excludeContentGroupId?: string | null;
  calls: number;
}

function fakeStore(neighbors: SemanticNeighbor[], captured: Captured): SemanticNeighborStore {
  return {
    fetchReadyNeighbors: async (companyId, channel, limit, excludeContentGroupId) => {
      captured.companyId = companyId;
      captured.channel = channel;
      captured.limit = limit;
      captured.excludeContentGroupId = excludeContentGroupId ?? null;
      captured.calls += 1;
      return neighbors;
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("createSemanticGate — decisions", () => {
  it("regenerates on a near-identical stored claim and returns its coreMessage", async () => {
    const captured: Captured = { calls: 0 };
    const gate = createSemanticGate("co-1", "linkedin" as SocialChannel, {
      provider: fakeProvider(),
      store: fakeStore(
        [{ postId: "old-1", coreMessage: "The repeated claim.", vector: unitVector(0) }],
        captured
      ),
    });

    const result = await gate({ coreMessage: "A fresh central claim." });
    assert.equal(result.decision, "regenerate");
    assert.equal(result.matchedPostId, "old-1");
    assert.equal(result.matchedCoreMessage, "The repeated claim.");
    assert.equal(result.skipped, false);
  });

  it("accepts when the closest neighbor is distant", async () => {
    const captured: Captured = { calls: 0 };
    const gate = createSemanticGate("co-1", "linkedin" as SocialChannel, {
      provider: fakeProvider(),
      // Orthogonal to the candidate → cosine 0.
      store: fakeStore([{ postId: "old-1", coreMessage: "x", vector: unitVector(1) }], captured),
    });

    const result = await gate({ coreMessage: "A fresh central claim." });
    assert.equal(result.decision, "accept");
    assert.equal(result.skipped, false);
  });
});

// ─── Sibling exclusion (mirrors the Jaccard pool's content-group exclusion) ───
describe("createSemanticGate — excludeContentGroupId", () => {
  it("passes the content group through to the neighbor store, so a sibling's own embeddings are excluded too", async () => {
    const captured: Captured = { calls: 0 };
    const gate = createSemanticGate("co-1", "instagram" as SocialChannel, {
      provider: fakeProvider(),
      store: fakeStore([], captured),
      excludeContentGroupId: "group-1",
    });

    await gate({ coreMessage: "A fresh central claim." });

    assert.equal(captured.excludeContentGroupId, "group-1");
  });

  it("passes null when the generation has no content group — nothing is excluded", async () => {
    const captured: Captured = { calls: 0 };
    const gate = createSemanticGate("co-1", "instagram" as SocialChannel, {
      provider: fakeProvider(),
      store: fakeStore([], captured),
    });

    await gate({ coreMessage: "A fresh central claim." });

    assert.equal(captured.excludeContentGroupId, null);
  });
});

describe("createSemanticGate — embedded document", () => {
  it("embeds the full semantic document (topic + core message + aspect focus)", async () => {
    const texts: string[] = [];
    const captured: Captured = { calls: 0 };
    const gate = createSemanticGate("co-1", "linkedin" as SocialChannel, {
      provider: capturingProvider(texts),
      store: fakeStore([], captured),
    });

    await gate({
      coreMessage: "Toddlers can wade safely in the shallow bays.",
      topic: "Family beaches in Corfu",
      aspectFocus: "safe swimming conditions for small children",
    });

    assert.equal(texts.length, 1);
    assert.equal(
      texts[0],
      [
        "Topic: Family beaches in Corfu",
        "",
        "Core message:",
        "Toddlers can wade safely in the shallow bays.",
        "",
        "Aspect:",
        "safe swimming conditions for small children",
      ].join("\n")
    );
  });

  it("embeds only the core-message section when topic and aspect are absent", async () => {
    const texts: string[] = [];
    const captured: Captured = { calls: 0 };
    const gate = createSemanticGate("co-1", "linkedin" as SocialChannel, {
      provider: capturingProvider(texts),
      store: fakeStore([], captured),
    });

    await gate({ coreMessage: "A standalone central claim." });

    assert.equal(texts[0], "Core message:\nA standalone central claim.");
  });
});

describe("createSemanticGate — missing history", () => {
  it("accepts with null similarity when there are no ready neighbors", async () => {
    const captured: Captured = { calls: 0 };
    const gate = createSemanticGate("co-1", "linkedin" as SocialChannel, {
      provider: fakeProvider(),
      store: fakeStore([], captured),
    });

    const result = await gate({ coreMessage: "A claim." });
    assert.equal(result.decision, "accept");
    assert.equal(result.topSimilarity, null);
    assert.equal(result.matchedPostId, null);
    assert.equal(result.skipped, false);
  });
});

describe("createSemanticGate — fail open", () => {
  it("skips (accept) when the embedding provider throws", async () => {
    const captured: Captured = { calls: 0 };
    const gate = createSemanticGate("co-1", "linkedin" as SocialChannel, {
      provider: throwingProvider(),
      store: fakeStore([], captured),
    });

    const result = await gate({ coreMessage: "A claim." });
    assert.equal(result.decision, "accept");
    assert.equal(result.skipped, true);
    assert.equal(captured.calls, 0, "should not reach the store when embedding fails");
  });

  it("skips (accept) when no embedding provider is configured", async () => {
    const captured: Captured = { calls: 0 };
    const gate = createSemanticGate("co-1", "linkedin" as SocialChannel, {
      provider: null,
      store: fakeStore([], captured),
    });

    const result = await gate({ coreMessage: "A claim." });
    assert.equal(result.decision, "accept");
    assert.equal(result.skipped, true);
  });

  it("accepts without embedding when the candidate has no coreMessage", async () => {
    const captured: Captured = { calls: 0 };
    const gate = createSemanticGate("co-1", "linkedin" as SocialChannel, {
      provider: fakeProvider(),
      store: fakeStore([], captured),
    });

    const result = await gate({ coreMessage: null });
    assert.equal(result.decision, "accept");
    assert.equal(result.skipped, false);
    assert.equal(captured.calls, 0, "no lookup when there is nothing to embed");
  });
});

describe("createSemanticGate — company/channel isolation and window", () => {
  it("looks up neighbors scoped to the exact company and channel", async () => {
    const captured: Captured = { calls: 0 };
    const gate = createSemanticGate("company-42", "instagram" as SocialChannel, {
      provider: fakeProvider(),
      store: fakeStore([], captured),
    });

    await gate({ coreMessage: "A claim." });
    assert.equal(captured.companyId, "company-42");
    assert.equal(captured.channel, "instagram");
  });

  it("requests at most the latest 50 neighbors", async () => {
    const captured: Captured = { calls: 0 };
    const gate = createSemanticGate("co-1", "linkedin" as SocialChannel, {
      provider: fakeProvider(),
      store: fakeStore([], captured),
    });

    await gate({ coreMessage: "A claim." });
    assert.equal(captured.limit, 50);
    assert.equal(captured.limit, MAX_SEMANTIC_NEIGHBORS);
  });
});
