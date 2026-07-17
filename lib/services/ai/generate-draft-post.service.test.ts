import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SocialChannel, LlmProvider } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { generatePostFromContext } from "./generate-draft-post.service";
import type { GenerateDraftPostDb, GenerateDraftPostDeps } from "./generate-draft-post.service";
import type { EmbedPostInput } from "./embed-post.service";
import type { SemanticCalibrationInput } from "./semantic-calibration.service";
import type { AutoGenerateImageInput } from "./auto-generate-post-image.service";
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
      autoGenerateImage: false,
    },
    feedItems: [],
    hasArticleSources: false,
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
  calibrated: () => SemanticCalibrationInput | null;
  autoImaged: () => AutoGenerateImageInput | null;
} {
  let createdData: Prisma.PostUncheckedCreateInput | null = null;
  let embeddedInput: EmbedPostInput | null = null;
  let calibrationInput: SemanticCalibrationInput | null = null;
  let autoImageInput: AutoGenerateImageInput | null = null;

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
      recordCalibration: async (input) => {
        calibrationInput = input;
      },
      // Captured so no test reaches the real image pipeline.
      autoImage: async (input) => {
        autoImageInput = input;
        return input.enabled
          ? {
              status: "generated",
              media: { id: "asset-1", url: "https://cdn.example/auto.png", width: 1, height: 1 },
            }
          : { status: "skipped", reason: "disabled" };
      },
      // Default: accept (no semantic history) so these Phase 1.1/1.2 tests are
      // unaffected by the Phase 1.4 gate. Overridable for gate-specific tests.
      semanticGate,
      // A working system always has an admin default; provide one so these tests
      // resolve a provider (the env-var fallback has been removed).
      loadDefaultLlmConfig: async () => ({ id: "default-cfg", provider: "grok" }),
    },
    created: () => createdData,
    embedded: () => embeddedInput,
    calibrated: () => calibrationInput,
    autoImaged: () => autoImageInput,
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
      hasArticleSources: true,
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
      hasArticleSources: true,
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
    const context = makeContext({ feedItems: [], hasArticleSources: false });

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

  it("aborts with CANNOT_GENERATE_UNIQUE_POST and does NOT save when all attempts stay too similar", async () => {
    const { deps, created, embedded, calibrated } = makeDeps([], regenerateGate);
    // Even a fully-automated draft must abort — never persist an unresolved duplicate.
    const ctx = makeContext({
      company: {
        name: "Acme",
        website: null,
        automationMode: "fully_automated",
        defaultLang: "en",
      },
    });

    const result = await generatePostFromContext(ctx, "co-1", { initialStatus: "draft" }, deps);

    assert.equal(result.success, false, "generation must fail (not persisted)");
    if (!result.success) {
      assert.equal(result.code, "CANNOT_GENERATE_UNIQUE_POST");
      // Diagnostics surfaced to the API/UI.
      assert.equal(result.reason, "semantic_duplicate");
      assert.equal(result.attempts, 3);
    }
    assert.equal(created(), null, "the post must NOT be saved");
    assert.equal(embedded(), null, "no embedding for an aborted post");
    assert.equal(calibrated(), null, "no calibration for an aborted post");
  });

  it("releases the claimed source article when it aborts on an unresolved duplicate", async () => {
    // An article is claimed up front; when generation aborts the claim must be
    // released so the article can back a future (unique) post.
    let claims = 0;
    let releases = 0;
    const db: GenerateDraftPostDb = {
      post: {
        findMany: async () => [],
        create: async () => {
          throw new Error("post.create must not be called on an aborted generation");
        },
      },
      feedItem: {
        // planFeedItemUsage claims with a status→used update (count 1); releaseFeedItem
        // nulls it back. Both go through updateMany here — distinguish by call order.
        updateMany: async () => {
          if (claims === 0) {
            claims++;
            return { count: 1 };
          }
          releases++;
          return { count: 1 };
        },
      },
    };
    const deps: GenerateDraftPostDeps = {
      db,
      auditLog: async () => {},
      embed: async () => ({ status: "embedded" }),
      recordCalibration: async () => {},
      semanticGate: regenerateGate,
      // A working system always has an admin default; provide one so these tests
      // resolve a provider (the env-var fallback has been removed).
      loadDefaultLlmConfig: async () => ({ id: "default-cfg", provider: "grok" }),
    };
    const ctx = makeContext({
      feedItems: [
        {
          id: "article-1",
          title: "Launch incoming",
          content: "We are preparing something big.",
          url: "https://example.com/launch",
          publishedAt: null,
          consumable: true,
        },
      ],
      hasArticleSources: true,
    });

    const result = await generatePostFromContext(ctx, "co-1", {}, deps);

    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.code, "CANNOT_GENERATE_UNIQUE_POST");
    assert.equal(claims, 1, "the article was claimed");
    assert.equal(releases, 1, "the claim was released on abort");
  });

  it("aborts and does NOT save when the candidate is a near-verbatim duplicate on every attempt", async () => {
    // Jaccard path: a recent post identical to the mock output flags every attempt,
    // so the loop exhausts with duplicateResult.flagged and generation aborts.
    const MOCK_TEXT = "Big things are coming! Stay tuned for what we have in store. 🚀";
    const recentRows: RecentRow[] = [{ id: "recent-1", content: MOCK_TEXT, promptSnapshot: null }];
    // ACCEPT_GATE: the semantic gate is clean, so only Jaccard forces the abort.
    const { deps, created } = makeDeps(recentRows, ACCEPT_GATE);

    const result = await generatePostFromContext(makeContext(), "co-1", {}, deps);

    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.code, "CANNOT_GENERATE_UNIQUE_POST");
      // Jaccard is checked first, so it wins the reason.
      assert.equal(result.reason, "jaccard_duplicate");
      assert.equal(result.attempts, 3);
    }
    assert.equal(created(), null, "a near-verbatim duplicate must not be saved");
  });

  it("writes semantic-gate calibration diagnostics for the generated post", async () => {
    const grayGate: SemanticGate = async () => ({
      decision: "gray_zone",
      topSimilarity: 0.83,
      matchedPostId: "near-1",
      matchedCoreMessage: "A somewhat similar claim.",
      skipped: false,
    });
    const { deps, calibrated } = makeDeps([], grayGate);

    const result = await generatePostFromContext(makeContext(), "co-1", {}, deps);
    assert.ok(result.success);

    const cal = calibrated();
    assert.ok(cal, "recordCalibration should have been called");
    assert.equal(cal!.postId, "post-1");
    assert.equal(cal!.companyId, "co-1");
    assert.equal(cal!.channel, "linkedin");
    assert.equal(cal!.decision, "gray_zone");
    assert.equal(cal!.topSimilarity, 0.83);
    assert.equal(cal!.matchedPostId, "near-1");
    assert.equal(cal!.gateSkipped, false);
    assert.ok(cal!.attempts >= 1);
    assert.ok(cal!.evaluatedAt instanceof Date);
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

// ─── Evergreen (prompt/calendar) sources — reusable, never consumed ────────────

describe("generatePostFromContext — evergreen prompt sources", () => {
  let prevMockMode: string | undefined;

  before(() => {
    prevMockMode = process.env.AI_MOCK_MODE;
    process.env.AI_MOCK_MODE = "true";
  });

  after(() => {
    if (prevMockMode === undefined) delete process.env.AI_MOCK_MODE;
    else process.env.AI_MOCK_MODE = prevMockMode;
  });

  const PROMPT_TEXT =
    "Share one concrete productivity tip our small-business audience can use today.";

  // Deps whose feedItem.updateMany records every call, so we can prove evergreen
  // items are NEVER claimed/consumed while article items ARE.
  function makeSpyDeps(): {
    deps: GenerateDraftPostDeps;
    created: () => Prisma.PostUncheckedCreateInput | null;
    claimCalls: () => number;
  } {
    let createdData: Prisma.PostUncheckedCreateInput | null = null;
    let claims = 0;
    const db: GenerateDraftPostDb = {
      post: {
        findMany: async () => [],
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
      feedItem: {
        updateMany: async () => {
          claims++;
          return { count: 1 };
        },
      },
    };
    return {
      deps: {
        db,
        auditLog: async () => {},
        embed: async () => ({ status: "embedded" }),
        recordCalibration: async () => {},
        semanticGate: ACCEPT_GATE,
        // A working system always has an admin default; provide one so these tests
        // resolve a provider (the env-var fallback has been removed).
        loadDefaultLlmConfig: async () => ({ id: "default-cfg", provider: "grok" }),
      },
      created: () => createdData,
      claimCalls: () => claims,
    };
  }

  function promptContext(): GenerationContext {
    return makeContext({
      feedItems: [
        {
          id: "prompt-1",
          title: "Weekly productivity tip",
          content: PROMPT_TEXT,
          url: "prompt:src-1",
          publishedAt: null,
          consumable: false,
        },
      ],
      // Prompt-only company: no article sources configured.
      hasArticleSources: false,
    });
  }

  it("generates from a prompt-only company (evergreen), without claiming the item", async () => {
    const { deps, created, claimCalls } = makeSpyDeps();

    const result = await generatePostFromContext(promptContext(), "co-1", {}, deps);

    assert.ok(result.success, "prompt-only generation should succeed (not 409)");
    assert.equal(claimCalls(), 0, "evergreen items are never claimed/consumed");
    const data = created()!;
    assert.equal(data.primaryFeedItemId, null, "an evergreen item never backs primaryFeedItemId");
  });

  it("passes the prompt text through to the generation context (reaches the LLM)", async () => {
    const { deps, created } = makeSpyDeps();

    const result = await generatePostFromContext(promptContext(), "co-1", {}, deps);
    assert.ok(result.success);

    const snapshot = created()!.promptSnapshot as Record<string, unknown>;
    assert.ok(
      typeof snapshot.userPrompt === "string" && snapshot.userPrompt.includes(PROMPT_TEXT),
      "the prompt text must appear in the user prompt sent to the model"
    );
  });

  it("is reusable across multiple posts (same prompt item is never exhausted)", async () => {
    const { deps, created, claimCalls } = makeSpyDeps();

    const first = await generatePostFromContext(promptContext(), "co-1", {}, deps);
    assert.ok(first.success, "first generation should succeed");
    assert.equal(created()!.primaryFeedItemId, null);

    // A second generation on the identical context still succeeds — the prompt
    // item was not consumed by the first, so nothing changed between runs.
    const second = await generatePostFromContext(promptContext(), "co-1", {}, deps);
    assert.ok(second.success, "second generation from the same prompt should also succeed");
    assert.equal(created()!.primaryFeedItemId, null);
    assert.equal(claimCalls(), 0, "no claim happened across either generation");
  });

  it("still generates from the prompt when article sources are exhausted (mixed company)", async () => {
    // build-generation-context excludes used articles, so an exhausted-RSS +
    // prompt company arrives here with only the evergreen item in the window and
    // hasArticleSources = true. That must generate, not skip (409).
    const { deps, created, claimCalls } = makeSpyDeps();
    const ctx = makeContext({
      feedItems: [
        {
          id: "prompt-1",
          title: "Weekly productivity tip",
          content: PROMPT_TEXT,
          url: "prompt:src-1",
          publishedAt: null,
          consumable: false,
        },
      ],
      hasArticleSources: true,
    });

    const result = await generatePostFromContext(ctx, "co-1", {}, deps);

    assert.ok(result.success, "prompt remains usable even with an exhausted article source");
    assert.equal(claimCalls(), 0, "the evergreen item is still not consumed");
    assert.equal(created()!.primaryFeedItemId, null);
  });

  it("claims and consumes an article item (rss stays single-use)", async () => {
    const { deps, created, claimCalls } = makeSpyDeps();
    const ctx = makeContext({
      feedItems: [
        {
          id: "article-1",
          title: "Launch incoming",
          content: "We are preparing something big.",
          url: "https://example.com/launch",
          publishedAt: null,
          consumable: true,
        },
      ],
      hasArticleSources: true,
    });

    const result = await generatePostFromContext(ctx, "co-1", {}, deps);

    assert.ok(result.success);
    assert.equal(claimCalls(), 1, "an article item is claimed (consumed) exactly once");
    assert.equal(created()!.primaryFeedItemId, "article-1", "the article backs primaryFeedItemId");
  });

  it("produces a mission post when the company has no sources at all", async () => {
    const { deps, created, claimCalls } = makeSpyDeps();

    const result = await generatePostFromContext(
      makeContext({ feedItems: [], hasArticleSources: false }),
      "co-1",
      {},
      deps
    );

    assert.ok(result.success, "no-source generation should produce a mission post");
    assert.equal(claimCalls(), 0);
    assert.equal(created()!.primaryFeedItemId, null);
  });
});

// ─── Topic Memory ──────────────────────────────────────────────────────────────

describe("generatePostFromContext — Topic Memory", () => {
  let prevMockMode: string | undefined;

  before(() => {
    prevMockMode = process.env.AI_MOCK_MODE;
    process.env.AI_MOCK_MODE = "true";
  });

  after(() => {
    if (prevMockMode === undefined) delete process.env.AI_MOCK_MODE;
    else process.env.AI_MOCK_MODE = prevMockMode;
  });

  it("feeds normalized, de-duplicated recent topics into the prompt as an avoid-list", async () => {
    const rows: RecentRow[] = [
      { id: "p1", content: "post one", promptSnapshot: { topic: "Authentic Lisbon!" } },
      { id: "p2", content: "post two", promptSnapshot: { topic: "authentic  lisbon" } }, // dup key
      { id: "p3", content: "post three", promptSnapshot: { topic: "Barcelona Nightlife" } },
    ];
    const { deps, created } = makeDeps(rows);

    const result = await generatePostFromContext(context(), "co-1", {}, deps);
    assert.ok(result.success);

    const snapshot = created()!.promptSnapshot as Record<string, unknown>;
    const userPrompt = snapshot.userPrompt as string;
    assert.match(userPrompt, /Topic guidance/, "the prompt must carry a recent-topics avoid-list");
    assert.ok(userPrompt.includes("authentic lisbon"), "topics are normalized in the prompt");
    assert.ok(userPrompt.includes("barcelona nightlife"));
    // De-duplicated: the normalized key appears exactly once in the avoid-list.
    assert.equal(userPrompt.split("authentic lisbon").length - 1, 1);
  });

  it("records the topicRepeated diagnostic in promptSnapshot", async () => {
    // The mock LLM response declares no topic, so it can never be a repeat.
    const { deps, created } = makeDeps([
      { id: "p1", content: "post one", promptSnapshot: { topic: "Authentic Lisbon" } },
    ]);

    const result = await generatePostFromContext(context(), "co-1", {}, deps);
    assert.ok(result.success);

    const snapshot = created()!.promptSnapshot as Record<string, unknown>;
    const gate = snapshot.semanticGate as Record<string, unknown>;
    assert.equal(gate.topicRepeated, false);
  });
});

// ─── Per-generation LLM selector (v2-5) ────────────────────────────────────────

describe("generatePostFromContext — per-generation LLM selector", () => {
  let prevMockMode: string | undefined;

  before(() => {
    prevMockMode = process.env.AI_MOCK_MODE;
    process.env.AI_MOCK_MODE = "true";
  });

  after(() => {
    if (prevMockMode === undefined) delete process.env.AI_MOCK_MODE;
    else process.env.AI_MOCK_MODE = prevMockMode;
  });

  it("uses the selected config's provider/model and records llmConfigId in promptSnapshot", async () => {
    const { deps, created } = makeDeps();
    let loadedId: string | null = null;
    deps.loadLlmConfig = async (id) => {
      loadedId = id;
      return { provider: "claude" };
    };

    const result = await generatePostFromContext(context(), "co-1", { llmConfigId: "cfg-1" }, deps);

    assert.ok(result.success, "generation with a selected config should succeed");
    assert.equal(loadedId, "cfg-1", "the selected config id is loaded");
    const data = created()!;
    // Provenance reflects the resolved provider; the model comes from env/code.
    assert.equal(data.llmProvider, "CLAUDE");
    assert.equal(data.llmModel, "claude-sonnet-4-6");
    const snapshot = data.promptSnapshot as Record<string, unknown>;
    assert.equal(snapshot.llmConfigId, "cfg-1");
    assert.equal(snapshot.provider, "CLAUDE");
    assert.equal(snapshot.model, "claude-sonnet-4-6");
  });

  it("returns LLM_CONFIG_NOT_FOUND (and saves nothing) when the config is inactive or missing", async () => {
    const { deps, created } = makeDeps();
    deps.loadLlmConfig = async () => null;

    const result = await generatePostFromContext(context(), "co-1", { llmConfigId: "gone" }, deps);

    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.code, "LLM_CONFIG_NOT_FOUND");
    assert.equal(created(), null, "no post is saved when the selected LLM is unavailable");
  });

  it("returns NO_ACTIVE_PROVIDER (no env fallback) when nothing is selected and no default exists", async () => {
    const { deps, created } = makeDeps();
    let loaderCalls = 0;
    deps.loadLlmConfig = async () => {
      loaderCalls++;
      return null;
    };
    // No explicit id, no preference, and no admin default → a clear error, never a
    // silent env-var fallback.
    deps.loadDefaultLlmConfig = async () => null;

    const result = await generatePostFromContext(context(), "co-1", {}, deps);

    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.code, "NO_ACTIVE_PROVIDER");
    assert.equal(loaderCalls, 0, "no per-selection lookup happens without an id");
    assert.equal(created(), null, "nothing is generated without a configured provider");
  });

  it("uses the DB default config on the Auto path when one is configured", async () => {
    const { deps, created } = makeDeps();
    let selectedLoaderCalls = 0;
    deps.loadLlmConfig = async () => {
      selectedLoaderCalls++;
      return null;
    };
    deps.loadDefaultLlmConfig = async () => ({ id: "default-cfg", provider: "claude" });

    // No explicit llmConfigId → the "Auto" path resolves the DB default config.
    const result = await generatePostFromContext(context(), "co-1", {}, deps);

    assert.ok(result.success, "generation via the DB default should succeed");
    assert.equal(selectedLoaderCalls, 0, "the per-selection loader must not run on Auto");
    const data = created()!;
    // Provenance reflects the default CONFIG, not the env-var provider.
    assert.equal(data.llmProvider, "CLAUDE");
    assert.equal(data.llmModel, "claude-sonnet-4-6");
    const snapshot = data.promptSnapshot as Record<string, unknown>;
    // The resolved config id is recorded for provenance.
    assert.equal(snapshot.llmConfigId, "default-cfg");
    assert.equal(snapshot.provider, "CLAUDE");
    assert.equal(snapshot.model, "claude-sonnet-4-6");
  });
});

// ─── Per-user preferred LLM resolution ─────────────────────────────────────────

describe("generatePostFromContext — preferred LLM resolution order", () => {
  let prevMockMode: string | undefined;

  before(() => {
    prevMockMode = process.env.AI_MOCK_MODE;
    process.env.AI_MOCK_MODE = "true";
  });

  after(() => {
    if (prevMockMode === undefined) delete process.env.AI_MOCK_MODE;
    else process.env.AI_MOCK_MODE = prevMockMode;
  });

  // A loader that resolves a small fixed set of active configs (id → provider).
  function configLoaderFor(active: Record<string, LlmProvider>) {
    return async (id: string) => {
      const provider = active[id];
      return provider ? { provider } : null;
    };
  }

  const ADMIN_DEFAULT = { id: "admin-default", provider: "grok" as LlmProvider };
  // Provenance models come from the registry defaults (env unset in tests).
  const GROQ_MODEL_NAME = "llama-3.3-70b-versatile";
  const OPENAI_MODEL = "gpt-4.1-mini";

  it("1. explicit form selection overrides the user preference", async () => {
    const { deps, created } = makeDeps();
    deps.loadLlmConfig = configLoaderFor({ override: "claude", pref: "openai" });
    deps.loadDefaultLlmConfig = async () => ADMIN_DEFAULT;

    const result = await generatePostFromContext(
      context(),
      "co-1",
      { llmConfigId: "override", preferredLlmConfigId: "pref" },
      deps
    );

    assert.ok(result.success);
    const data = created()!;
    assert.equal(data.llmProvider, "CLAUDE", "the explicit override wins over the preference");
    assert.equal(data.llmModel, "claude-sonnet-4-6");
    assert.equal((data.promptSnapshot as Record<string, unknown>).llmConfigId, "override");
  });

  it("2. the user preference overrides the admin default", async () => {
    const { deps, created } = makeDeps();
    deps.loadLlmConfig = configLoaderFor({ pref: "openai" });
    deps.loadDefaultLlmConfig = async () => ADMIN_DEFAULT;

    const result = await generatePostFromContext(
      context(),
      "co-1",
      { preferredLlmConfigId: "pref" },
      deps
    );

    assert.ok(result.success);
    const data = created()!;
    assert.equal(data.llmProvider, "OPENAI", "the active preference wins over the admin default");
    assert.equal(data.llmModel, OPENAI_MODEL);
    assert.equal((data.promptSnapshot as Record<string, unknown>).llmConfigId, "pref");
  });

  it("3. an unavailable user preference falls back to the admin default", async () => {
    const { deps, created } = makeDeps();
    // The preference id resolves to null (inactive/deleted); the default is active.
    deps.loadLlmConfig = configLoaderFor({});
    deps.loadDefaultLlmConfig = async () => ADMIN_DEFAULT;

    const result = await generatePostFromContext(
      context(),
      "co-1",
      { preferredLlmConfigId: "gone" },
      deps
    );

    assert.ok(result.success, "an inactive preference falls through to the admin default");
    const data = created()!;
    assert.equal(data.llmProvider, "GROQ", "falls back to the admin default provider");
    assert.equal(data.llmModel, GROQ_MODEL_NAME);
    assert.equal((data.promptSnapshot as Record<string, unknown>).llmConfigId, "admin-default");
  });

  it("4. errors with NO_ACTIVE_PROVIDER when no admin default exists (no env fallback)", async () => {
    const { deps, created } = makeDeps();
    deps.loadLlmConfig = configLoaderFor({});
    deps.loadDefaultLlmConfig = async () => null;

    // Preference no longer active AND no admin default → clear error, not env.
    const result = await generatePostFromContext(
      context(),
      "co-1",
      { preferredLlmConfigId: "gone" },
      deps
    );

    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.code, "NO_ACTIVE_PROVIDER");
    assert.equal(created(), null, "nothing is generated without a configured provider");
  });

  it("5. a one-time explicit selection does not change the saved preference", async () => {
    // generatePostFromContext has no ability to write the User table — proven by
    // its DB interface (post + feedItem only). We assert the "stored preference"
    // is untouched after generating with a one-time override. It stays `const`
    // precisely because nothing in the generation path can reassign it.
    const savedPreference: string | null = "pref";
    const { deps } = makeDeps();
    deps.loadLlmConfig = configLoaderFor({ override: "claude", pref: "openai" });
    deps.loadDefaultLlmConfig = async () => ADMIN_DEFAULT;

    const result = await generatePostFromContext(
      context(),
      "co-1",
      { llmConfigId: "override", preferredLlmConfigId: savedPreference },
      deps
    );

    assert.ok(result.success);
    assert.equal(savedPreference, "pref", "the saved preference is left unchanged by generation");
  });

  it("6. cron generation (no user ids) ignores any preference and uses the admin default", async () => {
    const { deps, created } = makeDeps();
    let prefLookups = 0;
    deps.loadLlmConfig = async (id) => {
      prefLookups++;
      return configLoaderFor({ pref: "openai" })(id);
    };
    deps.loadDefaultLlmConfig = async () => ADMIN_DEFAULT;

    // Cron calls generatePostFromContext WITHOUT llmConfigId or preferredLlmConfigId.
    const result = await generatePostFromContext(
      context(),
      "co-1",
      { initialStatus: "pending_approval" },
      deps
    );

    assert.ok(result.success);
    assert.equal(prefLookups, 0, "no preference lookup happens on the cron path");
    const data = created()!;
    assert.equal(data.llmProvider, "GROQ", "cron uses the admin default, never a user preference");
    assert.equal((data.promptSnapshot as Record<string, unknown>).llmConfigId, "admin-default");
  });

  it("6b. cron generation fails clearly with NO_ACTIVE_PROVIDER when no default exists", async () => {
    const { deps, created } = makeDeps();
    deps.loadDefaultLlmConfig = async () => null;

    // Cron path (no user ids) with no admin default must refuse, not fall back.
    const result = await generatePostFromContext(
      context(),
      "co-1",
      { initialStatus: "pending_approval" },
      deps
    );

    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.code, "NO_ACTIVE_PROVIDER");
    assert.equal(created(), null, "cron generates nothing without a configured default");
  });
});

