import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runPendingExtractions } from "./run-pending-extractions.service";
import type { ExtractableItem, ExtractProductPageOutcome } from "./extract-product-page.service";

function item(id: string): ExtractableItem {
  return {
    id,
    title: "Business events",
    content: JSON.stringify({ instructions: "List them.", pageText: "an event" }),
    url: `https://events.example.com/${id}`,
    extractionStatus: "pending",
    extractionHash: "h",
    extractionAttemptCount: 0,
  };
}

const EXTRACTED: ExtractProductPageOutcome = {
  status: "extracted",
  provider: "TEXT_WORKER",
  model: "qwen3:8b",
  contentLength: 120,
};

describe("runPendingExtractions", () => {
  it("extracts every pending item in the batch and counts the outcomes", async () => {
    const seen: string[] = [];
    const summary = await runPendingExtractions({
      selectPending: async () => [item("a"), item("b")],
      countPending: async () => 0,
      extract: async (i) => {
        seen.push(i.id);
        return EXTRACTED;
      },
    });

    assert.deepEqual(seen, ["a", "b"]);
    assert.equal(summary.examined, 2);
    assert.equal(summary.extracted, 2);
    assert.equal(summary.remaining, 0);
  });

  it("keeps going after one page fails, and counts it", async () => {
    // One unextractable page must not deny the rest of the batch their run.
    const seen: string[] = [];
    const summary = await runPendingExtractions({
      selectPending: async () => [item("a"), item("b"), item("c")],
      countPending: async () => 0,
      extract: async (i) => {
        seen.push(i.id);
        if (i.id === "a") return { status: "failed", error: "worker unreachable" };
        return EXTRACTED;
      },
    });

    assert.deepEqual(seen, ["a", "b", "c"]);
    assert.equal(summary.failed, 1);
    assert.equal(summary.extracted, 2);
  });

  it("survives an item that throws outright", async () => {
    const summary = await runPendingExtractions({
      selectPending: async () => [item("a"), item("b")],
      countPending: async () => 0,
      extract: async (i) => {
        if (i.id === "a") throw new Error("database went away");
        return EXTRACTED;
      },
    });

    assert.equal(summary.failed, 1);
    assert.equal(summary.extracted, 1);
  });

  it("counts a not-found page as a run that succeeded, not as a failure", async () => {
    const summary = await runPendingExtractions({
      selectPending: async () => [item("a")],
      countPending: async () => 0,
      extract: async () => ({ status: "not_found", reason: "only this week is listed" }),
    });

    assert.equal(summary.notFound, 1);
    assert.equal(summary.failed, 0);
  });

  it("stops the whole batch when no provider is configured", async () => {
    // An operator problem: every remaining item would fail the same way, and each
    // ask would be a wasted round trip.
    let calls = 0;
    const summary = await runPendingExtractions({
      selectPending: async () => [item("a"), item("b"), item("c")],
      countPending: async () => 3,
      extract: async () => {
        calls += 1;
        return { status: "no_provider" };
      },
    });

    assert.equal(calls, 1);
    assert.equal(summary.skipped, 3);
    assert.equal(summary.remaining, 3);
  });

  it("reports the backlog so the handler can chain another run", async () => {
    const summary = await runPendingExtractions({
      selectPending: async () => [item("a")],
      countPending: async () => 7,
      extract: async () => EXTRACTED,
      batchSize: 1,
    });

    assert.equal(summary.remaining, 7);
  });

  it("does nothing when there is nothing pending", async () => {
    const summary = await runPendingExtractions({
      selectPending: async () => [],
      countPending: async () => 0,
      extract: async () => {
        throw new Error("must not be called");
      },
    });

    assert.equal(summary.examined, 0);
    assert.equal(summary.remaining, 0);
  });
});
