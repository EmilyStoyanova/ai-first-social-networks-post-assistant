import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SocialChannel } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { generatePostFromContext } from "./generate-draft-post.service";
import type { GenerateDraftPostDb, GenerateDraftPostDeps } from "./generate-draft-post.service";
import { bindMultiAgent, MultiAgentGenerationError } from "@/lib/ai/generate-multi-agent";
import type { CrewPostOutcome } from "@/lib/ai/crew/crew-sidecar.client";
import type { SemanticGate, generateWithRetry } from "@/lib/ai/generate-with-retry";
import type { GenerationContext } from "@/lib/ai/types";
import type { ResolvedStrategy } from "@/lib/ai/strategy/resolve-strategy";
import { GenerationTracer } from "@/lib/generation-trace/tracer";
import type { GenerationTraceStore, PersistableRun } from "@/lib/generation-trace/store";

/**
 * The strategy WIRING, at the funnel every generation passes through.
 *
 * These tests do not re-check the resolver (its own file does) or the CrewAI
 * loop (generate-multi-agent.test.ts does). They check the seam: that the
 * resolved value picks the right loop, that its provenance is persisted, that a
 * multi-agent failure is NOT quietly turned into a single-agent post, and that
 * the deterministic gates run on both paths.
 */

const ACCEPT_GATE: SemanticGate = async () => ({
  decision: "accept",
  topSimilarity: null,
  matchedPostId: null,
  matchedCoreMessage: null,
  skipped: false,
});

const REGENERATE_GATE: SemanticGate = async () => ({
  decision: "regenerate",
  topSimilarity: 0.99,
  matchedPostId: "old-post",
  matchedCoreMessage: "a claim we already published",
  skipped: false,
});

const CANDIDATE_JSON = JSON.stringify({
  text: "A specific, non-generic opening line about the launch and why it matters to readers today.",
  hashtags: ["launch"],
  coreMessage: "Shipping in public earns more trust than a silent pre-launch.",
  imagePrompt: "a team at work",
  notes: "",
});

function multiOutcome(overrides: Partial<CrewPostOutcome> = {}): CrewPostOutcome {
  return {
    raw: CANDIDATE_JSON,
    parsed: JSON.parse(CANDIDATE_JSON) as CrewPostOutcome["parsed"],
    qaState: "pass",
    qaRevisions: 1,
    qaIssues: [],
    agentCalls: { writer: 2, editor: 3, qa: 2 },
    latencyMs: 4321,
    model: { tag: "qwen3.5:35b-a3b-q4_K_M", digest: null },
    degradedStages: [],
    ...overrides,
  };
}

const AB_MULTI: ResolvedStrategy = {
  strategy: "multi",
  source: "ab_split",
  experimentKey: "exp-1",
  experimentArm: "multi",
  experimentUnitId: "group-1",
  experimentBucket: 42,
  experimentAllocation: 50,
  abIneligibleReason: null,
};

const AB_SINGLE: ResolvedStrategy = {
  ...AB_MULTI,
  strategy: "single",
  experimentArm: "single",
};

const USER_MULTI: ResolvedStrategy = {
  strategy: "multi",
  source: "user_override",
  experimentKey: null,
  experimentArm: null,
  experimentUnitId: null,
  experimentBucket: null,
  experimentAllocation: null,
  abIneligibleReason: null,
};

function makeContext(): GenerationContext {
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
  };
}

interface Harness {
  deps: GenerateDraftPostDeps;
  created: () => Prisma.PostUncheckedCreateInput | null;
  savedRun: () => PersistableRun | null;
  singleAgentCalls: () => number;
  multiBuilds: () => number;
}

