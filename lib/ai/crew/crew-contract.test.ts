import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  crewPostResponseSchema,
  resolveQaState,
  validateCallCounts,
  type CrewPostRequest,
  type CrewPostResponse,
} from "./crew-contract";

/** A clean Writer → Editor → QA → PASS run: 3 calls, 0 revisions. */
function passResponse(overrides: Partial<CrewPostResponse> = {}): CrewPostResponse {
  return {
    status: "ok",
    candidate: { raw: '{"text":"a post","coreMessage":"a claim"}' },
    qa: { finalDecision: "pass", revisions: 0, issues: [], routes: [] },
    agentCalls: { writer: 1, editor: 1, qa: 1 },
    latencyMs: 1200,
    model: { tag: "qwen3.5:35b-a3b-q4_K_M", digest: "sha256:abc" },
    degradedStages: [],
    ...overrides,
  };
}

describe("crewPostResponseSchema", () => {
  it("accepts the clean pass shape", () => {
    const parsed = crewPostResponseSchema.safeParse(passResponse());
    assert.equal(parsed.success, true);
  });

  it("REFUSES an unrecognised finalDecision rather than defaulting it", () => {
    // Every possible default is wrong: `pass` would accept a post no critic
    // approved, `unavailable` would record a degradation that did not happen.
    const parsed = crewPostResponseSchema.safeParse(
      passResponse({
        qa: {
          finalDecision: "looks_fine" as unknown as CrewPostResponse["qa"]["finalDecision"],
          revisions: 0,
          issues: [],
          routes: [],
        },
      })
    );
    assert.equal(parsed.success, false);
  });

  it("REFUSES a missing finalDecision", () => {
    const body = passResponse() as unknown as Record<string, unknown>;
    delete (body.qa as Record<string, unknown>).finalDecision;
    assert.equal(crewPostResponseSchema.safeParse(body).success, false);
  });

  it("REFUSES an unknown top-level field — a newer sidecar must fail loudly", () => {
    const body = { ...passResponse(), newFieldFromANewerSidecar: true };
    assert.equal(crewPostResponseSchema.safeParse(body).success, false);
  });

  it("REFUSES an empty candidate", () => {
    const parsed = crewPostResponseSchema.safeParse(passResponse({ candidate: { raw: "" } }));
    assert.equal(parsed.success, false);
  });

  it("accepts a null digest — an Ollama build that exposes none", () => {
    const parsed = crewPostResponseSchema.safeParse(
      passResponse({ model: { tag: "qwen3:8b", digest: null } })
    );
    assert.equal(parsed.success, true);
  });
});

describe("validateCallCounts — requirement 6, as arithmetic", () => {
  it("passes the clean 3-call run", () => {
    assert.equal(validateCallCounts(passResponse(), 2), null);
  });

  it("passes an editor-routed round: 3 + 2R", () => {
    // Writer → Editor → QA → [Editor → QA] = 1 writer, 2 editor, 2 qa.
    const r = passResponse({
      qa: { finalDecision: "pass", revisions: 1, issues: [], routes: ["editor"] },
      agentCalls: { writer: 1, editor: 2, qa: 2 },
    });
    assert.equal(validateCallCounts(r, 2), null);
  });

  it("passes a writer-routed round: 3 + 3R, with the Editor re-entered", () => {
    // Writer → Editor → QA → [Writer → Editor → QA] = 2 writer, 2 editor, 2 qa.
    const r = passResponse({
      qa: { finalDecision: "pass", revisions: 1, issues: [], routes: ["writer"] },
      agentCalls: { writer: 2, editor: 2, qa: 2 },
    });
    assert.equal(validateCallCounts(r, 2), null);
  });

  it("CATCHES a writer revision that bypassed the Editor", () => {
    // The regression the whole function exists for: Writer revised and went
    // straight back to QA, so the Editor count never moved off its initial 1.
    const r = passResponse({
      qa: { finalDecision: "pass", revisions: 1, issues: [], routes: ["writer"] },
      agentCalls: { writer: 2, editor: 1, qa: 2 },
    });
    const problem = validateCallCounts(r, 2);
    assert.notEqual(problem, null);
    assert.match(problem!.problem, /Editor was bypassed/);
  });

  it("CATCHES the same bypass at R=2, all writer-routed", () => {
    // 3 + 3R at R=2 is 2 writer + 3 editor + 3 qa... writer=3, editor=3, qa=3.
    const honest = passResponse({
      qa: { finalDecision: "pass", revisions: 2, issues: [], routes: ["writer", "writer"] },
      agentCalls: { writer: 3, editor: 3, qa: 3 },
    });
    assert.equal(validateCallCounts(honest, 2), null);

    const bypassed = passResponse({
      qa: { finalDecision: "pass", revisions: 2, issues: [], routes: ["writer", "writer"] },
      agentCalls: { writer: 3, editor: 2, qa: 3 },
    });
    assert.match(validateCallCounts(bypassed, 2)!.problem, /Editor was bypassed/);
  });

  it("CATCHES revisions above the caller's bound", () => {
    const r = passResponse({
      qa: {
        finalDecision: "pass",
        revisions: 3,
        issues: [],
        routes: ["writer", "editor", "writer"],
      },
      agentCalls: { writer: 3, editor: 4, qa: 4 },
    });
    const problem = validateCallCounts(r, 2);
    assert.match(problem!.problem, /above the 2 allowed/);
  });

  it("CATCHES a revision count that disagrees with the routes named", () => {
    const r = passResponse({
      qa: { finalDecision: "pass", revisions: 2, issues: [], routes: ["editor"] },
      agentCalls: { writer: 1, editor: 3, qa: 3 },
    });
    assert.match(validateCallCounts(r, 2)!.problem, /named 1 routes/);
  });

  it("CATCHES a revision that produced no QA call — accepted without re-judging", () => {
    const r = passResponse({
      qa: { finalDecision: "pass", revisions: 1, issues: [], routes: ["editor"] },
      agentCalls: { writer: 1, editor: 2, qa: 1 },
    });
    assert.match(validateCallCounts(r, 2)!.problem, /require at least 2 QA call/);
  });

  it("allows a short QA count only when QA is reported unavailable", () => {
    const r = passResponse({
      qa: { finalDecision: "unavailable", revisions: 0, issues: [], routes: [] },
      agentCalls: { writer: 1, editor: 1, qa: 0 },
      degradedStages: ["qa"],
    });
    assert.equal(validateCallCounts(r, 2), null);
  });

  it("allows a short Editor count only when the Editor is named as degraded", () => {
    const degraded = passResponse({
      agentCalls: { writer: 1, editor: 0, qa: 1 },
      degradedStages: ["editor"],
    });
    assert.equal(validateCallCounts(degraded, 2), null);

    const undeclared = passResponse({ agentCalls: { writer: 1, editor: 0, qa: 1 } });
    assert.match(validateCallCounts(undeclared, 2)!.problem, /No Editor call/);
  });

  it("CATCHES a run that reported no Writer call at all", () => {
    const r = passResponse({ agentCalls: { writer: 0, editor: 1, qa: 1 } });
    assert.match(validateCallCounts(r, 2)!.problem, /No Writer call/);
  });
});

