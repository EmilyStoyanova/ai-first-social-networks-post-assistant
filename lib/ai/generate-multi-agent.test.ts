import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bindMultiAgent,
  MultiAgentGenerationError,
  type MultiAgentDeps,
} from "./generate-multi-agent";
import { MAX_GENERATION_ATTEMPTS, type SemanticGate } from "./generate-with-retry";
import { CrewSidecarError, type CrewPostOutcome } from "./crew/crew-sidecar.client";
import type { CrewPostRequest } from "./crew/crew-contract";
import type { QaState } from "./crew/provenance";
import type { RecentPost } from "./quality/duplicate-detection";
import type { ILlmProvider } from "./types";
import type { GenerationAttemptRecord } from "@/lib/generation-trace/attempt-record";

/**
 * A candidate that clears every deterministic gate: a specific claim (not
 * generic praise), no banned term, a distinct opening, and a topic nothing in
 * the window used. Parameterised so a test can make one candidate a duplicate
 * of another without touching the rest.
 */
function candidate(opts: { text?: string; coreMessage?: string; topic?: string } = {}): string {
  return JSON.stringify({
    text:
      opts.text ??
      "Building in the open earns trust because every shipped decision is visible to the people paying for it.\n" +
        "A first look drops this week, and early access opens right after.",
    hashtags: ["growth"],
    coreMessage:
      opts.coreMessage ??
      "Publishing decisions as they are made shortens the feedback loop by about a week.",
    topic: opts.topic ?? "open development",
  });
}

function outcome(overrides: Partial<CrewPostOutcome> = {}): CrewPostOutcome {
  const raw = overrides.raw ?? candidate();
  return {
    raw,
    // Mirrors the real client: `parsed` comes from the sidecar's structured
    // `candidate.json`, already validated against `LlmPostSchema`. Derived from
    // `raw` here unless a test pins it explicitly.
    parsed: overrides.parsed ?? (JSON.parse(raw) as CrewPostOutcome["parsed"]),
    qaState: "pass",
    qaRevisions: 0,
    qaIssues: [],
    agentCalls: { writer: 1, editor: 1, qa: 1 },
    latencyMs: 1000,
    model: { tag: "qwen3.5:35b-a3b-q4_K_M", digest: "sha256:abc" },
    degradedStages: [],
    ...overrides,
  };
}

