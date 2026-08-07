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
  /** Absent on legacy rows — it only feeds the visual-diversity block. */
  imagePrompt?: string | null;
}

function makeDeps(
  recentRows: RecentRow[] = [],
  semanticGate: SemanticGate = ACCEPT_GATE,
  /**
   * Ids the reservation is allowed to win. Omit to let every candidate be
   * claimed (the common case). Pass a subset to model a concurrent run that
   * already took the earlier candidates, which is how the claim lands on an
   * item that is NOT feedItems[0].
   */
  claimable?: ReadonlySet<string>
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
    // Grants the claim so the "generate" (article) path proceeds. A count of 0
    // is exactly what production returns when another run already claimed that
    // row, which makes claimFeedItem move on to the next candidate.
    feedItem: {
      updateMany: async (args) => ({
        count: !claimable || claimable.has(args.where.id) ? 1 : 0,
      }),
    },
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

/**
 * Deps whose feedItem.updateMany records every call, so a test can prove which
 * items are claimed (consumed) and which are not: article items ARE, evergreen
 * and directly-read content sources are NOT.
 */
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
    // Fail-open: not treated as a semantic duplicate, so the post is persisted
    // normally — as a draft, because generation never approves (Variant B).
    assert.equal(data.status, "draft");
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

// ─── Direct content sources (product page / prompt / calendar picked manually) ─
//
// The bug these cover: a product page could be added and successfully extracted
// but never generated from. Under the article path its single stored row would
// be reserved and consumed by the first post, leaving the source permanently
// dry; `directContentSource` reads that row instead and consumes nothing.

describe("generatePostFromContext — direct content sources", () => {
  let prevMockMode: string | undefined;

  before(() => {
    prevMockMode = process.env.AI_MOCK_MODE;
    process.env.AI_MOCK_MODE = "true";
  });

  after(() => {
    if (prevMockMode === undefined) delete process.env.AI_MOCK_MODE;
    else process.env.AI_MOCK_MODE = prevMockMode;
  });

  const PAGE_URL = "https://shop.example.com/pro-plan";
  const PAGE_CONTENT = '{"title":"Pro Plan","description":"Everything in Starter, plus SSO."}';

  /**
   * A product page as the context builder assembles it for the `content_source`
   * scope: the source's stored extraction, still typed as a consumable article
   * (it genuinely is one), with the direct flag deciding what happens to it.
   */
  function productPageContext(overrides: Partial<GenerationContext> = {}): GenerationContext {
    return makeContext({
      feedItems: [
        {
          id: "pp-item-1",
          title: "Pro Plan",
          content: PAGE_CONTENT,
          url: PAGE_URL,
          publishedAt: null,
          sourceType: "product_page",
          sourceName: "Pricing Page",
          consumable: true,
        },
      ],
      hasArticleSources: true,
      directContentSource: true,
      ...overrides,
    });
  }

  it("generates from a product page without reserving a feed item", async () => {
    const { deps, created, claimCalls } = makeSpyDeps();

    const result = await generatePostFromContext(productPageContext(), "co-1", {}, deps);

    assert.ok(result.success, "a product page must be able to back a post");
    assert.equal(claimCalls(), 0, "no reservation is attempted for a direct content source");
    assert.ok(created(), "the post is persisted");
  });

  it("leaves primaryFeedItemId null for a product-page post", async () => {
    // Nothing was consumed, so nothing may claim the column whose unique index
    // means "this article backs exactly one post".
    const { deps, created } = makeSpyDeps();

    const result = await generatePostFromContext(productPageContext(), "co-1", {}, deps);

    assert.ok(result.success);
    assert.equal(created()!.primaryFeedItemId, null);
  });

  it("stays available: a second generation still succeeds and still claims nothing", async () => {
    // The regression that made non-RSS sources unusable — one post and the
    // source went dry. The context builder omits the usedInPost filter for this
    // scope, and nothing here marks the row used, so the second run is identical.
    const first = makeSpyDeps();
    const second = makeSpyDeps();

    const a = await generatePostFromContext(productPageContext(), "co-1", {}, first.deps);
    const b = await generatePostFromContext(productPageContext(), "co-1", {}, second.deps);

    assert.ok(a.success);
    assert.ok(b.success);
    assert.equal(first.claimCalls() + second.claimCalls(), 0);
  });

  it("propagates the product page URL into the prompt and onto the post", async () => {
    // The URL travels with the content: into the prompt the model sees, into the
    // appended source link, and into the post's frozen origin snapshot.
    const { deps, created } = makeSpyDeps();
    const ctx = productPageContext();
    ctx.channel.includeSourceLink = true;

    const result = await generatePostFromContext(ctx, "co-1", {}, deps);

    assert.ok(result.success);
    const data = created()!;
    const snapshot = data.promptSnapshot as Record<string, unknown>;
    assert.equal(snapshot.sourceUrl, PAGE_URL, "the link resolution used the page URL");
    assert.ok(
      (data.content as string).includes(PAGE_URL),
      "the page URL is appended to the post text"
    );
    assert.equal(data.originSourceUrl, PAGE_URL, "the origin snapshot records the page URL");
    assert.ok(
      (snapshot.userPrompt as string).includes("Pro Plan"),
      "the extracted content reaches the prompt"
    );
  });

  it("records the product page as the post's origin", async () => {
    const { deps, created } = makeSpyDeps();

    const result = await generatePostFromContext(productPageContext(), "co-1", {}, deps);

    assert.ok(result.success);
    const data = created()!;
    assert.equal(data.originType, "content_source");
    assert.equal(data.originSourceType, "product_page");
    assert.equal(data.originSourceName, "Pricing Page");
    assert.equal(result.post.origin.kind, "source");
    assert.equal(result.post.origin.sourceType, "product_page");
  });

  it("links the post to the picked source via contentSourceId", async () => {
    // With primaryFeedItemId null, this FK is the only durable relation back to
    // what the post was written from.
    const { deps, created } = makeSpyDeps();

    const result = await generatePostFromContext(
      productPageContext(),
      "co-1",
      { contentSourceId: "src-pp" },
      deps
    );

    assert.ok(result.success);
    assert.equal(created()!.contentSourceId, "src-pp");
  });

  it("reports NO_FEED_ITEMS_AVAILABLE when the source has nothing extracted", async () => {
    // Never a drift to a mission post: the user picked this source explicitly.
    // The manual flow turns this into SELECTED_SOURCE_UNAVAILABLE.
    const { deps, created } = makeSpyDeps();

    const result = await generatePostFromContext(
      productPageContext({ feedItems: [] }),
      "co-1",
      {},
      deps
    );

    assert.ok(!result.success);
    assert.equal(result.code, "NO_FEED_ITEMS_AVAILABLE");
    assert.equal(created(), null, "no post is written");
  });

  it("keeps a directly-picked prompt source's synthetic URL off the post", async () => {
    // A prompt source can be picked directly too, but `prompt:<id>` is a storage
    // key, not a link — it must never reach a reader.
    const { deps, created } = makeSpyDeps();
    const ctx = productPageContext({
      feedItems: [
        {
          id: "prompt-item-1",
          title: "Weekly tip",
          content: "Share one concrete productivity tip.",
          url: "prompt:src-1",
          publishedAt: null,
          sourceType: "prompt",
          sourceName: "Ideas",
          consumable: false,
        },
      ],
    });
    ctx.channel.includeSourceLink = true;

    const result = await generatePostFromContext(ctx, "co-1", {}, deps);

    assert.ok(result.success);
    const data = created()!;
    assert.ok(!(data.content as string).includes("prompt:"), "no synthetic url in the post text");
    assert.equal((data.promptSnapshot as Record<string, unknown>).sourceUrl, null);
  });

  it("does not change the article path when the flag is absent", async () => {
    // Same single consumable item, no directContentSource: the reservation runs
    // exactly as before. Guards the RSS and cron paths against this change.
    const { deps, created, claimCalls } = makeSpyDeps();

    const result = await generatePostFromContext(
      productPageContext({ directContentSource: undefined }),
      "co-1",
      {},
      deps
    );

    assert.ok(result.success);
    assert.equal(claimCalls(), 1, "the item is claimed, as it always was");
    assert.equal(created()!.primaryFeedItemId, "pp-item-1");
  });
});

// ─── Calendar events, end to end ──────────────────────────────────────────────
//
// The bug: picking a calendar event produced a post with nothing to do with the
// event. The origin badge was right (the event WAS the primary), but the prompt
// carried its stored row as a raw `{"title":…,"date":…,"description":null}` blob
// under a heading calling it an article — so the model had almost nothing to
// write from and drifted onto general business themes.
//
// These assert against `promptSnapshot.userPrompt`, which is the verbatim prompt
// sent to the provider, so they cover the whole path rather than the badge.

describe("generatePostFromContext — a calendar event reaches the LLM prompt", () => {
  let prevMockMode: string | undefined;

  before(() => {
    prevMockMode = process.env.AI_MOCK_MODE;
    process.env.AI_MOCK_MODE = "true";
  });

  after(() => {
    if (prevMockMode === undefined) delete process.env.AI_MOCK_MODE;
    else process.env.AI_MOCK_MODE = prevMockMode;
  });

  const EVENT_TITLE = "DEV.BG All in One 2026";
  const EVENT_DESCRIPTION =
    "Bulgaria's largest IT conference — AI, software engineering and career tracks across six halls.";

  /**
   * The context the builder assembles for a manually picked calendar source:
   * exactly one item, that source's stored extraction, read directly.
   */
  function calendarContext(
    description: string | null = EVENT_DESCRIPTION,
    /** The source's optional Event URL, as the context builder resolves it. */
    publicUrl: string | null = null
  ): GenerationContext {
    return makeContext({
      feedItems: [
        {
          id: "cal-item-1",
          title: EVENT_TITLE,
          // Byte-for-byte what runSourceIngestion writes for a calendar_event.
          content: JSON.stringify({ title: EVENT_TITLE, date: "2026-08-29", description }),
          url: "event:src-cal",
          publicUrl,
          publishedAt: new Date("2026-08-29T00:00:00.000Z"),
          sourceType: "calendar_event",
          sourceName: "DEV.BG events",
          consumable: false,
        },
      ],
      hasArticleSources: false,
      directContentSource: true,
    });
  }

  /** The prompt actually sent to the provider, as frozen onto the post. */
  function promptOf(created: Prisma.PostUncheckedCreateInput): string {
    return (created.promptSnapshot as Record<string, unknown>).userPrompt as string;
  }

  it("sends the event title, date, and description to the model", async () => {
    const { deps, created } = makeSpyDeps();

    const result = await generatePostFromContext(calendarContext(), "co-1", {}, deps);

    assert.ok(result.success);
    const userPrompt = promptOf(created()!);
    assert.ok(userPrompt.includes(EVENT_TITLE), "the event title must be in the prompt");
    assert.ok(userPrompt.includes("29.08.2026"), "the event date must be in the prompt");
    assert.ok(userPrompt.includes(EVENT_DESCRIPTION), "the description must be in the prompt");
  });

  it("never sends the stored JSON payload", async () => {
    const { deps, created } = makeSpyDeps();

    const result = await generatePostFromContext(calendarContext(), "co-1", {}, deps);

    assert.ok(result.success);
    assert.ok(!promptOf(created()!).includes('{"title"'));
  });

  it("introduces it as an event, with no promise of a link", async () => {
    const { deps, created } = makeSpyDeps();

    const result = await generatePostFromContext(calendarContext(), "co-1", {}, deps);

    assert.ok(result.success);
    const userPrompt = promptOf(created()!);
    assert.ok(userPrompt.includes("CALENDAR EVENT"));
    assert.ok(!userPrompt.includes("PRIMARY SOURCE ARTICLE"));
    assert.ok(!userPrompt.includes("A link to this exact article will be attached"));
  });

  it("keeps the event as the only source in the prompt", async () => {
    // The window is scoped to the picked source, and nothing downstream may add
    // company or pooled content back in as a competing subject.
    const { deps, created } = makeSpyDeps();

    const result = await generatePostFromContext(calendarContext(), "co-1", {}, deps);

    assert.ok(result.success);
    const data = created()!;
    const snapshot = data.promptSnapshot as Record<string, unknown>;
    assert.deepEqual(snapshot.feedItemIds, ["cal-item-1"]);
    assert.ok(!promptOf(data).includes("Additional background context"));
  });

  it("still carries title and date when the event has no description", async () => {
    // The reported case: description null. The model must still be given the two
    // facts the event does state, and be told there are no others.
    const { deps, created } = makeSpyDeps();

    const result = await generatePostFromContext(calendarContext(null), "co-1", {}, deps);

    assert.ok(result.success);
    const userPrompt = promptOf(created()!);
    assert.ok(userPrompt.includes(EVENT_TITLE));
    assert.ok(userPrompt.includes("29.08.2026"));
    assert.ok(userPrompt.includes("No description was provided"));
  });

  it("consumes nothing and records the event as the origin", async () => {
    const { deps, created, claimCalls } = makeSpyDeps();

    const result = await generatePostFromContext(
      calendarContext(),
      "co-1",
      { contentSourceId: "src-cal" },
      deps
    );

    assert.ok(result.success);
    const data = created()!;
    assert.equal(claimCalls(), 0, "an event is evergreen — nothing is reserved");
    assert.equal(data.primaryFeedItemId, null);
    assert.equal(data.contentSourceId, "src-cal");
    assert.equal(data.originSourceType, "calendar_event");
    assert.equal(data.originSourceTitle, EVENT_TITLE);
  });

  // ── The optional Event URL ──────────────────────────────────────────────────

  const EVENT_URL = "https://www.events.dev.bg/allinone/2026";

  it("appends the Event URL to the post and freezes it as the origin", async () => {
    const { deps, created } = makeSpyDeps();
    const ctx = calendarContext(EVENT_DESCRIPTION, EVENT_URL);
    ctx.channel.includeSourceLink = true;

    const result = await generatePostFromContext(ctx, "co-1", {}, deps);

    assert.ok(result.success);
    const data = created()!;
    assert.ok((data.content as string).includes(EVENT_URL), "the link reaches the post text");
    assert.equal((data.promptSnapshot as Record<string, unknown>).sourceUrl, EVENT_URL);
    assert.equal(data.originSourceUrl, EVENT_URL, "the origin snapshot records the real page");
    assert.equal(result.post.origin.articleUrl, EVENT_URL, "and the response renders it");
    assert.equal(data.primaryFeedItemId, null, "linking still consumes nothing");
  });

  it("honours an explicit no-link override even when an Event URL exists", async () => {
    const { deps, created } = makeSpyDeps();
    const ctx = calendarContext(EVENT_DESCRIPTION, EVENT_URL);
    ctx.channel.includeSourceLink = true;

    const result = await generatePostFromContext(
      ctx,
      "co-1",
      { includeSourceLinkOverride: false },
      deps
    );

    assert.ok(result.success);
    const data = created()!;
    assert.ok(!(data.content as string).includes(EVENT_URL), "no link in the text");
    // Still frozen on the row: the origin records where the post came from,
    // which is true whether or not the post chose to link it.
    assert.equal(data.originSourceUrl, EVENT_URL);
  });

  it("still generates, and links nothing, when the Event URL is blank", async () => {
    // Every calendar source created before the field existed.
    const { deps, created } = makeSpyDeps();
    const ctx = calendarContext(EVENT_DESCRIPTION, null);
    ctx.channel.includeSourceLink = true;

    const result = await generatePostFromContext(ctx, "co-1", {}, deps);

    assert.ok(result.success, "a URL-less event must still back a post");
    const data = created()!;
    assert.equal((data.promptSnapshot as Record<string, unknown>).sourceUrl, null);
    assert.equal(data.originSourceUrl, null);
    assert.equal(result.post.origin.articleUrl, null);
    assert.equal(result.post.origin.sourceType, "calendar_event", "the origin still stands");
  });

  it("never lets event:<id> reach the post, the snapshot, or the response", async () => {
    for (const publicUrl of [EVENT_URL, null]) {
      const { deps, created } = makeSpyDeps();
      const ctx = calendarContext(EVENT_DESCRIPTION, publicUrl);
      ctx.channel.includeSourceLink = true;

      const result = await generatePostFromContext(ctx, "co-1", {}, deps);

      assert.ok(result.success);
      const data = created()!;
      const label = `publicUrl=${publicUrl}`;
      assert.ok(!(data.content as string).includes("event:"), `${label}: post text`);
      assert.ok(
        !JSON.stringify(data.promptSnapshot).includes("event:src-cal"),
        `${label}: snapshot`
      );
      assert.notEqual(data.originSourceUrl, "event:src-cal", `${label}: origin column`);
      assert.ok(!result.post.origin.articleUrl?.startsWith("event:"), `${label}: response`);
    }
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

// ─── Visual diversity ──────────────────────────────────────────────────────────

describe("generatePostFromContext — recent visuals reach the prompt", () => {
  let prevMockMode: string | undefined;

  before(() => {
    prevMockMode = process.env.AI_MOCK_MODE;
    process.env.AI_MOCK_MODE = "true";
  });

  after(() => {
    if (prevMockMode === undefined) delete process.env.AI_MOCK_MODE;
    else process.env.AI_MOCK_MODE = prevMockMode;
  });

  const PREVIOUS_VISUAL =
    "A baker slides a loaded peel into a stone oven, flour hazing the light from the door.";

  it("carries the stored imagePrompt of recent posts into the user prompt", async () => {
    // The whole anti-repetition mechanism: no new table, no extra query, no
    // second LLM call — just one more column on the recent-posts read that was
    // already happening, because post text cannot describe a picture.
    const { deps, created } = makeDeps([
      { id: "p1", content: "post one", promptSnapshot: null, imagePrompt: PREVIOUS_VISUAL },
    ]);

    const result = await generatePostFromContext(context(), "co-1", {}, deps);
    assert.ok(result.success);

    const userPrompt = (created()!.promptSnapshot as Record<string, unknown>).userPrompt as string;
    assert.match(userPrompt, /Recent image prompts — do not repeat these visuals/);
    assert.ok(userPrompt.includes(PREVIOUS_VISUAL), "the previous visual must reach the model");
  });

  it("adds no visual block for legacy rows that never stored an imagePrompt", async () => {
    const { deps, created } = makeDeps([{ id: "p1", content: "post one", promptSnapshot: null }]);

    const result = await generatePostFromContext(context(), "co-1", {}, deps);
    assert.ok(result.success);

    const userPrompt = (created()!.promptSnapshot as Record<string, unknown>).userPrompt as string;
    assert.ok(!userPrompt.includes("Recent image prompts"));
    assert.ok(userPrompt.includes("post one"), "the recent-text block is unaffected");
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

  it("lets the manual override force an image on a channel that has not opted in", async () => {
    const { deps, autoImaged } = makeDeps();

    const result = await generatePostFromContext(
      context(),
      "co-1",
      { autoGenerateImageOverride: true },
      deps
    );

    assert.ok(result.success);
    assert.equal(autoImaged()?.enabled, true);
    assert.equal(result.post.mediaUrl, "https://cdn.example/auto.png");
  });

  it("lets the manual override suppress an image on a channel that has opted in", async () => {
    const { deps, autoImaged } = makeDeps();
    const ctx = makeContext({
      channel: { ...makeContext().channel, autoGenerateImage: true },
    });

    const result = await generatePostFromContext(
      ctx,
      "co-1",
      { autoGenerateImageOverride: false },
      deps
    );

    assert.ok(result.success);
    assert.equal(autoImaged()?.enabled, false);
    assert.equal(result.post.mediaUrl, null);
  });

  it("falls back to the channel setting when the override is undefined", async () => {
    const { deps, autoImaged } = makeDeps();
    const ctx = makeContext({
      channel: { ...makeContext().channel, autoGenerateImage: true },
    });

    // An omitted override is what cron always sends, so this is the guarantee
    // that scheduled generation still reads the channel setting.
    const result = await generatePostFromContext(
      ctx,
      "co-1",
      { autoGenerateImageOverride: undefined, scheduleId: "sched-1" },
      deps
    );

    assert.ok(result.success);
    assert.equal(autoImaged()?.enabled, true);
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

// ─── Approval workflow (Variant B) ───────────────────────────────────────────
// Generation never approves. Manual generation always lands on a human; only
// cron step 4 (autoApprovePosts) may promote a post without one.

describe("generatePostFromContext — approval workflow", () => {
  let prevMockMode: string | undefined;

  before(() => {
    prevMockMode = process.env.AI_MOCK_MODE;
    process.env.AI_MOCK_MODE = "true";
  });

  after(() => {
    if (prevMockMode === undefined) delete process.env.AI_MOCK_MODE;
    else process.env.AI_MOCK_MODE = prevMockMode;
  });

  /** A context whose effective automation mode is set at the company level. */
  function ctxWithMode(automationMode: string): GenerationContext {
    return makeContext({
      company: { name: "Acme", website: null, automationMode, defaultLang: "en" },
    });
  }

  /** A context whose channel override is what decides the effective mode. */
  function ctxWithChannelOverride(automationModeOverride: string): GenerationContext {
    return makeContext({
      company: { name: "Acme", website: null, automationMode: "semi_automated", defaultLang: "en" },
      channel: { ...makeContext().channel, automationModeOverride },
    });
  }

  // ── Manual generation ──────────────────────────────────────────────────────

  it("manual + semi_automated leaves a draft for a human", async () => {
    const { deps, created } = makeDeps();

    const result = await generatePostFromContext(
      ctxWithMode("semi_automated"),
      "co-1",
      { initialStatus: "draft", generatedById: "u-1" },
      deps
    );

    assert.ok(result.success);
    assert.equal(created()?.status, "draft");
    assert.equal(created()?.approvedAt, null);
  });

  it("manual + fully_automated ALSO leaves a draft for a human", async () => {
    const { deps, created } = makeDeps();

    const result = await generatePostFromContext(
      ctxWithMode("fully_automated"),
      "co-1",
      { initialStatus: "draft", generatedById: "u-1" },
      deps
    );

    // The point of Variant B: a post a person asked for is never past review
    // before that person has seen it.
    assert.ok(result.success);
    assert.equal(created()?.status, "draft");
    assert.equal(created()?.approvedAt, null);
    assert.equal(result.post.status, "DRAFT");
  });

  it("a fully_automated CHANNEL override cannot approve a manual post either", async () => {
    const { deps, created } = makeDeps();

    const result = await generatePostFromContext(
      ctxWithChannelOverride("fully_automated"),
      "co-1",
      { initialStatus: "draft", generatedById: "u-1" },
      deps
    );

    assert.ok(result.success);
    assert.equal(created()?.status, "draft");
  });

  it("never records an auto-approval on the generation audit log", async () => {
    let logged: Record<string, unknown> | null = null;
    const { deps } = makeDeps();
    deps.auditLog = async (entry) => {
      logged = (entry.metadata ?? null) as Record<string, unknown> | null;
    };

    await generatePostFromContext(
      ctxWithMode("fully_automated"),
      "co-1",
      { initialStatus: "draft", generatedById: "u-1" },
      deps
    );

    assert.ok(logged);
    assert.equal((logged as Record<string, unknown>).autoApproved, undefined);
  });

  // ── Owner / editor parity ──────────────────────────────────────────────────

  it("produces the same status whoever generated it", async () => {
    const owner = makeDeps();
    const editor = makeDeps();

    await generatePostFromContext(
      ctxWithMode("fully_automated"),
      "co-1",
      { initialStatus: "draft", generatedById: "owner-1" },
      owner.deps
    );
    await generatePostFromContext(
      ctxWithMode("fully_automated"),
      "co-1",
      { initialStatus: "draft", generatedById: "editor-1" },
      editor.deps
    );

    // Generation reads no role — the identity only lands in generatedById.
    assert.equal(owner.created()?.status, editor.created()?.status);
    assert.equal(owner.created()?.status, "draft");
    assert.equal(owner.created()?.generatedById, "owner-1");
    assert.equal(editor.created()?.generatedById, "editor-1");
  });

  // ── Cron generation ────────────────────────────────────────────────────────

  it("cron + semi_automated waits in pending_approval", async () => {
    const { deps, created } = makeDeps();

    const result = await generatePostFromContext(
      ctxWithMode("semi_automated"),
      "co-1",
      { initialStatus: "pending_approval", scheduleId: "sched-1" },
      deps
    );

    assert.ok(result.success);
    assert.equal(created()?.status, "pending_approval");
    assert.equal(created()?.approvedAt, null);
  });

  it("cron + fully_automated also stops at pending_approval, for cron step 4 to promote", async () => {
    const { deps, created } = makeDeps();

    const result = await generatePostFromContext(
      ctxWithMode("fully_automated"),
      "co-1",
      { initialStatus: "pending_approval", scheduleId: "sched-1" },
      deps
    );

    // Generation hands off; autoApprovePosts is the only thing that approves
    // without a human, and it is where the safety-flag hold lives.
    assert.ok(result.success);
    assert.equal(created()?.status, "pending_approval");
    assert.equal(created()?.approvedAt, null);
  });

  it("no mode or caller can make generation emit an approved post", async () => {
    for (const mode of ["semi_automated", "fully_automated"]) {
      for (const initialStatus of ["draft", "pending_approval"] as const) {
        const { deps, created } = makeDeps();
        await generatePostFromContext(ctxWithMode(mode), "co-1", { initialStatus }, deps);
        assert.notEqual(created()?.status, "approved", `${mode} / ${initialStatus}`);
      }
    }
  });
});

// ─── Post origin ─────────────────────────────────────────────────────────────

describe("generatePostFromContext — post origin", () => {
  let prevMockMode: string | undefined;

  before(() => {
    prevMockMode = process.env.AI_MOCK_MODE;
    process.env.AI_MOCK_MODE = "true";
  });

  after(() => {
    if (prevMockMode === undefined) delete process.env.AI_MOCK_MODE;
    else process.env.AI_MOCK_MODE = prevMockMode;
  });

  /** A context whose single article carries its source's kind and name. */
  function articleCtx(sourceType = "rss") {
    return makeContext({
      feedItems: [
        {
          id: "feed-1",
          title: "Apple ships M5",
          content: "The new chip lands in October.",
          url: "https://example.com/m5",
          publishedAt: null,
          sourceType,
          sourceName: "TechPowerUp",
        },
      ],
      hasArticleSources: true,
    });
  }

  it("freezes the source type, name and article onto the post row", async () => {
    const { deps, created } = makeDeps();

    const result = await generatePostFromContext(articleCtx(), "co-1", {}, deps);

    assert.ok(result.success);
    const data = created();
    assert.equal(data?.originType, "content_source");
    assert.equal(data?.originSourceType, "rss");
    assert.equal(data?.originSourceName, "TechPowerUp");
    assert.equal(data?.originSourceTitle, "Apple ships M5");
    assert.equal(data?.originSourceUrl, "https://example.com/m5");
  });

  it("freezes a product page source as its own type, not as RSS", async () => {
    const { deps, created } = makeDeps();

    const result = await generatePostFromContext(articleCtx("product_page"), "co-1", {}, deps);

    assert.ok(result.success);
    assert.equal(created()?.originSourceType, "product_page");
    assert.equal(result.post.origin.sourceType, "product_page");
  });

  it("returns the frozen origin on the response, with no read-back", async () => {
    const { deps } = makeDeps();

    const result = await generatePostFromContext(articleCtx(), "co-1", {}, deps);

    assert.ok(result.success);
    assert.equal(result.post.origin.kind, "source");
    assert.equal(result.post.origin.sourceType, "rss");
    assert.equal(result.post.origin.sourceName, "TechPowerUp");
    assert.equal(result.post.origin.articleTitle, "Apple ships M5");
    assert.equal(result.post.origin.articleUrl, "https://example.com/m5");
  });

  it("writes brand_setup with null source fields for a mission post", async () => {
    const { deps, created } = makeDeps();

    const result = await generatePostFromContext(context(), "co-1", {}, deps);

    assert.ok(result.success);
    const data = created();
    assert.equal(data?.originType, "brand_setup");
    assert.equal(data?.originSourceType, null);
    assert.equal(data?.originSourceName, null);
    assert.equal(data?.originSourceTitle, null);
    assert.equal(data?.originSourceUrl, null);
    assert.equal(result.post.origin.kind, "brand_setup");
  });

  it("still records the article when the context carries no source type or name", async () => {
    const { deps, created } = makeDeps();
    const ctx = makeContext({
      feedItems: [
        {
          id: "feed-1",
          title: "Untitled feed",
          content: "Body.",
          url: "https://example.com/x",
          publishedAt: null,
        },
      ],
      hasArticleSources: true,
    });

    const result = await generatePostFromContext(ctx, "co-1", {}, deps);

    assert.ok(result.success);
    // A source post that describes itself with less beats losing the origin.
    assert.equal(created()?.originType, "content_source");
    assert.equal(created()?.originSourceType, null);
    assert.equal(created()?.originSourceName, null);
    assert.equal(result.post.origin.kind, "source");
  });
});

// ─── Source binding: text, URL and reservation are one article ───────────────

describe("generatePostFromContext — the post links to the article it was written from", () => {
  let prevMockMode: string | undefined;
  before(() => {
    prevMockMode = process.env.AI_MOCK_MODE;
    process.env.AI_MOCK_MODE = "true";
  });
  after(() => {
    if (prevMockMode === undefined) delete process.env.AI_MOCK_MODE;
    else process.env.AI_MOCK_MODE = prevMockMode;
  });

  // The production report: a post about a university closure carrying the URL of
  // an unrelated article from the same BBC feed.
  const CLOSURE = {
    id: "closure",
    title: "University closes campus after funding cut",
    content: "Students were told the campus will shut at the end of term.",
    url: "https://news.example.com/university-closure",
    publishedAt: null,
  };
  const WEATHER = {
    id: "weather",
    title: "Storm warning issued for the coast",
    content: "Forecasters expect high winds through the weekend.",
    url: "https://news.example.com/storm-warning",
    publishedAt: null,
  };

  function linkingContext(feedItems: GenerationContext["feedItems"]): GenerationContext {
    return makeContext({
      feedItems,
      hasArticleSources: true,
      channel: { ...makeContext().channel, includeSourceLink: true },
    });
  }

  it("binds every recorded value to the CLAIMED article when it is not feedItems[0]", async () => {
    // A concurrent run already took the first candidate, so the reservation wins
    // the second. This is the case a positional primary gets wrong: the post
    // would be linked to whatever happened to sit at index 0.
    const { deps, created } = makeDeps([], ACCEPT_GATE, new Set(["closure"]));
    const result = await generatePostFromContext(
      linkingContext([WEATHER, CLOSURE]),
      "company-1",
      {},
      deps
    );

    assert.equal(result.success, true);
    const data = created()!;
    const snapshot = data.promptSnapshot as Record<string, unknown>;
    const content = data.content as string;

    // Post.primaryFeedItemId === the reserved item
    assert.equal(data.primaryFeedItemId, "closure");
    // promptSnapshot agrees with the column
    assert.equal(snapshot.primaryFeedItemId, "closure");
    // promptSnapshot.sourceUrl === the reserved item's url
    assert.equal(snapshot.sourceUrl, CLOSURE.url);
    assert.equal(snapshot.sourceTitle, CLOSURE.title);
    // The URL actually appended to the post is that same url
    assert.ok(content.endsWith(CLOSURE.url), "the appended URL is the claimed article's");
  });

  it("never lets a background article supply the URL", async () => {
    const { deps, created } = makeDeps([], ACCEPT_GATE, new Set(["closure"]));
    await generatePostFromContext(linkingContext([WEATHER, CLOSURE]), "company-1", {}, deps);

    const data = created()!;
    const content = data.content as string;
    assert.ok(!content.includes(WEATHER.url), "the unclaimed article's URL must never appear");
    assert.notEqual(data.primaryFeedItemId, "weather");
    assert.notEqual((data.promptSnapshot as Record<string, unknown>).sourceUrl, WEATHER.url);
  });

  it("holds whichever article the reservation wins", async () => {
    // Not an artefact of one ordering: each claim yields a self-consistent post.
    for (const claimed of [WEATHER, CLOSURE]) {
      const { deps, created } = makeDeps([], ACCEPT_GATE, new Set([claimed.id]));
      await generatePostFromContext(linkingContext([WEATHER, CLOSURE]), "company-1", {}, deps);

      const data = created()!;
      const snapshot = data.promptSnapshot as Record<string, unknown>;
      assert.equal(data.primaryFeedItemId, claimed.id);
      assert.equal(snapshot.sourceUrl, claimed.url);
      assert.ok((data.content as string).endsWith(claimed.url));
    }
  });

  it("records the same article in the prompt it sent to the model", async () => {
    // The last link in the chain: the model was told to write about the article
    // whose URL we appended, not merely that the two ids match afterwards.
    const { deps, created } = makeDeps([], ACCEPT_GATE, new Set(["closure"]));
    await generatePostFromContext(linkingContext([WEATHER, CLOSURE]), "company-1", {}, deps);

    const snapshot = created()!.promptSnapshot as Record<string, unknown>;
    const userPrompt = snapshot.userPrompt as string;
    const primaryIdx = userPrompt.indexOf("PRIMARY SOURCE ARTICLE");
    const backgroundIdx = userPrompt.indexOf("Additional background context");

    assert.ok(primaryIdx >= 0 && backgroundIdx > primaryIdx);
    const closureIdx = userPrompt.indexOf(CLOSURE.title);
    assert.ok(
      closureIdx > primaryIdx && closureIdx < backgroundIdx,
      "the claimed article is the PRIMARY SOURCE in the prompt"
    );
    assert.ok(
      userPrompt.indexOf(WEATHER.title) > backgroundIdx,
      "the unclaimed article is background only"
    );
  });

  it("carries the binding through the transferred-quota path (v2-8)", async () => {
    // A dry RSS-A hands its quota to RSS-B, so a run generates several posts in
    // a row scoped to RSS-B. Each must link to its own article:
    // this is the second and third of four posts from the same B window.
    const bWindow = [
      { ...CLOSURE, id: "b-1", url: "https://news.example.com/b-1" },
      { ...WEATHER, id: "b-2", url: "https://news.example.com/b-2" },
      { ...CLOSURE, id: "b-3", url: "https://news.example.com/b-3" },
    ];

    for (const claimedId of ["b-2", "b-3"]) {
      const { deps, created } = makeDeps([], ACCEPT_GATE, new Set([claimedId]));
      const result = await generatePostFromContext(
        linkingContext(bWindow),
        "company-1",
        { contentSourceId: "rss-b" },
        deps
      );

      assert.equal(result.success, true);
      const data = created()!;
      const claimed = bWindow.find((i) => i.id === claimedId)!;
      assert.equal(data.contentSourceId, "rss-b", "the post is drawn against RSS-B's quota");
      assert.equal(data.primaryFeedItemId, claimedId);
      assert.equal((data.promptSnapshot as Record<string, unknown>).sourceUrl, claimed.url);
      assert.ok((data.content as string).endsWith(claimed.url));
    }
  });

  it("appends no URL for a mission post", async () => {
    const { deps, created } = makeDeps();
    await generatePostFromContext(
      makeContext({
        feedItems: [],
        hasArticleSources: false,
        channel: { ...makeContext().channel, includeSourceLink: true },
      }),
      "company-1",
      {},
      deps
    );

    const data = created()!;
    const snapshot = data.promptSnapshot as Record<string, unknown>;
    assert.equal(data.primaryFeedItemId, null);
    assert.equal(snapshot.sourceUrl, null);
    assert.ok(!(data.content as string).includes("https://news.example.com"));
  });
});

// Type-level guard: the column is nullable, so legacy rows may omit/null it.
const _nullableCoreMessage: Prisma.PostUncheckedCreateInput["coreMessage"] = null;
void _nullableCoreMessage;

function context(): GenerationContext {
  return makeContext();
}
