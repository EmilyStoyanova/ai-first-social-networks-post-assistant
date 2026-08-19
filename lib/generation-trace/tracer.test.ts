import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GenerationTracer, tracingEnabled } from "./tracer";
import type { GenerationTraceStore, PersistableRun } from "./store";
import { REDACTED } from "./redact";

/** A store that records what it was asked to save. */
function makeStore(): { store: GenerationTraceStore; saved: () => PersistableRun[] } {
  const runs: PersistableRun[] = [];
  return {
    store: {
      saveRun: async (run) => {
        runs.push(run);
      },
    },
    saved: () => runs,
  };
}

function startTracer(store: GenerationTraceStore) {
  return GenerationTracer.start({
    kind: "post_generation",
    trigger: "manual",
    companyId: "company-1",
    channel: "LinkedIn",
    userId: "user-1",
    store,
    newId: () => "run-1",
  });
}

describe("GenerationTracer — buffering and flush", () => {
  it("writes nothing until flush, then writes the whole run at once", async () => {
    const { store, saved } = makeStore();
    const tracer = startTracer(store);

    tracer.step({ type: "request" });
    tracer.step({ type: "prompt", input: { systemPrompt: "S", userPrompt: "U" } });
    assert.equal(saved().length, 0, "a step must not hit the database on its own");

    await tracer.flush();

    assert.equal(saved().length, 1);
    assert.equal(saved()[0].steps.length, 2);
  });

  it("numbers steps densely, in call order", async () => {
    const { store, saved } = makeStore();
    const tracer = startTracer(store);
    tracer.step({ type: "request" });
    tracer.step({ type: "source" });
    tracer.step({ type: "prompt" });
    await tracer.flush();

    assert.deepEqual(
      saved()[0].steps.map((s) => [s.sequence, s.type]),
      [
        [1, "request"],
        [2, "source"],
        [3, "prompt"],
      ]
    );
  });

  it("is idempotent — a second flush writes nothing more", async () => {
    const { store, saved } = makeStore();
    const tracer = startTracer(store);
    tracer.step({ type: "request" });
    await tracer.flush();
    await tracer.flush();
    assert.equal(saved().length, 1);
  });

  it("normalizes the channel to the enum value, and drops an unknown one", async () => {
    const { store, saved } = makeStore();
    const tracer = startTracer(store);
    await tracer.flush();
    assert.equal(saved()[0].channel, "linkedin");

    const second = makeStore();
    const other = GenerationTracer.start({
      kind: "post_generation",
      trigger: "manual",
      channel: "mastodon",
      store: second.store,
    });
    await other.flush();
    assert.equal(second.saved()[0].channel, null);
  });
});