describe("the shared request fixture", () => {
  it("still matches the request contract both sides read", () => {
    // `sidecar/crewai/fixtures/request.json` is what the Python side's manual
    // verification (README.md §4) curls at the service. If the TypeScript
    // contract moves and the fixture does not, the two ends stop testing the
    // same thing — and they would stop silently, because a Python `curl` cannot
    // know what this file's types say. Typing the parsed fixture is what makes
    // that a compile error here.
    const fixture: CrewPostRequest = JSON.parse(
      readFileSync(join(process.cwd(), "sidecar", "crewai", "fixtures", "request.json"), "utf8")
    );

    assert.equal(fixture.generationRequirements.responseContract, "llm_post_json");
    assert.equal(fixture.attemptContext.maxQaRounds, 2, "the fixture must exercise R=2");
    assert.equal(fixture.articleUnderstanding.source, "understanding");
    // The sidecar must never be pointed anywhere but loopback Ollama.
    assert.match(fixture.inferenceConfig.baseUrl, /^http:\/\/127\.0\.0\.1/);
    // And it must be pinned to the validated Qwen, with no cloud model anywhere.
    assert.equal(fixture.inferenceConfig.model, "qwen3.5:35b-a3b-q4_K_M");
  });

  it("pins NO sampling parameters", () => {
    // A live Mac run failed with CrewAI's `Invalid response from LLM call -
    // None or empty` because this fixture pinned `numPredict: 1024`. That
    // becomes Ollama's `num_predict`, and qwen3.5 is a reasoning model whose
    // `<think>` preamble is charged against the same budget — so it was cut off
    // mid-reasoning and emitted no answer at all. The isolated POC, which
    // passed model and base_url and nothing else, worked.
    //
    // Pinning nothing is also the CORRECT A/B default: the control arm's
    // TextWorkerProvider forwards temperature/maxTokens to Ollama only when
    // `format` is set, and post generation never sets it — so the control arm
    // sends no sampling either. An arm that pinned it here would differ on
    // sampling while reporting the same model, silently invalidating an
    // experiment meant to vary orchestration alone.
    const fixture: CrewPostRequest = JSON.parse(
      readFileSync(join(process.cwd(), "sidecar", "crewai", "fixtures", "request.json"), "utf8")
    );
    const pinned = Object.keys(fixture.inferenceConfig).filter(
      (k) => k !== "model" && k !== "baseUrl"
    );
    assert.deepEqual(pinned, [], `the fixture must pin no sampling, but pinned: ${pinned}`);
  });
});

describe("resolveQaState", () => {
  it("passes a terminal verdict through", () => {
    for (const state of ["pass", "rejected_unroutable", "unavailable"] as const) {
      const r = resolveQaState(
        passResponse({ qa: { finalDecision: state, revisions: 0, issues: [], routes: [] } })
      );
      assert.equal(r.ok, true);
      assert.equal(r.ok === true ? r.state : null, state);
    }
  });

  it("refuses a mid-loop verdict as non_converged, not as the nearest state", () => {
    // Mapping `revise_writer` to pass would accept an unjudged post; mapping it
    // to unavailable would claim QA never ran when it plainly did.
    for (const state of ["revise_writer", "revise_editor"] as const) {
      const r = resolveQaState(
        passResponse({ qa: { finalDecision: state, revisions: 1, issues: [], routes: ["writer"] } })
      );
      assert.equal(r.ok, false);
      assert.equal(r.ok === false ? r.code : null, "non_converged");
    }
  });
});
