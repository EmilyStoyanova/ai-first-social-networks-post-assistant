import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getPostGenerationTrace,
  type GetPostGenerationTraceDb,
} from "./get-post-generation-trace.service";

/**
 * Reading a trace back: who may, and whether the references resolve.
 */

interface FakeRun {
  id: string;
  postId: string | null;
  feedItemId: string | null;
  kind: string;
  steps: Array<{ id: string; sequence: number; type: string; linkedRunId: string | null }>;
}

function makeDb(runs: FakeRun[], postExists = true) {
  const queries: Array<Record<string, unknown>> = [];

  const row = (run: FakeRun) => ({
    id: run.id,
    kind: run.kind,
    trigger: "manual",
    status: "completed",
    channel: "linkedin",
    language: "en",
    postId: run.postId,
    feedItemId: run.feedItemId,
    contentGroupId: null,
    generationBatchId: null,
    scheduleId: null,
    jobId: null,
    llmProvider: "GROQ",
    llmModel: "llama",
    attempts: 1,
    startedAt: new Date("2026-03-01T10:00:00.000Z"),
    completedAt: new Date("2026-03-01T10:00:05.000Z"),
    durationMs: 5000,
    errorCode: null,
    errorMessage: null,
    options: null,
    truncated: false,
    user: null,
    steps: run.steps.map((s) => ({
      id: s.id,
      sequence: s.sequence,
      type: s.type,
      label: null,
      status: "success" as const,
      attempt: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
      input: null,
      output: null,
      metadata: null,
      errorMessage: null,
      linkedRunId: s.linkedRunId,
    })),
  });

  const db = {
    post: {
      findUnique: async () => (postExists ? { id: "post-1" } : null),
    },
    generationRun: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        queries.push(args.where);
        if ("postId" in args.where) {
          return runs.filter((r) => r.postId === args.where.postId).map(row);
        }
        const ids = (args.where.id as { in: string[] }).in;
        return runs.filter((r) => ids.includes(r.id)).map(row);
      },
    },
  } as unknown as GetPostGenerationTraceDb;

  return { db, queries: () => queries };
}

describe("getPostGenerationTrace — access", () => {
  it("refuses a non-admin without looking anything up", async () => {
    const { db, queries } = makeDb([]);
    const result = await getPostGenerationTrace("post-1", false, db);

    assert.equal(result.success, false);
    assert.equal(result.success === false && result.code, "FORBIDDEN");
    assert.equal(queries().length, 0, "nothing should be read for a caller who may not read it");
  });

  it("reports a missing post as NOT_FOUND, distinctly from an empty trace", async () => {
    const { db } = makeDb([], false);
    const result = await getPostGenerationTrace("post-gone", true, db);
    assert.equal(result.success === false && result.code, "NOT_FOUND");
  });

  it("a post that predates tracing succeeds with no runs", async () => {
    const { db } = makeDb([]);
    const result = await getPostGenerationTrace("post-1", true, db);
    assert.equal(result.success, true);
    assert.equal(result.success && result.data.runs.length, 0);
  });
});

describe("getPostGenerationTrace — linked runs", () => {
  it("resolves a step's linked translation run in one extra query", async () => {
    const { db, queries } = makeDb([
      {
        id: "run-post",
        postId: "post-1",
        feedItemId: null,
        kind: "post_generation",
        steps: [
          { id: "s1", sequence: 1, type: "request", linkedRunId: null },
          { id: "s2", sequence: 2, type: "translation", linkedRunId: "run-translation" },
          { id: "s3", sequence: 3, type: "classification", linkedRunId: "run-classify" },
        ],
      },
      {
        id: "run-translation",
        postId: null,
        feedItemId: "item-1",
        kind: "translation",
        steps: [{ id: "t1", sequence: 1, type: "prompt", linkedRunId: null }],
      },
      {
        id: "run-classify",
        postId: null,
        feedItemId: "item-1",
        kind: "classification",
        steps: [{ id: "c1", sequence: 1, type: "prompt", linkedRunId: null }],
      },
    ]);

    const result = await getPostGenerationTrace("post-1", true, db);
    assert.equal(result.success, true);
    if (!result.success) return;

    assert.equal(result.data.runs.length, 1);
    assert.deepEqual(Object.keys(result.data.linkedRuns).sort(), [
      "run-classify",
      "run-translation",
    ]);
    assert.equal(result.data.linkedRuns["run-translation"].kind, "translation");
    // One query for the post's runs, one for every reference they hold.
    assert.equal(queries().length, 2, "linked runs must not be an N+1");
  });

  it("a reference that no longer resolves is simply absent", async () => {
    // The feed item was deleted with its source, taking its run with it. The
    // post's step survives as the record of what it was built from — which is
    // exactly why `linkedRunId` is not a foreign key.
    const { db } = makeDb([
      {
        id: "run-post",
        postId: "post-1",
        feedItemId: null,
        kind: "post_generation",
        steps: [{ id: "s1", sequence: 1, type: "translation", linkedRunId: "run-gone" }],
      },
    ]);

    const result = await getPostGenerationTrace("post-1", true, db);
    assert.equal(result.success, true);
    if (!result.success) return;

    assert.equal(result.data.runs[0].steps[0].linkedRunId, "run-gone");
    assert.equal(result.data.linkedRuns["run-gone"], undefined);
  });

  it("makes no linked-run query when no step references one", async () => {
    const { db, queries } = makeDb([
      {
        id: "run-post",
        postId: "post-1",
        feedItemId: null,
        kind: "post_generation",
        steps: [{ id: "s1", sequence: 1, type: "request", linkedRunId: null }],
      },
    ]);

    await getPostGenerationTrace("post-1", true, db);
    assert.equal(queries().length, 1);
  });
});
