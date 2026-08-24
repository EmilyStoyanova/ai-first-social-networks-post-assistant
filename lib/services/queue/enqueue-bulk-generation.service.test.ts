import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  enqueueBulkGeneration,
  type BulkGenerationRequest,
  type EnqueueBulkGenerationDeps,
} from "./enqueue-bulk-generation.service";
import { bulkGenerationPayloadSchema } from "@/lib/queue/bulk-generation-payload";
import { BULK_GENERATION_JOB_TYPE } from "@/lib/queue/job-types";

const SLUG = "acme";
const USER_ID = "user-1";
const COMPANY_ID = "company-1";

function makeRequest(overrides: Partial<BulkGenerationRequest> = {}): BulkGenerationRequest {
  return {
    channels: ["linkedin", "facebook"],
    numberOfPosts: 2,
    startDate: "2026-08-17",
    endDate: "2026-08-30",
    ...overrides,
  };
}

/** One enqueue the service asked for. */
interface RecordedEnqueue {
  type: string;
  payload: unknown;
  dedupeKey?: string;
  priority?: number;
  maxAttempts?: number;
  companyId?: string | null;
  createdBy?: string | null;
}

function makeDeps(
  options: {
    access?: { companyId: string } | null;
    deduplicated?: boolean;
    enabledSourceIds?: string[];
    runningJobId?: string | null;
    /** The channel's saved posting windows; configured unless a test says otherwise. */
    postingWindows?: unknown;
  } = {}
): { deps: EnqueueBulkGenerationDeps; enqueues: () => RecordedEnqueue[] } {
  const enqueues: RecordedEnqueue[] = [];
  let n = 0;

  return {
    enqueues: () => enqueues,
    deps: {
      resolveAccess: async () =>
        options.access === undefined ? { companyId: COMPANY_ID } : options.access,
      newBatchId: () => "batch-fixed",
      newContentGroupId: () => `group-${++n}`,
      loadEnabledSourceIds: async () => new Set(options.enabledSourceIds ?? ["source-a"]),
      // An even distribution is refused for a channel with no schedule, so the
      // default here is a configured one — otherwise every request below would
      // be rejected before reaching the rule it is actually about.
      loadPostingWindows: async () =>
        "postingWindows" in options
          ? options.postingWindows
          : [{ day: "MONDAY", start: "09:00", end: "17:00" }],
      findRunningJob: async () =>
        options.runningJobId === undefined
          ? { id: "job-running" }
          : options.runningJobId === null
            ? null
            : { id: options.runningJobId },
      // A week before START, so the period is still in the future.
      now: () => Date.parse("2026-08-10T09:00:00.000Z"),
      enqueue: async (input) => {
        enqueues.push(input as RecordedEnqueue);
        return options.deduplicated
          ? { enqueued: false, deduplicated: true, jobId: null }
          : { enqueued: true, deduplicated: false, jobId: "job-1" };
      },
    },
  };
}

// ─── The plan ─────────────────────────────────────────────────────────────────

describe("enqueueBulkGeneration — the plan", () => {
  it("mints the batch id and one group id per topic, up front", async () => {
    const { deps } = makeDeps();

    const result = await enqueueBulkGeneration(SLUG, USER_ID, false, makeRequest(), deps);

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.jobId, "job-1");
    assert.equal(result.data.batchId, "batch-fixed");
    // One per TOPIC — not per post row. A retry re-opens exactly these.
    assert.deepEqual(result.data.contentGroupIds, ["group-1", "group-2"]);
  });

  it("writes a payload the worker's own schema accepts", async () => {
    const { deps, enqueues } = makeDeps();

    await enqueueBulkGeneration(
      SLUG,
      USER_ID,
      false,
      makeRequest({
        numberOfPosts: 1,
        contentLanguage: "bg",
        includeSourceLink: true,
        generateImage: false,
        llmConfigId: "llm-1",
        // A mix, alone — a mix and a single picked source are alternatives, not
        // layers, and submitting both is refused (see the rejection suite).
        sourceMix: [{ sourceId: null, posts: 1 }],
      }),
      deps
    );

    // The same schema both ends import. If this passes, the worker can read it.
    const parsed = bulkGenerationPayloadSchema.safeParse(enqueues()[0].payload);
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
    if (!parsed.success) return;
    assert.equal(parsed.data.slug, SLUG);
    assert.equal(parsed.data.userId, USER_ID);
    assert.equal(parsed.data.batchId, "batch-fixed");
    assert.equal(parsed.data.contentLanguage, "bg");
    assert.deepEqual(parsed.data.sourceMix, [{ sourceId: null, posts: 1 }]);
  });

  it("never puts the session's admin flag in the payload", async () => {
    const { deps, enqueues } = makeDeps();

    await enqueueBulkGeneration(SLUG, USER_ID, true, makeRequest(), deps);

    // Admin rights are a property of the user at EXECUTION time; a snapshot here
    // would let a revoked admin's queued job still run as one.
    const payload = enqueues()[0].payload as Record<string, unknown>;
    assert.equal("isGlobalAdmin" in payload, false);
  });

  it("refuses a topic count that could never yield a plan", async () => {
    const { deps, enqueues } = makeDeps();

    const result = await enqueueBulkGeneration(
      SLUG,
      USER_ID,
      false,
      makeRequest({ numberOfPosts: 0 }),
      deps
    );

    assert.equal(result.success, false);
    if (result.success) return;
    // The specific request code rather than a generic payload complaint: the
    // request check runs first, and this is exactly what it was always called.
    assert.equal(result.code, "INVALID_POST_COUNT");
    // Nothing queued — the request never becomes a job.
    assert.equal(enqueues().length, 0);
  });

  it("refuses a repeated channel rather than asking for the same post twice", async () => {
    const { deps } = makeDeps();

    const result = await enqueueBulkGeneration(
      SLUG,
      USER_ID,
      false,
      makeRequest({ channels: ["linkedin", "linkedin"] }),
      deps
    );

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, "INVALID_PAYLOAD");
  });
});

