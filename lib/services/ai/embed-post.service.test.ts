import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SocialChannel } from "@prisma/client";
import type { IEmbeddingProvider } from "@/lib/ai/embedding/embedding-provider";
import { EMBEDDING_DIMENSIONS } from "@/lib/ai/embedding/embedding-provider-factory";
import {
  coreMessageHash,
  embedPost,
  type EmbedPostInput,
  type PostSemanticsStore,
  type SemanticsRow,
} from "./embed-post.service";
import { buildSemanticDocument } from "./build-semantic-document";

// ─── Fakes ────────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<EmbedPostInput> = {}): EmbedPostInput {
  return {
    postId: "post-1",
    companyId: "co-1",
    channel: "linkedin" as SocialChannel,
    coreMessage: "A clear central claim about the product launch.",
    postCreatedAt: new Date("2026-07-14T00:00:00Z"),
    ...overrides,
  };
}

/** The exact text embedded for an input — the semantic document, hashed for change detection. */
function documentFor(input: EmbedPostInput): string {
  return buildSemanticDocument({
    topic: input.topic,
    coreMessage: input.coreMessage?.trim(),
    aspectFocus: input.aspectFocus,
  });
}

function makeProvider(dims = EMBEDDING_DIMENSIONS): IEmbeddingProvider {
  return {
    provider: "fake",
    model: "fake-model",
    dims,
    embed: async (texts) => ({
      vectors: texts.map(() => new Array<number>(dims).fill(0.01)),
      provider: "fake",
      model: "fake-model",
      dims,
    }),
  };
}

/** Records the texts handed to the provider, so tests can assert the embedded document. */
function capturingProvider(sink: string[], dims = EMBEDDING_DIMENSIONS): IEmbeddingProvider {
  return {
    provider: "fake",
    model: "fake-model",
    dims,
    embed: async (texts) => {
      sink.push(...texts);
      return {
        vectors: texts.map(() => new Array<number>(dims).fill(0.01)),
        provider: "fake",
        model: "fake-model",
        dims,
      };
    },
  };
}

function throwingProvider(): IEmbeddingProvider {
  return {
    provider: "fake",
    model: "fake-model",
    dims: EMBEDDING_DIMENSIONS,
    embed: async () => {
      throw new Error("provider exploded");
    },
  };
}

interface StoreState {
  existing: { coreMessageHash: string | null; status: string } | null;
  saved: SemanticsRow | null;
  failure: { input: EmbedPostInput; hash: string; error: string } | null;
}

