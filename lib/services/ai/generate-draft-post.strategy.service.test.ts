import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SocialChannel } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { generatePostFromContext } from "./generate-draft-post.service";
import type { GenerateDraftPostDb, GenerateDraftPostDeps } from "./generate-draft-post.service";
import {
  bindMultiAgent,
  MultiAgentGenerationError,
  type MultiAgentDeps,
} from "@/lib/ai/generate-multi-agent";
import type { CrewPostOutcome } from "@/lib/ai/crew/crew-sidecar.client";
import type { CrewPostRequest } from "@/lib/ai/crew/crew-contract";
import { inferenceFingerprint } from "@/lib/ai/crew/provenance";
import { pinnedInferenceProfile } from "@/lib/ai/strategy/experiment-inference";
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
    qaRepairs: 0,
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

const GLOBAL_MULTI: ResolvedStrategy = { ...USER_MULTI, source: "global_default" };

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
  /** The `inference` profile the service handed the multi-agent binder. */
  multiInference: () => (MultiAgentDeps["inference"] & Record<string, unknown>) | null;
  /** The `CrewPostRequest` the sidecar mock actually received. */
  sidecarRequest: () => CrewPostRequest | null;
}

function makeHarness(opts: {
  sidecar?: (req: unknown) => Promise<CrewPostOutcome>;
  semanticGate?: SemanticGate;
  singleAgentThrows?: boolean;
  /**
   * Replaces the real CrewAI loop entirely. Only for the persistence-invariant
   * tests, which must hand the service a result the real loop would refuse to
   * produce — that is the whole point of a second guard.
   */
  multiLoopOverride?: typeof generateWithRetry;
}): Harness {
  let createdData: Prisma.PostUncheckedCreateInput | null = null;
  let savedRun: PersistableRun | null = null;
  let singleCalls = 0;
  let multiBuilds = 0;
  let capturedInference: (MultiAgentDeps["inference"] & Record<string, unknown>) | null = null;
  let capturedSidecarReq: CrewPostRequest | null = null;

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
        capturedInference = multiDeps.inference as typeof capturedInference;
        if (opts.multiLoopOverride) return opts.multiLoopOverride;
        return bindMultiAgent({
          ...multiDeps,
          sidecar: {
            generate: async (req) => {
              capturedSidecarReq = req;
              return (opts.sidecar ?? (async () => multiOutcome()))(req);
            },
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
    multiInference: () => capturedInference,
    sidecarRequest: () => capturedSidecarReq,
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

  // ── The QA acceptance invariant at the persistence boundary ──────────────
  //
  // Regression cover for the production defect (Instagram run e41b5d62, post
  // 696f0be0): a `rejected_unroutable` candidate persisted as a normal Draft.
  // Two independent guards now stand between QA's refusal and a saved post, and
  // each is tested on its own — a correctness rule must not rest on one check.

  it("END TO END: a QA-rejected multi-agent run saves no post and fails the run", async () => {
    const h = makeHarness({
      singleAgentThrows: true, // a QA refusal must never fall back to single-agent
      sidecar: async () => multiOutcome({ qaState: "rejected_unroutable", qaRevisions: 2 }),
    });
    const r = await generatePostFromContext(
      makeContext(),
      "co-1",
      { resolvedStrategy: USER_MULTI },
      h.deps
    );
    assert.equal(r.success, false);
    // Its OWN code, not the provider's. Every model call in this run succeeded;
    // the reviewer is what refused, and LLM_PROVIDER_ERROR would send an
    // operator hunting a sidecar/Ollama outage that never happened.
    assert.equal(r.success ? "" : r.code, "QA_NOT_CONVERGED");
    assert.equal(h.created(), null, "a QA-rejected candidate is never persisted");
    assert.equal(h.singleAgentCalls(), 0, "must not fall through to single-agent");
    const run = h.savedRun();
    assert.equal(run!.status, "failed", "the run is failed, never a false 'completed'");
    assert.equal(run!.errorCode, "QA_NOT_CONVERGED");
    assert.notEqual(run!.errorCode, "LLM_PROVIDER_ERROR");
    assert.match(run!.errorMessage ?? "", /QA rejected every candidate/);
  });

  /**
   * The second guard in isolation. The loop is replaced by a double that hands
   * the service exactly what the old bug produced: a SUCCESSFUL loop result
   * carrying `qaState: "rejected_unroutable"`. The real loop can no longer emit
   * this — which is why it has to be forged here to prove the service refuses it
   * on its own rather than trusting the loop.
   */
  function loopReturning(qaState: CrewPostOutcome["qaState"]): typeof generateWithRetry {
    return (async () => ({
      parsed: JSON.parse(CANDIDATE_JSON) as never,
      duplicateResult: { flagged: false, matchedPostId: null, similarityScore: 0, checked: 0 },
      semanticResult: {
        decision: "accept",
        topSimilarity: null,
        matchedPostId: null,
        matchedCoreMessage: null,
        skipped: false,
      },
      coreMessageGeneric: false,
      topicRepeated: false,
      complianceResult: { status: "passed", reasons: [], checked: [] },
      openingResult: {
        flagged: false,
        matchType: null,
        matchedPostId: null,
        similarity: null,
        candidateForm: "statement",
        matchedOpening: null,
      },
      attempts: 3,
      multiAgent: {
        strategy: "multi",
        strategySource: "user_override",
        inference: { modelTag: "qwen3.5:35b-a3b-q4_K_M", modelDigest: null, settings: {} },
        inferenceFingerprint: "fp",
        writerCalls: 3,
        editorCalls: 3,
        qaCalls: 3,
        qaRevisionRounds: 2,
        agentCalls: 9,
        latencyMs: 1000,
        degraded: false,
        degradedStages: [],
        qaState,
      },
    })) as unknown as typeof generateWithRetry;
  }

  it("the service REFUSES to persist a rejected_unroutable result even when the loop returns it", async () => {
    const h = makeHarness({ multiLoopOverride: loopReturning("rejected_unroutable") });
    const r = await generatePostFromContext(
      makeContext(),
      "co-1",
      { resolvedStrategy: USER_MULTI },
      h.deps
    );
    assert.equal(r.success, false, "gates clean and compliance passed — QA alone must stop this");
    assert.equal(r.success ? "" : r.code, "LLM_PROVIDER_ERROR");
    assert.equal(h.created(), null, "no post written");
    const run = h.savedRun();
    assert.equal(run!.status, "failed");
    // Provenance stays truthful: the measurement is still recorded on the
    // failed run, `degraded` is NOT reinterpreted, and the QA verdict is kept.
    assert.equal(run!.strategy?.qaState, "rejected_unroutable");
    assert.equal(run!.strategy?.qaRevisionRounds, 2);
    assert.equal(run!.strategy?.degraded, false);
  });

  it("the invariant leaves qaState=pass alone — a passing multi run persists normally", async () => {
    const h = makeHarness({ multiLoopOverride: loopReturning("pass") });
    const r = await generatePostFromContext(
      makeContext(),
      "co-1",
      { resolvedStrategy: USER_MULTI },
      h.deps
    );
    assert.ok(r.success);
    assert.ok(h.created(), "a passing candidate is saved");
    assert.equal(h.savedRun()!.strategy?.qaState, "pass");
  });

  it("the invariant leaves qaState=unavailable alone — the designed degraded fallback still saves", async () => {
    const h = makeHarness({ multiLoopOverride: loopReturning("unavailable") });
    const r = await generatePostFromContext(
      makeContext(),
      "co-1",
      { resolvedStrategy: USER_MULTI },
      h.deps
    );
    assert.ok(r.success, "a critic that could not RUN is not a critic that refused");
    assert.ok(h.created(), "the degraded fallback is persisted, as designed");
    assert.equal(h.savedRun()!.strategy?.qaState, "unavailable");
  });

  it("the invariant cannot touch the single-agent path — it has no QA verdict at all", async () => {
    const h = makeHarness({});
    const r = await generatePostFromContext(makeContext(), "co-1", {}, h.deps);
    assert.ok(r.success, "a single-agent run is unaffected by a multi-agent-only guard");
    assert.ok(h.created());
    assert.equal(h.savedRun()!.strategy?.qaState, null);
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

describe("generatePostFromContext — multi-agent thinking is disabled on every path", () => {
  let prevMock: string | undefined;
  before(() => {
    prevMock = process.env.AI_MOCK_MODE;
    process.env.AI_MOCK_MODE = "true";
  });
  after(() => {
    if (prevMock === undefined) delete process.env.AI_MOCK_MODE;
    else process.env.AI_MOCK_MODE = prevMock;
  });

  const PINNED_TAG = pinnedInferenceProfile().modelTag;
  const THINK_OFF_FP = inferenceFingerprint({
    modelTag: PINNED_TAG,
    modelDigest: null,
    settings: { think: false },
  });
  const THINK_OMITTED_FP = inferenceFingerprint({
    modelTag: PINNED_TAG,
    modelDigest: null,
    settings: {},
  });

  async function runMulti(strategy: ResolvedStrategy): Promise<Harness> {
    const h = makeHarness({});
    const r = await generatePostFromContext(
      makeContext(),
      "co-1",
      { resolvedStrategy: strategy },
      h.deps
    );
    assert.ok(r.success, "the mocked multi run should succeed");
    return h;
  }

  // A + E/F/G: user_override multi → think:false reaches the sidecar for the
  // single Writer→Editor→QA request (the sidecar applies it to all three agents;
  // `inference_config.llm_kwargs` + its tests cover that fan-out).
  it("A/E/F/G — user_override multi sends think:false on the wire", async () => {
    const h = await runMulti(USER_MULTI);
    assert.equal(h.multiInference()!.settings.think, false);
    assert.equal(h.sidecarRequest()!.inferenceConfig.think, false);
  });

  it("B — global_default multi sends think:false on the wire", async () => {
    const h = await runMulti(GLOBAL_MULTI);
    assert.equal(h.multiInference()!.settings.think, false);
    assert.equal(h.sidecarRequest()!.inferenceConfig.think, false);
  });

  it("C — ab_split multi still sends think:false on the wire (unchanged)", async () => {
    const h = await runMulti(AB_MULTI);
    assert.equal(h.multiInference()!.settings.think, false);
    assert.equal(h.sidecarRequest()!.inferenceConfig.think, false);
  });

  // D: the sidecar's translation of `think:false` → `reasoning_effort:"none"`
  // on the OpenAI-compatible request is covered by the Python suite
  // (test_flow_routing.StructuredCandidateOutput.test_the_qa_constraint_does_not
  // _disturb_the_think_off_extra_body and inference_config's own tests). Asserted
  // here only that the wire flag that triggers it is present — see above.

  it("H/I — response_format contract is untouched: the request still declares llm_post_json", async () => {
    const h = await runMulti(USER_MULTI);
    assert.equal(h.sidecarRequest()!.generationRequirements.responseContract, "llm_post_json");
  });

  it("J — the recorded provenance fingerprint reflects think:false, not think-omitted", async () => {
    for (const strategy of [USER_MULTI, GLOBAL_MULTI, AB_MULTI]) {
      const h = await runMulti(strategy);
      const fp = h.savedRun()!.strategy?.inferenceFingerprint;
      assert.equal(fp, THINK_OFF_FP, `${strategy.source} must fingerprint as think:false`);
      assert.notEqual(
        fp,
        THINK_OMITTED_FP,
        `${strategy.source} must not fingerprint as think-omitted`
      );
    }
  });

  it("K — single-agent generation is untouched: no multi binder, no think on any wire", async () => {
    const h = makeHarness({});
    await generatePostFromContext(makeContext(), "co-1", {}, h.deps);
    assert.equal(h.multiBuilds(), 0);
    assert.equal(h.singleAgentCalls(), 1);
    assert.equal(h.sidecarRequest(), null, "the sidecar is never called on the single-agent path");
  });

  it("L — A/B assignment fields are recorded unchanged for an ab_split multi run", async () => {
    const h = await runMulti(AB_MULTI);
    const run = h.savedRun()!.strategy;
    assert.equal(run?.generationStrategySource, "ab_split");
    assert.equal(run?.experimentKey, "exp-1");
    assert.equal(run?.experimentArm, "multi");
    assert.equal(run?.experimentBucket, 42);
    assert.equal(run?.experimentAllocation, 50);
    // …and a non-experiment multi run carries none of them.
    const h2 = await runMulti(USER_MULTI);
    assert.equal(h2.savedRun()!.strategy?.experimentKey, null);
    assert.equal(h2.savedRun()!.strategy?.experimentBucket, null);
  });
});

// ─── The model the multi loop actually runs, end to end ───────────────────────
//
// The production defect: `pinnedModelTag()` sourced BOTH arms from
// TEXT_WORKER_MODEL, so a `user_override` multi run in production would have
// used qwen3:8b — the single-agent model — rather than the model the
// Writer→Editor→QA loop was validated on. These drive the real service and
// assert the tag that reaches the sidecar request, not just the helper.
describe("generatePostFromContext — multi-agent model selection by strategy source", () => {
  const DEDICATED = "qwen3.5:35b-a3b-q4_K_M";
  const AB_TAG = pinnedInferenceProfile().modelTag;

  let prevMock: string | undefined;
  let prevMultiModel: string | undefined;
  before(() => {
    prevMock = process.env.AI_MOCK_MODE;
    process.env.AI_MOCK_MODE = "true";
    prevMultiModel = process.env.MULTI_AGENT_MODEL;
  });
  after(() => {
    if (prevMock === undefined) delete process.env.AI_MOCK_MODE;
    else process.env.AI_MOCK_MODE = prevMock;
    if (prevMultiModel === undefined) delete process.env.MULTI_AGENT_MODEL;
    else process.env.MULTI_AGENT_MODEL = prevMultiModel;
  });

  /** Runs one multi generation with MULTI_AGENT_MODEL set (or explicitly unset). */
  async function runWithModel(
    strategy: ResolvedStrategy,
    dedicated: string | undefined
  ): Promise<Harness> {
    if (dedicated === undefined) delete process.env.MULTI_AGENT_MODEL;
    else process.env.MULTI_AGENT_MODEL = dedicated;
    const h = makeHarness({});
    const r = await generatePostFromContext(
      makeContext(),
      "co-1",
      { resolvedStrategy: strategy },
      h.deps
    );
    assert.ok(r.success, "the mocked multi run should succeed");
    return h;
  }

  it("B — user_override multi runs MULTI_AGENT_MODEL, on the wire and in provenance", async () => {
    const h = await runWithModel(USER_MULTI, DEDICATED);
    assert.equal(h.multiInference()!.modelTag, DEDICATED);
    assert.equal(h.sidecarRequest()!.inferenceConfig.model, DEDICATED);
    assert.equal(h.savedRun()!.strategy?.modelTag, DEDICATED);
  });

  it("C — global_default multi runs MULTI_AGENT_MODEL", async () => {
    const h = await runWithModel(GLOBAL_MULTI, DEDICATED);
    assert.equal(h.multiInference()!.modelTag, DEDICATED);
    assert.equal(h.sidecarRequest()!.inferenceConfig.model, DEDICATED);
  });

  it("D — ab_split multi still runs TEXT_WORKER_MODEL, preserving model fairness", async () => {
    // The load-bearing case: an experiment must vary orchestration alone, so the
    // dedicated model is deliberately ignored for an assigned run.
    const h = await runWithModel(AB_MULTI, DEDICATED);
    assert.equal(h.multiInference()!.modelTag, AB_TAG);
    assert.equal(h.sidecarRequest()!.inferenceConfig.model, AB_TAG);
    assert.notEqual(h.sidecarRequest()!.inferenceConfig.model, DEDICATED);
  });

  it("E — with MULTI_AGENT_MODEL absent, normal multi falls back to TEXT_WORKER_MODEL", async () => {
    for (const strategy of [USER_MULTI, GLOBAL_MULTI]) {
      const h = await runWithModel(strategy, undefined);
      assert.equal(h.sidecarRequest()!.inferenceConfig.model, AB_TAG, strategy.source);
    }
  });

  it("F/G — think:false survives the model split on every source", async () => {
    for (const strategy of [USER_MULTI, GLOBAL_MULTI, AB_MULTI]) {
      const h = await runWithModel(strategy, DEDICATED);
      assert.equal(h.multiInference()!.settings.think, false, strategy.source);
      assert.equal(h.sidecarRequest()!.inferenceConfig.think, false, strategy.source);
    }
  });

  it("H — the recorded fingerprint follows the model that actually ran", async () => {
    const normal = await runWithModel(USER_MULTI, DEDICATED);
    const split = await runWithModel(AB_MULTI, DEDICATED);
    const fpNormal = normal.savedRun()!.strategy?.inferenceFingerprint;
    const fpSplit = split.savedRun()!.strategy?.inferenceFingerprint;

    assert.equal(
      fpNormal,
      inferenceFingerprint({
        modelTag: DEDICATED,
        modelDigest: null,
        settings: { think: false },
      })
    );
    assert.equal(
      fpSplit,
      inferenceFingerprint({ modelTag: AB_TAG, modelDigest: null, settings: { think: false } })
    );
    assert.notEqual(fpNormal, fpSplit, "different models must fingerprint differently");
  });

  it("H — model verification stays tag_matched_only for a normal run on the dedicated model", async () => {
    // Regression guard: verifying the observed tag against the A/B tag instead
    // of the tag this run pinned would report `unknown` for every healthy
    // user_override run the moment the two models differ.
    const h = await runWithModel(USER_MULTI, DEDICATED);
    assert.equal(h.savedRun()!.strategy?.modelVerification, "tag_matched_only");
  });

  it("I — A/B assignment metadata is unaffected by the model split", async () => {
    const h = await runWithModel(AB_MULTI, DEDICATED);
    const run = h.savedRun()!.strategy;
    assert.equal(run?.experimentKey, "exp-1");
    assert.equal(run?.experimentArm, "multi");
    assert.equal(run?.experimentBucket, 42);
    assert.equal(run?.experimentAllocation, 50);
  });

  it("J — the single-agent path never sees MULTI_AGENT_MODEL", async () => {
    process.env.MULTI_AGENT_MODEL = DEDICATED;
    const h = makeHarness({});
    const r = await generatePostFromContext(makeContext(), "co-1", {}, h.deps);
    assert.ok(r.success);
    assert.equal(h.multiBuilds(), 0);
    assert.equal(h.singleAgentCalls(), 1);
    assert.equal(h.sidecarRequest(), null);
    assert.notEqual(h.savedRun()!.strategy?.modelTag, DEDICATED);
  });
});