// ─── Queue wiring ─────────────────────────────────────────────────────────────

describe("enqueueBulkGeneration — how the job is queued", () => {
  it("dedupes per company, so two companies never block each other", async () => {
    const { deps, enqueues } = makeDeps();

    await enqueueBulkGeneration(SLUG, USER_ID, false, makeRequest(), deps);

    assert.equal(enqueues()[0].type, BULK_GENERATION_JOB_TYPE);
    assert.equal(enqueues()[0].dedupeKey, `bulk-generation:${SLUG}`);
  });

  it("caps attempts at three and outranks the recurring sweeps", async () => {
    const { deps, enqueues } = makeDeps();

    await enqueueBulkGeneration(SLUG, USER_ID, false, makeRequest(), deps);

    // Every attempt costs LLM credits, and someone is waiting on this one.
    assert.equal(enqueues()[0].maxAttempts, 3);
    assert.ok((enqueues()[0].priority ?? 0) > 0);
  });

  it("records the company and the requester on the job row", async () => {
    const { deps, enqueues } = makeDeps();

    await enqueueBulkGeneration(SLUG, USER_ID, false, makeRequest(), deps);

    // What the status endpoint scopes its read by — written with the row, so the
    // job is never momentarily readable by the wrong company.
    assert.equal(enqueues()[0].companyId, COMPANY_ID);
    assert.equal(enqueues()[0].createdBy, USER_ID);
  });

  it("tells the second caller their batch did not start", async () => {
    const { deps } = makeDeps({ deduplicated: true });

    const result = await enqueueBulkGeneration(SLUG, USER_ID, false, makeRequest(), deps);

    // Unlike a cron sweep, this request carries its own instructions — the run
    // already in flight is NOT the run that was asked for.
    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, "ALREADY_RUNNING");
    assert.ok(result.message.length > 0);
  });

  it("hands back the run that is already going, so the caller can resume it", async () => {
    const { deps } = makeDeps({ deduplicated: true, runningJobId: "job-running" });

    const result = await enqueueBulkGeneration(SLUG, USER_ID, false, makeRequest(), deps);

    assert.equal(result.success, false);
    if (result.success || result.code !== "ALREADY_RUNNING") return;
    // Better than an error with no way back to the batch. The id only unlocks
    // the status endpoint, which is scoped to the same company access was just
    // granted for.
    assert.equal(result.jobId, "job-running");
  });

  it("still answers when the collision resolved before it could be read", async () => {
    const { deps } = makeDeps({ deduplicated: true, runningJobId: null });

    const result = await enqueueBulkGeneration(SLUG, USER_ID, false, makeRequest(), deps);

    assert.equal(result.success, false);
    if (result.success || result.code !== "ALREADY_RUNNING") return;
    assert.equal(result.jobId, null);
  });
});

// ─── The synchronous request contract ─────────────────────────────────────────