function makeStore(existing: StoreState["existing"] = null): {
  store: PostSemanticsStore;
  state: StoreState;
} {
  const state: StoreState = { existing, saved: null, failure: null };
  const store: PostSemanticsStore = {
    getExisting: async () => state.existing,
    saveEmbedding: async (row) => {
      state.saved = row;
    },
    recordFailure: async (input, hash, error) => {
      state.failure = { input, hash, error };
    },
  };
  return { store, state };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("embedPost (Phase 1.2)", () => {
  it("skips when there is no coreMessage", async () => {
    const { store, state } = makeStore();
    const result = await embedPost(makeInput({ coreMessage: null }), {
      provider: makeProvider(),
      store,
    });
    assert.deepEqual(result, { status: "skipped", reason: "no_core_message" });
    assert.equal(state.saved, null);
  });

  it("embeds and saves a ready row on success", async () => {
    const { store, state } = makeStore();
    const input = makeInput();
    const result = await embedPost(input, { provider: makeProvider(), store });

    assert.deepEqual(result, { status: "embedded" });
    assert.ok(state.saved, "row should be saved");
    assert.equal(state.saved!.postId, "post-1");
    assert.equal(state.saved!.vector.length, EMBEDDING_DIMENSIONS);
    assert.equal(state.saved!.provider, "fake");
    // The stored hash covers the exact embedded text (the semantic document).
    assert.equal(state.saved!.coreMessageHash, coreMessageHash(documentFor(input)));
  });

  it("embeds the full semantic document (topic + core message + aspect focus)", async () => {
    const { store } = makeStore();
    const texts: string[] = [];
    const input = makeInput({
      coreMessage: "Toddlers can wade safely in the shallow north-east bays.",
      topic: "Family beaches in Corfu",
      aspectFocus: "safe swimming conditions for small children",
    });

    const result = await embedPost(input, { provider: capturingProvider(texts), store });

    assert.deepEqual(result, { status: "embedded" });
    assert.equal(texts.length, 1, "should embed exactly one document");
    assert.equal(
      texts[0],
      [
        "Topic: Family beaches in Corfu",
        "",
        "Core message:",
        "Toddlers can wade safely in the shallow north-east bays.",
        "",
        "Aspect:",
        "safe swimming conditions for small children",
      ].join("\n")
    );
  });

  it("embeds only the core-message section when topic and aspect are absent", async () => {
    const { store } = makeStore();
    const texts: string[] = [];
    const input = makeInput({ topic: null, aspectFocus: null });

    await embedPost(input, { provider: capturingProvider(texts), store });

    assert.equal(texts[0], `Core message:\n${input.coreMessage!.trim()}`);
  });

  it("skips re-embedding when the document hash is unchanged and ready", async () => {
    const input = makeInput({ topic: "A topic", aspectFocus: "an aspect focus" });
    const hash = coreMessageHash(documentFor(input));
    const { store, state } = makeStore({ coreMessageHash: hash, status: "ready" });

    const result = await embedPost(input, { provider: makeProvider(), store });
    assert.deepEqual(result, { status: "skipped", reason: "unchanged" });
    assert.equal(state.saved, null, "should not call the provider/store again");
  });

  it("re-embeds when the topic changes even though the coreMessage is identical", async () => {
    // A row hashed from a document WITHOUT the topic no longer matches once the
    // topic enriches the document → the stale embedding is refreshed.
    const input = makeInput({ topic: "New topic" });
    const staleHash = coreMessageHash(documentFor(makeInput()));
    const { store, state } = makeStore({ coreMessageHash: staleHash, status: "ready" });

    const result = await embedPost(input, { provider: makeProvider(), store });
    assert.deepEqual(result, { status: "embedded" });
    assert.ok(state.saved);
    assert.equal(state.saved!.coreMessageHash, coreMessageHash(documentFor(input)));
  });

  it("re-embeds when an existing row is not ready even if the hash matches", async () => {
    const input = makeInput();
    const hash = coreMessageHash(documentFor(input));
    const { store, state } = makeStore({ coreMessageHash: hash, status: "failed" });

    const result = await embedPost(input, { provider: makeProvider(), store });
    assert.deepEqual(result, { status: "embedded" });
    assert.ok(state.saved);
  });

  it("skips when no provider is available", async () => {
    const { store, state } = makeStore();
    // provider omitted AND factory returns null (no env) → no_provider.
    const prev = process.env.AI_MOCK_MODE;
    delete process.env.AI_MOCK_MODE;
    const prevProvider = process.env.EMBEDDING_PROVIDER;
    delete process.env.EMBEDDING_PROVIDER;
    try {
      const result = await embedPost(makeInput(), { store });
      assert.deepEqual(result, { status: "skipped", reason: "no_provider" });
      assert.equal(state.saved, null);
    } finally {
      if (prev !== undefined) process.env.AI_MOCK_MODE = prev;
      if (prevProvider !== undefined) process.env.EMBEDDING_PROVIDER = prevProvider;
    }
  });

  it("records a failure (and never throws) when the provider errors", async () => {
    const { store, state } = makeStore();
    const result = await embedPost(makeInput(), { provider: throwingProvider(), store });

    assert.equal(result.status, "failed");
    assert.ok(state.failure, "failure should be recorded");
    assert.equal(state.saved, null);
    assert.match(state.failure!.error, /provider exploded/);
  });

  it("fails on a dimension mismatch rather than writing a bad vector", async () => {
    const { store, state } = makeStore();
    const result = await embedPost(makeInput(), { provider: makeProvider(768), store });

    assert.equal(result.status, "failed");
    assert.equal(state.saved, null);
    assert.ok(state.failure);
    assert.match(state.failure!.error, /dimension mismatch/);
  });
});