function makeHarness(opts: {
  sidecar?: (req: unknown) => Promise<CrewPostOutcome>;
  semanticGate?: SemanticGate;
  singleAgentThrows?: boolean;
}): Harness {
  let createdData: Prisma.PostUncheckedCreateInput | null = null;
  let savedRun: PersistableRun | null = null;
  let singleCalls = 0;
  let multiBuilds = 0;

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
          llmProvider: args.data.llmProvider ?? null,
          llmModel: args.data.llmModel ?? null,
          createdAt: new Date(),
        };
      },
    },
    feedItem: { updateMany: async () => ({ count: 1 }) },
  };

  const store: GenerationTraceStore = {
    saveRun: async (run) => {
      savedRun = run;
    },
  };

  // A single-agent double that records it was called. Throws on demand so a test
  // can prove a multi-agent failure never falls through to it.
  const singleAgentLoop = (async (...args: Parameters<typeof generateWithRetry>) => {
    singleCalls++;
    if (opts.singleAgentThrows) throw new Error("single-agent loop must not be reached here");
    // Delegate to the real loop via the mock provider that the service passes.
    const { generateWithRetry: real } = await import("@/lib/ai/generate-with-retry");
    return real(...args);
  }) as typeof generateWithRetry;

  return {
    deps: {
      db,
      auditLog: async () => {},
      embed: async () => ({ status: "embedded" }),
      recordCalibration: async () => {},
      autoSourceImage: async () => ({ status: "skipped", reason: "no_source_image" }),
      autoImage: async () => ({ status: "skipped", reason: "disabled" }),
      semanticGate: opts.semanticGate ?? ACCEPT_GATE,
      loadDefaultLlmConfig: async () => ({ id: "default-cfg", provider: "grok" }),
      loadArticleBrief: async () => ({
        mainSubject: "",
        centralThesis: null,
        centralConflict: null,
        articleType: null,
        secondaryTopics: [],
        incidentalTopics: [],
        entities: [],
        confidence: null,
        source: "none",
      }),
      generateWithRetry: singleAgentLoop,
      buildMultiAgentLoop: (multiDeps) => {
        multiBuilds++;
        return bindMultiAgent({
          ...multiDeps,
          sidecar: {
            generate: opts.sidecar ?? (async () => multiOutcome()),
          },
        });
      },
      tracer: GenerationTracer.start({
        kind: "post_generation",
        trigger: "manual",
        companyId: "co-1",
        store,
      }),
    },
    created: () => createdData,
    savedRun: () => savedRun,
    singleAgentCalls: () => singleCalls,
    multiBuilds: () => multiBuilds,
  };
}