/** A sidecar double driven by a script — one entry per outer attempt. */
function scriptedSidecar(script: Array<CrewPostOutcome | Error>) {
  const requests: CrewPostRequest[] = [];
  let i = 0;
  return {
    requests,
    calls: () => i,
    generate: async (request: CrewPostRequest): Promise<CrewPostOutcome> => {
      requests.push(request);
      const next = script[Math.min(i, script.length - 1)];
      i++;
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

const PROVIDER: ILlmProvider = {
  generate: async () => {
    // The provider argument is accepted for seam compatibility and must never
    // be used: inference happens inside the sidecar.
    throw new Error("the multi-agent strategy must never call the injected provider");
  },
};

function deps(
  sidecar: Pick<MultiAgentDeps["sidecar"], "generate">,
  overrides: Partial<MultiAgentDeps> = {}
): MultiAgentDeps {
  return {
    sidecar,
    companyName: "Acme",
    brand: null,
    maxTextLength: 2000,
    inference: {
      modelTag: "qwen3.5:35b-a3b-q4_K_M",
      modelDigest: "sha256:abc",
      settings: { temperature: 0.85, numPredict: 1024 },
      baseUrl: "http://127.0.0.1:11434",
    },
    strategySource: "ab_split",
    ...overrides,
  };
}

const NO_RECENT: RecentPost[] = [];

/** A gate that always demands regeneration — for "gates outrank QA". */
const REGENERATE_GATE: SemanticGate = async () => ({
  decision: "regenerate",
  topSimilarity: 0.95,
  matchedPostId: "post-1",
  matchedCoreMessage: "An earlier post already made this exact claim.",
  skipped: false,
});

describe("bindMultiAgent — the acceptance rule", () => {
  it("accepts a clean run: gates clean AND qa pass", async () => {
    const sidecar = scriptedSidecar([outcome()]);
    const result = await bindMultiAgent(deps(sidecar))(PROVIDER, "sys", "user", NO_RECENT);
    assert.equal(sidecar.calls(), 1);
    assert.equal(result.attempts, 1);
    assert.equal(result.multiAgent?.qaState, "pass");
    assert.equal(result.multiAgent?.degraded, false);
  });

  it("accepts an UNAVAILABLE QA when the gates are clean, and marks it degraded", async () => {
    // A critic that could not run said nothing, so the deterministic gates are
    // the whole verdict. The post is usable; the run is honest about it.
    const sidecar = scriptedSidecar([
      outcome({
        qaState: "unavailable",
        agentCalls: { writer: 1, editor: 1, qa: 0 },
        degradedStages: ["qa"],
      }),
    ]);
    const result = await bindMultiAgent(deps(sidecar))(PROVIDER, "sys", "user", NO_RECENT);
    assert.equal(sidecar.calls(), 1, "an accepted candidate must not be retried");
    assert.equal(result.multiAgent?.qaState, "unavailable");
    assert.equal(result.multiAgent?.degraded, true);
    assert.deepEqual([...(result.multiAgent?.degradedStages ?? [])], ["qa"]);
    // And it is never recorded as a pass.
    assert.notEqual(result.multiAgent?.qaState, "pass");
  });

  it("REFUSES rejected_unroutable even when every gate passes, and consumes outer attempts", async () => {
    // The crux. A critic that ran and said no is information the gates passing
    // does not erase — so the candidate is not accepted, the outer loop retries,
    // and an exhausted run fails with QA_NOT_CONVERGED rather than returning
    // a post whose critic refused it.
    const sidecar = scriptedSidecar([outcome({ qaState: "rejected_unroutable" })]);
    await assert.rejects(
      bindMultiAgent(deps(sidecar))(PROVIDER, "sys", "user", NO_RECENT),
      (err: unknown) => {
        assert.ok(err instanceof MultiAgentGenerationError);
        assert.equal(err.multiAgentCode, "QA_NOT_CONVERGED");
        assert.match(err.message, /without naming an actionable dimension/);
        return true;
      }
    );
    assert.equal(sidecar.calls(), MAX_GENERATION_ATTEMPTS, "every outer attempt is consumed");
  });

  it("retries and then accepts when a later attempt reaches a pass", async () => {
    const sidecar = scriptedSidecar([
      outcome({ qaState: "rejected_unroutable" }),
      outcome({ qaState: "pass" }),
    ]);
    const result = await bindMultiAgent(deps(sidecar))(PROVIDER, "sys", "user", NO_RECENT);
    assert.equal(sidecar.calls(), 2);
    assert.equal(result.attempts, 2);
    assert.equal(result.multiAgent?.qaState, "pass");
  });
});

describe("bindMultiAgent — gates outrank QA", () => {
  it("does NOT accept a QA-passing candidate that fails a gate, and returns it for the service to abort", async () => {
    // The mirror image of the rule above. The gates keep the last word, and
    // exhaustion is reported the way the single-agent loop reports it — as a
    // returned candidate with its verdicts attached, so the SERVICE raises
    // CANNOT_GENERATE_UNIQUE_POST and releases the article, unchanged.
    const sidecar = scriptedSidecar([outcome({ qaState: "pass" })]);
    const result = await bindMultiAgent(deps(sidecar))(
      PROVIDER,
      "sys",
      "user",
      NO_RECENT,
      undefined,
      REGENERATE_GATE
    );
    assert.equal(sidecar.calls(), MAX_GENERATION_ATTEMPTS, "a failing gate retries");
    assert.equal(result.semanticResult.decision, "regenerate");
    assert.equal(result.multiAgent?.qaState, "pass");
  });

  it("catches a Jaccard duplicate with the SAME implementation the single-agent loop uses", async () => {
    const text =
      "Our summer collection lands on Friday with twelve new pieces and a restock of the linen shirt everyone asked for.";
    const sidecar = scriptedSidecar([outcome({ raw: candidate({ text }) })]);
    const recent: RecentPost[] = [{ id: "post-1", text }];
    const result = await bindMultiAgent(deps(sidecar))(PROVIDER, "sys", "user", recent);
    assert.equal(result.duplicateResult.flagged, true);
    assert.equal(result.duplicateResult.matchedPostId, "post-1");
  });

  it("catches a repeated topic through the injected topic memory", async () => {
    const sidecar = scriptedSidecar([outcome({ raw: candidate({ topic: "open development" }) })]);
    const result = await bindMultiAgent(deps(sidecar))(PROVIDER, "sys", "user", NO_RECENT, {
      initialAngle: "Educational",
      recentAngles: [],
      initialPattern: { hookType: "Question", structure: "List", ctaType: "Comment Prompt" },
      recentPatterns: [],
      recentTopics: ["open development"],
    });
    assert.equal(result.topicRepeated, true);
  });
});

describe("bindMultiAgent — never falls back", () => {
  it("never calls the injected single-agent provider", async () => {
    const sidecar = scriptedSidecar([outcome()]);
    // PROVIDER throws if touched.
    await bindMultiAgent(deps(sidecar))(PROVIDER, "sys", "user", NO_RECENT);
  });

  it("fails as a multi-agent run when the sidecar is unreachable", async () => {
    const sidecar = scriptedSidecar([
      new CrewSidecarError("unavailable", "CrewAI sidecar unreachable (ECONNREFUSED)."),
    ]);
    await assert.rejects(
      bindMultiAgent(deps(sidecar))(PROVIDER, "sys", "user", NO_RECENT),
      (err: unknown) => {
        assert.ok(err instanceof MultiAgentGenerationError);
        assert.equal(err.multiAgentCode, "CREW_SIDECAR_UNAVAILABLE");
        return true;
      }
    );
    // One attempt, then out: an infrastructure fault is not retried inside the
    // strategy. The QUEUE retries the job, which is where a wait belongs.
    assert.equal(sidecar.calls(), 1);
  });

  it("surfaces not_configured as its own code", async () => {
    const sidecar = scriptedSidecar([
      new CrewSidecarError("not_configured", "CREW_SIDECAR_URL is required."),
    ]);
    await assert.rejects(
      bindMultiAgent(deps(sidecar))(PROVIDER, "sys", "user", NO_RECENT),
      (err: unknown) =>
        err instanceof MultiAgentGenerationError &&
        err.multiAgentCode === "CREW_SIDECAR_NOT_CONFIGURED"
    );
  });

  it("does NOT parse the candidate on this path — a broken candidate is the sidecar's to refuse", async () => {
    // The redundant `parseLlmPost(outcome.raw)` step is gone. A structurally
    // broken candidate now fails at the sidecar (503) or the response contract
    // (invalid_response) and arrives here as a thrown CrewSidecarError, never as
    // a "successful" outcome to be re-parsed. It surfaces as a multi-agent
    // infrastructure failure with no retry and no substitution.
    const sidecar = scriptedSidecar([
      new CrewSidecarError(
        "invalid_response",
        "CrewAI sidecar reply did not match the contract: candidate.json.text: too_small"
      ),
    ]);
    await assert.rejects(
      bindMultiAgent(deps(sidecar))(PROVIDER, "sys", "user", NO_RECENT),
      (err: unknown) => {
        assert.ok(err instanceof MultiAgentGenerationError);
        assert.equal(err.multiAgentCode, "CREW_SIDECAR_UNAVAILABLE");
        return true;
      }
    );
    assert.equal(sidecar.calls(), 1);
  });

  it("consumes the sidecar's structured candidate verbatim, quote-heavy text and all", async () => {
    const text = 'Представи си „езеро и дворец“ 🏰\n"The Gentlemen" и "Ндра\'нгета".';
    const sidecar = scriptedSidecar([
      outcome({
        raw: "{}",
        parsed: {
          text,
          hashtags: ["#TheGentlemen"],
          coreMessage: 'Окръгът не е „сърце", но "Ндра\'нгета" го използва.',
        },
      }),
    ]);
    const result = await bindMultiAgent(deps(sidecar))(PROVIDER, "sys", "user", NO_RECENT);
    assert.equal(result.parsed.text, text);
  });

  it("is an LlmProviderError, so the existing service catch already handles it", async () => {
    // What makes the strategy safe to wire in before any new error code exists:
    // generatePostFromContext already releases the claimed article and maps
    // LlmProviderError to LLM_PROVIDER_ERROR.
    const sidecar = scriptedSidecar([new CrewSidecarError("timeout", "budget exceeded")]);
    await assert.rejects(
      bindMultiAgent(deps(sidecar))(PROVIDER, "sys", "user", NO_RECENT),
      (err: unknown) =>
        err instanceof Error && (err as { code?: string }).code === "LLM_PROVIDER_ERROR"
    );
  });
});

describe("bindMultiAgent — the per-attempt budget gate", () => {
  /** An outcome that is NOT accepted, so the loop wants another outer attempt. */
  const NEEDS_RETRY = outcome({
    qaState: "rejected_unroutable",
    qaRevisions: 2,
    agentCalls: { writer: 2, editor: 3, qa: 3 },
    latencyMs: 1_350_000,
  });

  it("does NOT start outer attempt 2 when less than the minimum budget remains", async () => {
    const sidecar = scriptedSidecar([NEEDS_RETRY, outcome({ qaState: "pass" })]);
    await assert.rejects(
      bindMultiAgent(
        deps(sidecar, {
          remainingBudgetMs: () => 60_000, // 60s left — far below the 25-min floor
          minAttemptBudgetMs: 1_500_000,
        })
      )(PROVIDER, "sys", "user", NO_RECENT),
      (err: unknown) =>
        err instanceof MultiAgentGenerationError &&
        err.multiAgentCode === "MULTI_AGENT_BUDGET_EXHAUSTED"
    );
    // Attempt 1 ran; attempt 2 was never dialled.
    assert.equal(sidecar.calls(), 1);
  });

  it("carries the completed-attempt measurement on the budget-exhausted error", async () => {
    const sidecar = scriptedSidecar([NEEDS_RETRY]);
    let caught: MultiAgentGenerationError | null = null;
    try {
      await bindMultiAgent(
        deps(sidecar, { remainingBudgetMs: () => 60_000, minAttemptBudgetMs: 1_500_000 })
      )(PROVIDER, "sys", "user", NO_RECENT);
    } catch (err) {
      caught = err as MultiAgentGenerationError;
    }
    assert.ok(caught instanceof MultiAgentGenerationError);
    const partial = caught.partialProvenance;
    assert.ok(partial, "the error carries the objective measurement from attempt 1");
    assert.equal(partial!.completedAttempts, 1);
    assert.equal(partial!.agentCalls, 8); // 2 + 3 + 3
    assert.equal(partial!.agentLatencyMs, 1_350_000);
    assert.equal(partial!.degraded, true);
    assert.ok(partial!.degradedStages.includes("budget_exhausted"));
    assert.match(partial!.inferenceFingerprint, /^[0-9a-f]{64}$/);
    // Never a QA verdict — that stays scoped to the per-attempt trace.
    assert.equal((partial as unknown as { qaState?: unknown }).qaState, undefined);
  });

  it("permits outer attempt 2 when enough budget remains", async () => {
    const sidecar = scriptedSidecar([NEEDS_RETRY, outcome({ qaState: "pass" })]);
    const result = await bindMultiAgent(
      deps(sidecar, { remainingBudgetMs: () => 3_000_000, minAttemptBudgetMs: 1_500_000 })
    )(PROVIDER, "sys", "user", NO_RECENT);
    assert.ok(result.parsed.text.length > 0);
    assert.equal(sidecar.calls(), 2);
    assert.equal(result.multiAgent!.qaState, "pass");
  });

  it("never gates the FIRST attempt, however little budget remains", async () => {
    const sidecar = scriptedSidecar([outcome({ qaState: "pass" })]);
    const result = await bindMultiAgent(
      deps(sidecar, { remainingBudgetMs: () => 1, minAttemptBudgetMs: 1_500_000 })
    )(PROVIDER, "sys", "user", NO_RECENT);
    assert.ok(result.parsed.text.length > 0);
    assert.equal(sidecar.calls(), 1);
  });

  it("is inert with no injected budget reader (ambient deadline absent → +Infinity)", async () => {
    const sidecar = scriptedSidecar([NEEDS_RETRY, outcome({ qaState: "pass" })]);
    const result = await bindMultiAgent(deps(sidecar))(PROVIDER, "sys", "user", NO_RECENT);
    assert.equal(sidecar.calls(), 2);
    assert.ok(result.parsed.text.length > 0);
  });
});

describe("bindMultiAgent — partial provenance on a mid-run throw", () => {
  it("carries attempt-1 measurement when the sidecar throws on attempt 2", async () => {
    const sidecar = scriptedSidecar([
      outcome({
        qaState: "rejected_unroutable",
        qaRevisions: 1,
        agentCalls: { writer: 1, editor: 1, qa: 1 },
        latencyMs: 5000,
      }),
      new CrewSidecarError("timeout", "exceeded its budget"),
    ]);
    let caught: MultiAgentGenerationError | null = null;
    try {
      await bindMultiAgent(deps(sidecar))(PROVIDER, "sys", "user", NO_RECENT);
    } catch (err) {
      caught = err as MultiAgentGenerationError;
    }
    assert.ok(caught instanceof MultiAgentGenerationError);
    assert.equal(caught!.multiAgentCode, "CREW_SIDECAR_UNAVAILABLE");
    const partial = caught!.partialProvenance;
    assert.ok(partial);
    assert.equal(partial!.completedAttempts, 1);
    assert.equal(partial!.agentCalls, 3);
    assert.equal(partial!.agentLatencyMs, 5000);
    assert.ok(partial!.degradedStages.includes("provider_error"));
  });

  it("has NO partial provenance when the sidecar throws on the very first attempt", async () => {
    const sidecar = scriptedSidecar([new CrewSidecarError("timeout", "exceeded its budget")]);
    let caught: MultiAgentGenerationError | null = null;
    try {
      await bindMultiAgent(deps(sidecar))(PROVIDER, "sys", "user", NO_RECENT);
    } catch (err) {
      caught = err as MultiAgentGenerationError;
    }
    assert.ok(caught instanceof MultiAgentGenerationError);
    assert.equal(caught!.partialProvenance, undefined);
  });
});

describe("bindMultiAgent — counters and provenance", () => {
  it("sums agent calls across outer attempts and keeps the max revision rounds", async () => {
    const sidecar = scriptedSidecar([
      // Attempt 1: one writer-routed revision → 2 writer, 2 editor, 2 qa.
      outcome({
        qaState: "rejected_unroutable",
        qaRevisions: 1,
        agentCalls: { writer: 2, editor: 2, qa: 2 },
        latencyMs: 4000,
      }),
      // Attempt 2: clean → 1 writer, 1 editor, 1 qa.
      outcome({ qaState: "pass", qaRevisions: 0, latencyMs: 1500 }),
    ]);
    const result = await bindMultiAgent(deps(sidecar))(PROVIDER, "sys", "user", NO_RECENT);
    const p = result.multiAgent!;
    assert.equal(p.writerCalls, 3);
    assert.equal(p.editorCalls, 3);
    assert.equal(p.qaCalls, 3);
    assert.equal(p.agentCalls, 9);
    // Per-attempt bound, so the MAX rather than the sum.
    assert.equal(p.qaRevisionRounds, 1);
    assert.equal(p.latencyMs, 5500);
  });

  it("records the strategy, its source and the inference fingerprint", async () => {
    const sidecar = scriptedSidecar([outcome()]);
    const result = await bindMultiAgent(deps(sidecar, { strategySource: "user_override" }))(
      PROVIDER,
      "sys",
      "user",
      NO_RECENT
    );
    const p = result.multiAgent!;
    assert.equal(p.strategy, "multi");
    assert.equal(p.strategySource, "user_override");
    assert.equal(p.inference.modelTag, "qwen3.5:35b-a3b-q4_K_M");
    assert.equal(p.inference.modelDigest, "sha256:abc");
    assert.match(p.inferenceFingerprint, /^[0-9a-f]{64}$/);
  });

  it("leaves the single-agent loop's fields untouched — the result stays compatible", async () => {
    const sidecar = scriptedSidecar([outcome()]);
    const result = await bindMultiAgent(deps(sidecar))(PROVIDER, "sys", "user", NO_RECENT);
    // Everything the generation service reads off the loop result is present.
    assert.ok(result.parsed.text.length > 0);
    assert.equal(typeof result.coreMessageGeneric, "boolean");
    assert.equal(typeof result.topicRepeated, "boolean");
    assert.ok(result.complianceResult);
    assert.ok(result.openingResult);
    assert.ok(result.duplicateResult);
    assert.ok(result.semanticResult);
  });
});

describe("bindMultiAgent — the request it builds", () => {
  it("passes the shared prompts through verbatim, so both arms get one definition", async () => {
    const sidecar = scriptedSidecar([outcome()]);
    await bindMultiAgent(deps(sidecar))(PROVIDER, "SYSTEM-PROMPT", "USER-PROMPT", NO_RECENT);
    const req = sidecar.requests[0];
    assert.equal(req.generationRequirements.systemPrompt, "SYSTEM-PROMPT");
    assert.equal(req.generationRequirements.userPrompt, "USER-PROMPT");
  });

  it("pins the inference config rather than letting the sidecar choose", async () => {
    const sidecar = scriptedSidecar([outcome()]);
    await bindMultiAgent(deps(sidecar))(PROVIDER, "sys", "user", NO_RECENT);
    const req = sidecar.requests[0];
    assert.equal(req.inferenceConfig.model, "qwen3.5:35b-a3b-q4_K_M");
    assert.equal(req.inferenceConfig.baseUrl, "http://127.0.0.1:11434");
    assert.equal(req.inferenceConfig.temperature, 0.85);
  });

  it("carries think:false on the wire when the pinned profile sets it (A/B)", async () => {
    const sidecar = scriptedSidecar([outcome()]);
    await bindMultiAgent(
      deps(sidecar, {
        inference: {
          modelTag: "qwen3.5:35b-a3b-q4_K_M",
          modelDigest: null,
          settings: { think: false },
          baseUrl: "http://127.0.0.1:11434",
        },
      })
    )(PROVIDER, "sys", "user", NO_RECENT);
    assert.equal(sidecar.requests[0].inferenceConfig.think, false);
  });

  it("does NOT put think on the wire when the profile has empty settings (non-A/B)", async () => {
    const sidecar = scriptedSidecar([outcome()]);
    await bindMultiAgent(
      deps(sidecar, {
        inference: {
          modelTag: "qwen3.5:35b-a3b-q4_K_M",
          modelDigest: null,
          settings: {},
          baseUrl: "http://127.0.0.1:11434",
        },
      })
    )(PROVIDER, "sys", "user", NO_RECENT);
    assert.equal("think" in sidecar.requests[0].inferenceConfig, false);
  });

  it("caps QA revision cycles at 2 by default", async () => {
    const sidecar = scriptedSidecar([outcome()]);
    await bindMultiAgent(deps(sidecar))(PROVIDER, "sys", "user", NO_RECENT);
    assert.equal(sidecar.requests[0].attemptContext.maxQaRounds, 2);
  });

  it("carries the channel and language it was given", async () => {
    const sidecar = scriptedSidecar([outcome()]);
    await bindMultiAgent(deps(sidecar))(
      PROVIDER,
      "sys",
      "user",
      NO_RECENT,
      undefined,
      undefined,
      MAX_GENERATION_ATTEMPTS,
      undefined,
      { channel: "instagram", feedItemId: "fi-1", contentGroupId: null },
      "bg"
    );
    const req = sidecar.requests[0];
    assert.equal(req.platform, "instagram");
    assert.equal(req.language, "bg");
  });

  it("tells the next attempt why the previous one was rejected", async () => {
    const text =
      "Our summer collection lands on Friday with twelve new pieces and a restock of the linen shirt everyone asked for.";
    const sidecar = scriptedSidecar([
      outcome({ raw: candidate({ text }) }),
      outcome({ raw: candidate() }),
    ]);
    await bindMultiAgent(deps(sidecar))(PROVIDER, "sys", "user", [{ id: "post-1", text }]);
    assert.equal(sidecar.requests[0].attemptContext.previousRejection, null);
    assert.equal(sidecar.requests[1].attemptContext.previousRejection, "jaccard_duplicate");
    // And the retry prompt names the problem rather than merely asking again.
    assert.match(sidecar.requests[1].generationRequirements.userPrompt, /word for word/);
  });

  it("sends the article brief it was bound with, and never derives one itself", async () => {
    const sidecar = scriptedSidecar([outcome()]);
    await bindMultiAgent(
      deps(sidecar, {
        brief: {
          mainSubject: "A protest over coastal development",
          centralThesis: "Residents object to building in a protected area.",
          centralConflict: null,
          articleType: "news",
          secondaryTopics: ["tourism"],
          incidentalTopics: ["beaches"],
          entities: ["Coastal Council"],
          confidence: 0.82,
          source: "understanding",
        },
      })
    )(PROVIDER, "sys", "user", NO_RECENT);
    const brief = sidecar.requests[0].articleUnderstanding;
    assert.equal(brief.mainSubject, "A protest over coastal development");
    assert.equal(brief.source, "understanding");
  });

  it("sends the no-article brief for a mission post", async () => {
    const sidecar = scriptedSidecar([outcome()]);
    await bindMultiAgent(deps(sidecar))(PROVIDER, "sys", "user", NO_RECENT);
    assert.equal(sidecar.requests[0].articleUnderstanding.source, "none");
  });
});

describe("bindMultiAgent — the trace recorder", () => {
  it("reports every attempt, including the ones it discards", async () => {
    const records: GenerationAttemptRecord[] = [];
    const sidecar = scriptedSidecar([
      outcome({ qaState: "rejected_unroutable" }),
      outcome({ qaState: "pass" }),
    ]);
    await bindMultiAgent(deps(sidecar))(
      PROVIDER,
      "sys",
      "user",
      NO_RECENT,
      undefined,
      undefined,
      MAX_GENERATION_ATTEMPTS,
      (r) => records.push(r)
    );
    assert.equal(records.length, 2);
    assert.equal(records[0].accepted, false);
    assert.equal(records[0].willRetry, true);
    assert.equal(records[1].accepted, true);
    // The QA verdict rides on the provider payload, so the trace shows what the
    // critic said, not merely that an attempt happened.
    const payload = records[0].rawProviderPayload as { qaState: QaState };
    assert.equal(payload.qaState, "rejected_unroutable");
  });

  it("records the attempt that died when the sidecar threw", async () => {
    const records: GenerationAttemptRecord[] = [];
    const sidecar = scriptedSidecar([new CrewSidecarError("timeout", "budget exceeded")]);
    await assert.rejects(
      bindMultiAgent(deps(sidecar))(
        PROVIDER,
        "sys",
        "user",
        NO_RECENT,
        undefined,
        undefined,
        MAX_GENERATION_ATTEMPTS,
        (r) => records.push(r)
      )
    );
    assert.equal(records.length, 1);
    assert.equal(records[0].rejectionReason, "provider_error");
  });

  it("survives a recorder that throws — an observer cannot break what it observes", async () => {
    const sidecar = scriptedSidecar([outcome()]);
    const result = await bindMultiAgent(deps(sidecar))(
      PROVIDER,
      "sys",
      "user",
      NO_RECENT,
      undefined,
      undefined,
      MAX_GENERATION_ATTEMPTS,
      () => {
        throw new Error("the trace store is on fire");
      }
    );
    assert.ok(result.parsed.text.length > 0);
  });
});
