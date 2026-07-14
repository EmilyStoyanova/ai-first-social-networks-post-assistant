import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SocialChannel } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { generatePostFromContext } from "./generate-draft-post.service";
import type { GenerateDraftPostDb, GenerateDraftPostDeps } from "./generate-draft-post.service";
import type { EmbedPostInput } from "./embed-post.service";
import type { SemanticGate } from "@/lib/ai/generate-with-retry";
import type { GenerationContext } from "@/lib/ai/types";

const ACCEPT_GATE: SemanticGate = async () => ({
  decision: "accept",
  topSimilarity: null,
  matchedPostId: null,
  matchedCoreMessage: null,
  skipped: false,
});

// The coreMessage baked into the AI_MOCK_MODE response (see MOCK_LLM_TEXT in the
// service). Tests run in mock mode so no live LLM provider is contacted.
const MOCK_CORE_MESSAGE =
  "Anticipation for an upcoming launch builds excitement and keeps the audience engaged.";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeContext(overrides: Partial<GenerationContext> = {}): GenerationContext {
  return {
    company: { name: "Acme", website: null, automationMode: "manual", defaultLang: "en" },
    brand: null,
    channel: {
      channel: "linkedin",
      postingLanguage: "en",
      imageRequired: false,
      automationModeOverride: null,
      maxTextLength: null,
      includeSourceLink: false,
    },
    feedItems: [],
    hasContentSources: false,
    llm: { provider: "groq", model: "llama-3.3-70b-versatile" },
    ...overrides,
  };
}

interface RecentRow {
  id: string;
  content: string;
  promptSnapshot: Prisma.JsonValue | null;
}