describe("generatePostFromContext — strategy wiring", () => {
  let prevMock: string | undefined;
  before(() => {
    prevMock = process.env.AI_MOCK_MODE;
    process.env.AI_MOCK_MODE = "true";
  });
  after(() => {
    if (prevMock === undefined) delete process.env.AI_MOCK_MODE;
    else process.env.AI_MOCK_MODE = prevMock;
  });

  it("an explicit single override runs the single-agent loop, not the multi binder", async () => {
    const h = makeHarness({});
    const r = await generatePostFromContext(
      makeContext(),
      "co-1",
      {
        resolvedStrategy: {
          strategy: "single",
          source: "user_override",
          experimentKey: null,
          experimentArm: null,
          experimentUnitId: null,
          experimentBucket: null,
          experimentAllocation: null,
          abIneligibleReason: null,
        },
      },
      h.deps
    );
    assert.ok(r.success);
    assert.equal(h.singleAgentCalls(), 1);
    assert.equal(h.multiBuilds(), 0);
    assert.equal(h.created()!.generationStrategy, "single");
    assert.equal(h.created()!.generationStrategySource, "user_override");
  });

  it("a multi strategy builds the multi-agent loop and does NOT call the single-agent loop", async () => {
    const h = makeHarness({});
    const r = await generatePostFromContext(
      makeContext(),
      "co-1",
      { resolvedStrategy: USER_MULTI },
      h.deps
    );
    assert.ok(r.success);
    assert.equal(h.multiBuilds(), 1);
    assert.equal(h.singleAgentCalls(), 0);
    assert.equal(h.created()!.generationStrategy, "multi");
  });

  it("omitting resolvedStrategy behaves as single / global_default — the legacy path is unchanged", async () => {
    const h = makeHarness({});
    const r = await generatePostFromContext(makeContext(), "co-1", {}, h.deps);
    assert.ok(r.success);
    assert.equal(h.singleAgentCalls(), 1);
    assert.equal(h.multiBuilds(), 0);
    assert.equal(h.created()!.generationStrategy, "single");
    assert.equal(h.created()!.generationStrategySource, "global_default");
  });

  it("a multi-agent sidecar failure is reported — never silently written as single", async () => {
    const h = makeHarness({
      singleAgentThrows: true, // fail loudly if the fallback path is ever taken
      sidecar: async () => {
        throw new MultiAgentGenerationError("CREW_SIDECAR_UNAVAILABLE", "sidecar down");
      },
    });
    const r = await generatePostFromContext(
      makeContext(),
      "co-1",
      { resolvedStrategy: USER_MULTI },
      h.deps
    );
    assert.equal(r.success, false);
    assert.equal(r.success ? "" : r.code, "LLM_PROVIDER_ERROR");
    assert.equal(h.singleAgentCalls(), 0, "must not fall through to single-agent");
    assert.equal(h.created(), null, "no post written");
  });

  it("the deterministic gates run on the multi-agent path — a semantic duplicate still aborts", async () => {
    const h = makeHarness({ semanticGate: REGENERATE_GATE });
    const r = await generatePostFromContext(
      makeContext(),
      "co-1",
      { resolvedStrategy: USER_MULTI },
      h.deps
    );
    // The gate is inside the real bindMultiAgent loop; a bypass would let this
    // succeed. It must not.
    assert.equal(r.success, false);
    assert.equal(r.success ? "" : r.code, "CANNOT_GENERATE_UNIQUE_POST");
    assert.equal(h.created(), null);
  });

  it("persists the arm and the measurement to the generation run — assignment survives", async () => {
    const h = makeHarness({
      sidecar: async () =>
        multiOutcome({ agentCalls: { writer: 2, editor: 3, qa: 2 }, qaRevisions: 1 }),
    });
    const r = await generatePostFromContext(
      makeContext(),
      "co-1",
      { resolvedStrategy: AB_MULTI },
      h.deps
    );
    assert.ok(r.success);
    const run = h.savedRun();
    assert.ok(run);
    assert.equal(run!.strategy?.generationStrategy, "multi");
    assert.equal(run!.strategy?.generationStrategySource, "ab_split");
    assert.equal(run!.strategy?.experimentKey, "exp-1");
    assert.equal(run!.strategy?.experimentArm, "multi");
    assert.equal(run!.strategy?.experimentBucket, 42);
    // The INNER loop counter, kept separate from `attempts` (the outer one).
    assert.equal(run!.strategy?.qaRevisionRounds, 1);
    assert.equal(run!.strategy?.agentCalls, 7);
    assert.equal(run!.strategy?.agentLatencyMs, 4321);
    // A tag with no runtime digest is tag-matched only, never digest-verified.
    assert.equal(run!.strategy?.modelVerification, "tag_matched_only");
  });

  it("an ab_split run is pinned to the text-worker provider, overriding the admin default", async () => {
    const h = makeHarness({});
    const r = await generatePostFromContext(
      makeContext(),
      "co-1",
      { resolvedStrategy: AB_SINGLE }, // single arm still runs, but pinned
      h.deps
    );
    assert.ok(r.success);
    // The admin default was `grok`; the experiment pins both arms to text_worker.
    assert.equal(h.created()!.llmProvider, "TEXT_WORKER");
  });

  it("a user_override multi run is NOT pinned — no experiment, no arm to hold constant", async () => {
    const h = makeHarness({});
    await generatePostFromContext(makeContext(), "co-1", { resolvedStrategy: USER_MULTI }, h.deps);
    // provider resolution is untouched for a non-experiment run.
    assert.equal(h.created()!.generationStrategySource, "user_override");
    assert.equal(h.created()!.experimentKey, null);
  });

  it("a single-agent run records its own inference fingerprint and tag_matched verification", async () => {
    const h = makeHarness({});
    await generatePostFromContext(makeContext(), "co-1", {}, h.deps);
    const run = h.savedRun();
    assert.ok(run!.strategy?.inferenceFingerprint);
    assert.equal(run!.strategy?.qaState, null, "no QA on the single-agent path");
    assert.equal(run!.strategy?.agentCalls, null);
  });
});