describe("GenerationTracer — reliability", () => {
  it("never rejects when the store throws, and says so loudly", async () => {
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };

    try {
      const tracer = GenerationTracer.start({
        kind: "post_generation",
        trigger: "manual",
        store: {
          saveRun: async () => {
            throw new Error("column too large");
          },
        },
        newId: () => "run-boom",
      });
      tracer.step({ type: "request" });

      // The whole contract in one line: a trace write failure is not the
      // caller's problem, and a generation must not be failed by it.
      await assert.doesNotReject(() => tracer.flush());

      const logged = errors.flat().join(" ");
      assert.ok(logged.includes("[generation-trace]"), "the failure must be diagnosable");
      assert.ok(logged.includes("run-boom"), "the log must name the run");
    } finally {
      console.error = originalError;
    }
  });

  it("swallows a step it cannot record rather than throwing at the call site", async () => {
    const { store, saved } = makeStore();
    const tracer = startTracer(store);

    const hostile = {
      get boom(): string {
        throw new Error("nope");
      },
    };
    assert.doesNotThrow(() => tracer.step({ type: "context", output: hostile }));

    await tracer.flush();
    assert.equal(saved()[0].steps.length, 1);
  });

  it("a disabled tracer accepts everything and writes nothing", async () => {
    const tracer = GenerationTracer.disabled();
    tracer.step({ type: "request" });
    tracer.setPost("post-1");
    tracer.fail("SOMETHING", "went wrong");
    await tracer.flush();
    assert.equal(tracer.peekSteps().length, 0);
    assert.equal(tracer.enabled, false);
  });

  it("does not arm itself when there is no database to write to", () => {
    // Otherwise the default store spends a connection timeout finding that out —
    // on every generation, and on every unit test that exercises a traced
    // service without injecting a store. That is not hypothetical: it turned an
    // 800ms extraction test file into an 87-second one.
    const previous = process.env.DATABASE_URL;
    const previousFlag = process.env.GENERATION_TRACE_ENABLED;
    delete process.env.DATABASE_URL;
    delete process.env.GENERATION_TRACE_ENABLED;

    try {
      assert.equal(tracingEnabled(), false);
      const tracer = GenerationTracer.start({ kind: "post_generation", trigger: "manual" });
      assert.equal(tracer.enabled, false);

      // …but an explicitly supplied store always wins: the caller has said where
      // the run goes, which is exactly how the tests above work.
      const { store } = makeStore();
      assert.equal(
        GenerationTracer.start({ kind: "post_generation", trigger: "manual", store }).enabled,
        true
      );

      process.env.DATABASE_URL = "postgresql://example";
      assert.equal(tracingEnabled(), true);
      process.env.GENERATION_TRACE_ENABLED = "false";
      assert.equal(tracingEnabled(), false, "the operator escape hatch still wins");
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
      if (previousFlag === undefined) delete process.env.GENERATION_TRACE_ENABLED;
      else process.env.GENERATION_TRACE_ENABLED = previousFlag;
    }
  });
});

describe("GenerationTracer — run-level facts", () => {
  it("records a post id, the model and the attempt count", async () => {
    const { store, saved } = makeStore();
    const tracer = startTracer(store);
    tracer.setPost("post-9");
    tracer.setLlm("GROQ", "llama-3.3-70b");
    tracer.setAttempts(2);
    // A LOWER attempt number never walks the count backwards.
    tracer.setAttempts(1);
    await tracer.flush();

    const run = saved()[0];
    assert.equal(run.postId, "post-9");
    assert.equal(run.llmProvider, "GROQ");
    assert.equal(run.llmModel, "llama-3.3-70b");
    assert.equal(run.attempts, 2);
    assert.equal(run.status, "completed");
  });

  it("a recorded failure makes the run status `failed`", async () => {
    const { store, saved } = makeStore();
    const tracer = startTracer(store);
    tracer.fail("CANNOT_GENERATE_UNIQUE_POST", "Too similar after 3 attempts.");
    await tracer.flush();

    assert.equal(saved()[0].status, "failed");
    assert.equal(saved()[0].errorCode, "CANNOT_GENERATE_UNIQUE_POST");
  });

  it("sanitizes every captured payload on the way in", async () => {
    const { store, saved } = makeStore();
    const tracer = GenerationTracer.start({
      kind: "post_generation",
      trigger: "manual",
      store,
      options: { apiKey: "abcdef0123456789" },
    });
    tracer.step({ type: "llm_call", metadata: { authorization: "Bearer abcdefghijklmnop" } });
    await tracer.flush();

    const run = saved()[0];
    assert.equal((run.options as Record<string, unknown>).apiKey, REDACTED);
    assert.equal((run.steps[0].metadata as Record<string, unknown>).authorization, REDACTED);
  });

  it("marks the run truncated when any value was shortened", async () => {
    const { store, saved } = makeStore();
    const tracer = startTracer(store);
    tracer.step({ type: "raw_response", output: { text: "z".repeat(60_000) } });
    await tracer.flush();
    assert.equal(saved()[0].truncated, true);
  });
});
