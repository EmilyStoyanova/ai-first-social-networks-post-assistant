import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createRequestDeadline,
  runInRequestDeadline,
  requestTimeoutMs,
  remainingBudgetMs,
  recordPhase,
  raceWithTimeout,
  type Timer,
} from "./request-deadline";

describe("requestTimeoutMs — budget-derived request timeouts", () => {
  it("returns the per-request cap unchanged outside any deadline", () => {
    assert.equal(requestTimeoutMs(90_000), 90_000);
  });

  it("caps a request at the time left to the deadline when that is smaller", () => {
    let clock = 1_000;
    const ctx = createRequestDeadline(1_000 + 5_000, () => clock);
    runInRequestDeadline(ctx, () => {
      // 5s of budget left, per-request cap 120s → the budget wins.
      assert.equal(requestTimeoutMs(120_000), 5_000);
      clock += 2_000; // 3s left now
      assert.equal(requestTimeoutMs(120_000), 3_000);
    });
  });

  it("keeps the per-request cap when it is smaller than the remaining budget", () => {
    const ctx = createRequestDeadline(1_000 + 300_000, () => 1_000);
    runInRequestDeadline(ctx, () => {
      assert.equal(requestTimeoutMs(30_000), 30_000);
    });
  });

  it("never returns a negative timeout once the deadline has passed (aborts immediately)", () => {
    const ctx = createRequestDeadline(1_000, () => 9_999); // already past
    runInRequestDeadline(ctx, () => {
      assert.equal(requestTimeoutMs(90_000), 0);
    });
  });

  it("remainingBudgetMs is +Infinity outside a deadline", () => {
    assert.equal(remainingBudgetMs(), Number.POSITIVE_INFINITY);
  });
});

describe("recordPhase — phase timing accumulation", () => {
  it("accumulates elapsed ms per named phase on the ambient deadline", async () => {
    const ctx = createRequestDeadline(Date.now() + 60_000);
    await runInRequestDeadline(ctx, async () => {
      await recordPhase("llm", async () => {});
      await recordPhase("llm", async () => {});
      await recordPhase("image", async () => {});
    });
    assert.equal(typeof ctx.phases.llm, "number");
    assert.equal(typeof ctx.phases.image, "number");
    // Two llm calls both recorded under the same key.
    assert.ok("llm" in ctx.phases && "image" in ctx.phases);
  });

  it("is a transparent no-op outside a deadline (returns the fn value, records nothing)", async () => {
    const value = await recordPhase("llm", async () => 42);
    assert.equal(value, 42);
  });
});

describe("raceWithTimeout — out-of-band guarantee", () => {
  const immediate: Timer = () => ({ promise: Promise.resolve(), cancel: () => {} });
  const never: Timer = () => ({ promise: new Promise<void>(() => {}), cancel: () => {} });

  it("returns the work value when work wins", async () => {
    const r = await raceWithTimeout(Promise.resolve("done"), 1_000, never);
    assert.deepEqual(r, { timedOut: false, value: "done" });
  });

  it("returns timedOut when the timer wins, even if work never resolves", async () => {
    const r = await raceWithTimeout(new Promise<string>(() => {}), 1_000, immediate);
    assert.deepEqual(r, { timedOut: true });
  });

  it("swallows a late rejection of abandoned work (no unhandled rejection)", async () => {
    let reject!: (e: unknown) => void;
    const work = new Promise<string>((_res, rej) => {
      reject = rej;
    });
    const r = await raceWithTimeout(work, 1_000, immediate);
    assert.deepEqual(r, { timedOut: true });
    // The timer already won; a rejection arriving afterwards must not throw.
    reject(new Error("late failure"));
    await new Promise((res) => setTimeout(res, 0));
  });

  it("propagates a work rejection that arrives before the timer", async () => {
    await assert.rejects(raceWithTimeout(Promise.reject(new Error("boom")), 1_000, never), /boom/);
  });
});