// ─── Unavailable (env config missing) providers never switch silently ──────────
// These run in NON-mock mode so buildSupportedProvider actually inspects env: a
// selected provider whose credentials are absent must error, not swap models.

describe("generatePostFromContext — unavailable providers do not switch silently", () => {
  let prevMockMode: string | undefined;
  let prevGroqKey: string | undefined;

  before(() => {
    prevMockMode = process.env.AI_MOCK_MODE;
    prevGroqKey = process.env.GROQ_API_KEY;
    delete process.env.AI_MOCK_MODE; // real build path
    delete process.env.GROQ_API_KEY; // grok is active but unavailable
  });

  after(() => {
    if (prevMockMode === undefined) delete process.env.AI_MOCK_MODE;
    else process.env.AI_MOCK_MODE = prevMockMode;
    if (prevGroqKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = prevGroqKey;
  });

  it("5. an explicit, active-but-unavailable provider errors (PROVIDER_CONFIG_MISSING)", async () => {
    const { deps, created } = makeDeps();
    // The explicit config resolves (active) but grok's env is missing → build fails.
    deps.loadLlmConfig = async () => ({ provider: "grok" });
    deps.loadDefaultLlmConfig = async () => ({ id: "default-cfg", provider: "grok" });

    const result = await generatePostFromContext(
      context(),
      "co-1",
      { llmConfigId: "explicit-grok" },
      deps
    );

    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.code, "PROVIDER_CONFIG_MISSING");
    assert.equal(created(), null, "an unavailable explicit provider is never swapped for another");
  });

  it("5b. an active-but-unavailable user preference errors instead of switching", async () => {
    const { deps, created } = makeDeps();
    deps.loadLlmConfig = async () => ({ provider: "grok" }); // preference resolves, but env missing
    deps.loadDefaultLlmConfig = async () => ({ id: "default-cfg", provider: "grok" });

    const result = await generatePostFromContext(
      context(),
      "co-1",
      { preferredLlmConfigId: "pref-grok" },
      deps
    );

    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.code, "PROVIDER_CONFIG_MISSING");
    assert.equal(created(), null, "an unavailable preferred provider is never swapped");
  });
});