function makeDeps(
  recentRows: RecentRow[] = [],
  semanticGate: SemanticGate = ACCEPT_GATE
): {
  deps: GenerateDraftPostDeps;
  created: () => Prisma.PostUncheckedCreateInput | null;
  embedded: () => EmbedPostInput | null;
} {
  let createdData: Prisma.PostUncheckedCreateInput | null = null;
  let embeddedInput: EmbedPostInput | null = null;

  const db: GenerateDraftPostDb = {
    post: {
      findMany: async () => recentRows,
      create: async (args) => {
        createdData = args.data;
        return {
          id: "post-1",
          companyId: args.data.companyId,
          channel: args.data.channel as SocialChannel,
          status: "draft",
          content: args.data.content,
          hashtags: [],
          imagePrompt: null,
          notes: null,
          llmProvider: null,
          llmModel: null,
          createdAt: new Date(),
        };
      },
    },
    // Always grants the claim so the "generate" (article) path proceeds.
    feedItem: { updateMany: async () => ({ count: 1 }) },
  };

  return {
    // Inject a fake embed + semantic gate so no real provider / DB is touched.
    deps: {
      db,
      auditLog: async () => {},
      embed: async (input) => {
        embeddedInput = input;
        return { status: "embedded" };
      },
      // Default: accept (no semantic history) so these Phase 1.1/1.2 tests are
      // unaffected by the Phase 1.4 gate. Overridable for gate-specific tests.
      semanticGate,
    },
    created: () => createdData,
    embedded: () => embeddedInput,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("generatePostFromContext — coreMessage persistence (Phase 1.1)", () => {
  let prevMockMode: string | undefined;

  before(() => {
    prevMockMode = process.env.AI_MOCK_MODE;
    process.env.AI_MOCK_MODE = "true";
  });

  after(() => {
    if (prevMockMode === undefined) delete process.env.AI_MOCK_MODE;
    else process.env.AI_MOCK_MODE = prevMockMode;
  });

  it("persists coreMessage to the dedicated column for a generated (article) post", async () => {
    const { deps, created } = makeDeps();
    const context = makeContext({
      feedItems: [
        {
          id: "feed-1",
          title: "Launch incoming",
          content: "We are preparing something big for our audience.",
          url: "https://example.com/launch",
          publishedAt: null,
        },
      ],
      hasContentSources: true,
    });

    const result = await generatePostFromContext(context, "co-1", {}, deps);

    assert.ok(result.success, "generation should succeed");
    const data = created();
    assert.ok(data, "post.create should have been called");
    assert.equal(data!.coreMessage, MOCK_CORE_MESSAGE);
    // The article was claimed, so it becomes the primary feed item.
    assert.equal(data!.primaryFeedItemId, "feed-1");
  });

  it("triggers a best-effort embedding of the post's coreMessage (Phase 1.2)", async () => {
    const { deps, embedded } = makeDeps();
    const context = makeContext({
      feedItems: [
        {
          id: "feed-1",
          title: "Launch incoming",
          content: "We are preparing something big for our audience.",
          url: "https://example.com/launch",
          publishedAt: null,
        },
      ],
      hasContentSources: true,
    });

    const result = await generatePostFromContext(context, "co-1", {}, deps);

    assert.ok(result.success, "generation should succeed");
    const embed = embedded();
    assert.ok(embed, "embed should have been called");
    assert.equal(embed!.postId, "post-1");
    assert.equal(embed!.companyId, "co-1");
    assert.equal(embed!.channel, "linkedin");
    assert.equal(embed!.coreMessage, MOCK_CORE_MESSAGE);
  });

  it("persists coreMessage for a mission post (no content sources)", async () => {
    const { deps, created } = makeDeps();
    const context = makeContext({ feedItems: [], hasContentSources: false });

    const result = await generatePostFromContext(context, "co-1", {}, deps);

    assert.ok(result.success, "mission generation should succeed");
    const data = created();
    assert.equal(data!.coreMessage, MOCK_CORE_MESSAGE);
    // Mission posts have no source article.
    assert.equal(data!.primaryFeedItemId, null);
  });

  it("still mirrors coreMessage inside promptSnapshot", async () => {
    const { deps, created } = makeDeps();
    const result = await generatePostFromContext(context(), "co-1", {}, deps);

    assert.ok(result.success);
    const snapshot = created()!.promptSnapshot as Record<string, unknown>;
    assert.equal(snapshot.coreMessage, MOCK_CORE_MESSAGE);
  });

  it("supports legacy recent posts whose promptSnapshot has no coreMessage", async () => {
    // Existing rows predating this column have a null coreMessage and their
    // snapshots lack the field. Generation must still succeed against them.
    const legacyRows: RecentRow[] = [
      {
        id: "old-1",
        content: "An older post from before Phase 1.1.",
        promptSnapshot: { topic: "x" },
      },
      { id: "old-2", content: "Another legacy post.", promptSnapshot: null },
    ];
    const { deps, created } = makeDeps(legacyRows);

    const result = await generatePostFromContext(context(), "co-1", {}, deps);

    assert.ok(result.success, "generation should tolerate legacy null coreMessage rows");
    assert.equal(created()!.coreMessage, MOCK_CORE_MESSAGE);
  });
});

// ─── Semantic duplicate gate (Phase 1.4) ──────────────────────────────────────

describe("generatePostFromContext — semantic duplicate gate", () => {
  let prevMockMode: string | undefined;

  before(() => {
    prevMockMode = process.env.AI_MOCK_MODE;
    process.env.AI_MOCK_MODE = "true";
  });

  after(() => {
    if (prevMockMode === undefined) delete process.env.AI_MOCK_MODE;
    else process.env.AI_MOCK_MODE = prevMockMode;
  });

  const regenerateGate: SemanticGate = async () => ({
    decision: "regenerate",
    topSimilarity: 0.93,
    matchedPostId: "dup-1",
    matchedCoreMessage: "A previously used central claim.",
    skipped: false,
  });

  it("forces pending approval and warns when all attempts stay too similar (even fully automated)", async () => {
    const { deps, created } = makeDeps([], regenerateGate);
    // Fully automated draft would normally auto-approve; the semantic gate must override that.
    const ctx = makeContext({
      company: {
        name: "Acme",
        website: null,
        automationMode: "fully_automated",
        defaultLang: "en",
      },
    });

    const result = await generatePostFromContext(ctx, "co-1", { initialStatus: "draft" }, deps);
    assert.ok(result.success, "generation should still succeed (fail-safe save)");

    const data = created()!;
    assert.equal(data.status, "pending_approval", "must be held for human review");
    assert.equal(data.approvedAt ?? null, null, "must not be auto-approved");

    const snapshot = data.promptSnapshot as Record<string, unknown>;
    const guards = snapshot.qualityGuards as Record<string, Record<string, unknown>>;
    assert.equal(guards.semanticDuplicate.warning, true);
    assert.equal(guards.semanticDuplicate.decision, "regenerate");

    const gate = snapshot.semanticGate as Record<string, unknown>;
    assert.equal(gate.decision, "regenerate");
    assert.equal(gate.matchedPostId, "dup-1");
    assert.equal(gate.attempts, 3, "should have exhausted all attempts");
    assert.equal(gate.skipped, false);

    if (result.success) {
      assert.equal(result.warnings.semanticDuplicate.exhausted, true);
    }
  });

  it("records diagnostics and does not force pending when the gate is skipped (fail open)", async () => {
    const skippedGate: SemanticGate = async () => ({
      decision: "accept",
      topSimilarity: null,
      matchedPostId: null,
      matchedCoreMessage: null,
      skipped: true,
    });
    const { deps, created } = makeDeps([], skippedGate);
    const ctx = makeContext({
      company: {
        name: "Acme",
        website: null,
        automationMode: "fully_automated",
        defaultLang: "en",
      },
    });

    const result = await generatePostFromContext(ctx, "co-1", { initialStatus: "draft" }, deps);
    assert.ok(result.success);

    const data = created()!;
    // Fail-open: not a semantic duplicate → normal auto-approval proceeds.
    assert.equal(data.status, "approved");
    const snapshot = data.promptSnapshot as Record<string, unknown>;
    const gate = snapshot.semanticGate as Record<string, unknown>;
    assert.equal(gate.skipped, true);
    assert.equal(gate.decision, "accept");
  });
});

// Type-level guard: the column is nullable, so legacy rows may omit/null it.
const _nullableCoreMessage: Prisma.PostUncheckedCreateInput["coreMessage"] = null;
void _nullableCoreMessage;

function context(): GenerationContext {
  return makeContext();
}