describe("enqueueBulkGeneration — request rejections, answered before queueing", () => {
  /**
   * Each of these was answered synchronously when the route ran the batch
   * inline. Moving the work to a worker must not turn any of them into a job
   * that fails in a log — so every case asserts the code AND that nothing was
   * queued.
   */
  const cases: Array<[string, Partial<BulkGenerationRequest>, string]> = [
    ["more topics than the cap allows", { numberOfPosts: 99 }, "INVALID_POST_COUNT"],
    ["a fractional number of topics", { numberOfPosts: 2.5 }, "INVALID_POST_COUNT"],
    [
      "an end date before the start",
      { startDate: "2026-08-30", endDate: "2026-08-17" },
      "INVALID_DATE_RANGE",
    ],
    [
      "a start date that has gone by",
      { startDate: "2026-08-01", endDate: "2026-08-30" },
      "START_DATE_IN_PAST",
    ],
    [
      "a schedule that does not add up to the topics requested",
      { distribution: [{ date: "2026-08-18", count: 1, times: ["10:00"] }] },
      "INVALID_DISTRIBUTION",
    ],
    [
      "a schedule with a date outside the period",
      {
        numberOfPosts: 1,
        distribution: [{ date: "2027-01-05", count: 1, times: ["10:00"] }],
      },
      "INVALID_DISTRIBUTION",
    ],
    [
      "a mix that does not add up to the topics requested",
      { sourceMix: [{ sourceId: "source-a", posts: 1 }] },
      "INVALID_SOURCE_MIX",
    ],
    [
      "a mix naming a source this company does not have",
      { sourceMix: [{ sourceId: "source-zzz", posts: 2 }] },
      "INVALID_SOURCE_MIX",
    ],
    [
      "a mix and a single picked source together",
      { sourceMix: [{ sourceId: "source-a", posts: 2 }], contentSource: "source-a" },
      "INVALID_SOURCE_MIX",
    ],
  ];

  for (const [name, overrides, code] of cases) {
    it(`refuses ${name} without queueing anything`, async () => {
      const { deps, enqueues } = makeDeps();

      const result = await enqueueBulkGeneration(
        SLUG,
        USER_ID,
        false,
        makeRequest(overrides),
        deps
      );

      assert.equal(result.success, false);
      if (result.success) return;
      assert.equal(result.code, code);
      assert.ok((result as { message: string }).message.length > 0);
      // The load-bearing half: a refused request never becomes a job, so it
      // never occupies the company's dedupe slot either.
      assert.equal(enqueues().length, 0);
    });
  }

  it("refuses an even spread over a channel with no posting schedule", async () => {
    // Answered here, synchronously, rather than becoming a job that plans no
    // slots and reports a batch of zero. Nothing about this request can be
    // fixed by running it.
    for (const windows of [null, [], "nonsense"]) {
      const { deps, enqueues } = makeDeps({ postingWindows: windows });

      const result = await enqueueBulkGeneration(SLUG, USER_ID, false, makeRequest(), deps);

      assert.equal(result.success, false);
      if (result.success) return;
      assert.equal(result.code, "NO_POSTING_WINDOWS", `for ${JSON.stringify(windows)}`);
      assert.equal(enqueues().length, 0);
    }
  });

  it("queues a CUSTOM distribution for a channel with no posting schedule", async () => {
    // The other half of the same rule, and the reason the check is scoped to
    // even distributions: the user named every date and time, so a channel
    // without a schedule of its own is no obstacle at all.
    const { deps, enqueues } = makeDeps({ postingWindows: null });

    const result = await enqueueBulkGeneration(
      SLUG,
      USER_ID,
      false,
      makeRequest({
        numberOfPosts: 2,
        distribution: [
          { date: "2026-08-18", count: 1, times: ["11:30"] },
          { date: "2026-08-20", count: 1, times: ["14:30"] },
        ],
      }),
      deps
    );

    assert.equal(result.success, true);
    assert.equal(enqueues().length, 1);
  });

  it("queues a valid request that uses every optional field", async () => {
    const { deps, enqueues } = makeDeps();

    const result = await enqueueBulkGeneration(
      SLUG,
      USER_ID,
      false,
      makeRequest({
        numberOfPosts: 2,
        distribution: [
          { date: "2026-08-18", count: 1, times: ["10:00"] },
          { date: "2026-08-20", count: 1, times: ["14:30"] },
        ],
        sourceMix: [{ sourceId: "source-a", posts: 2 }],
      }),
      deps
    );

    assert.equal(result.success, true);
    assert.equal(enqueues().length, 1);
  });

  it("checks the request before minting a plan or touching the queue", async () => {
    const { deps, enqueues } = makeDeps();

    const result = await enqueueBulkGeneration(
      SLUG,
      USER_ID,
      false,
      makeRequest({ numberOfPosts: 99 }),
      deps
    );

    assert.equal(result.success, false);
    assert.equal(enqueues().length, 0);
  });
});

// ─── Access ───────────────────────────────────────────────────────────────────

describe("enqueueBulkGeneration — access", () => {
  it("refuses a company this user is not a member of, before minting anything", async () => {
    const { deps, enqueues } = makeDeps({ access: null });

    const result = await enqueueBulkGeneration(SLUG, USER_ID, false, makeRequest(), deps);

    assert.equal(result.success, false);
    if (result.success) return;
    // NOT_FOUND rather than FORBIDDEN: another company's slug is never confirmed.
    assert.equal(result.code, "NOT_FOUND");
    // And no dedupe slot was occupied on the way out.
    assert.equal(enqueues().length, 0);
  });
});