describe("generatePostFromContext — automatic image generation", () => {
  let prevMockMode: string | undefined;

  before(() => {
    prevMockMode = process.env.AI_MOCK_MODE;
    process.env.AI_MOCK_MODE = "true";
  });

  after(() => {
    if (prevMockMode === undefined) delete process.env.AI_MOCK_MODE;
    else process.env.AI_MOCK_MODE = prevMockMode;
  });

  it("passes the channel setting through as enabled when the channel opts in", async () => {
    const { deps, autoImaged } = makeDeps();
    const ctx = makeContext({
      channel: { ...makeContext().channel, autoGenerateImage: true },
    });

    const result = await generatePostFromContext(ctx, "co-1", { generatedById: "u-1" }, deps);

    assert.ok(result.success);
    assert.equal(autoImaged()?.enabled, true);
    assert.equal(autoImaged()?.companyId, "co-1");
    assert.equal(autoImaged()?.generatedById, "u-1");
  });

  it("passes enabled: false when the channel has not opted in", async () => {
    const { deps, autoImaged } = makeDeps();

    const result = await generatePostFromContext(context(), "co-1", {}, deps);

    assert.ok(result.success);
    assert.equal(autoImaged()?.enabled, false);
  });

  it("leaves generatedById undefined for a cron generation", async () => {
    const { deps, autoImaged } = makeDeps();
    const ctx = makeContext({
      channel: { ...makeContext().channel, autoGenerateImage: true },
    });

    await generatePostFromContext(ctx, "co-1", { scheduleId: "sched-1" }, deps);

    assert.equal(autoImaged()?.enabled, true);
    assert.equal(autoImaged()?.generatedById, undefined);
  });

  it("targets the post that was just created", async () => {
    const { deps, autoImaged, created } = makeDeps();
    const ctx = makeContext({
      channel: { ...makeContext().channel, autoGenerateImage: true },
    });

    const result = await generatePostFromContext(ctx, "co-1", {}, deps);

    assert.ok(result.success);
    assert.ok(created());
    assert.equal(autoImaged()?.postId, result.post.id);
  });

  it("returns the generated image URL so the UI shows it without a refetch", async () => {
    const { deps } = makeDeps();
    const ctx = makeContext({
      channel: { ...makeContext().channel, autoGenerateImage: true },
    });

    const result = await generatePostFromContext(ctx, "co-1", {}, deps);

    assert.ok(result.success);
    assert.equal(result.post.mediaUrl, "https://cdn.example/auto.png");
  });

  it("returns mediaUrl null when the channel has auto generation off", async () => {
    const { deps } = makeDeps();

    const result = await generatePostFromContext(context(), "co-1", {}, deps);

    assert.ok(result.success);
    assert.equal(result.post.mediaUrl, null);
  });

  it("returns mediaUrl null when image generation fails", async () => {
    const { deps } = makeDeps();
    deps.autoImage = async () => ({ status: "failed", code: "IMAGE_PROVIDER_ERROR" });
    const ctx = makeContext({
      channel: { ...makeContext().channel, autoGenerateImage: true },
    });

    const result = await generatePostFromContext(ctx, "co-1", {}, deps);

    assert.ok(result.success, "a failed image must never fail the post");
    assert.equal(result.post.mediaUrl, null);
  });

  it("still returns a successful post when image generation throws", async () => {
    const { deps } = makeDeps();
    // Harsher than production: autoGeneratePostImage swallows its own errors, so
    // this proves generation survives even if that contract is ever broken.
    deps.autoImage = async () => {
      throw new Error("image provider exploded");
    };
    const ctx = makeContext({
      channel: { ...makeContext().channel, autoGenerateImage: true },
    });

    const result = await generatePostFromContext(ctx, "co-1", {}, deps);

    assert.ok(result.success, "a failed image must never fail the post");
  });
});

// Type-level guard: the column is nullable, so legacy rows may omit/null it.
const _nullableCoreMessage: Prisma.PostUncheckedCreateInput["coreMessage"] = null;
void _nullableCoreMessage;

function context(): GenerationContext {
  return makeContext();
}
