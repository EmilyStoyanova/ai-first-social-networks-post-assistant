import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bulkGeneratePosts,
  classifyBulkFailure,
  type BulkGeneratePostsDeps,
  type BulkGeneratePostsInput,
  type BulkSourceQuota,
} from "./bulk-generate-posts.service";
import type {
  GenerateDraftPostErrorCode,
  GenerateDraftPostResult,
  GeneratedPostDTO,
} from "./generate-draft-post.service";
import type { ManualContentSourceRef } from "@/lib/ai/manual-content-source";
import { brandSetupOrigin } from "@/lib/posts/post-origin";
import { MAX_BULK_POSTS } from "@/lib/scheduling/bulk-schedule";
import { toAppDateTimeLocal } from "@/lib/scheduling/app-datetime-local";

/**
 * A planned slot on the BUSINESS clock, `YYYY-MM-DDTHH:mm`.
 *
 * The times below are the ones a channel is configured with and a card renders,
 * so that is the clock they are asserted on; lib/scheduling/bulk-schedule.test.ts
 * is where the UTC instant behind them is pinned down.
 */
function slotStamp(value: Date): string {
  return toAppDateTimeLocal(value);
}

const SLUG = "acme";
const USER_ID = "user-1";
const BATCH_ID = "batch-fixed";
const START = "2026-08-17";
const END = "2026-08-30";

/** Everything the bulk service passes to ONE generation, as it received it. */
interface RecordedCall {
  slug: string;
  channel: string;
  userId: string;
  isGlobalAdmin: boolean;
  options: Record<string, unknown>;
}

/** One audit entry the service asked for. */
interface RecordedAudit {
  companyId: string;
  userId?: string;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

function makeInput(overrides: Partial<BulkGeneratePostsInput> = {}): BulkGeneratePostsInput {
  return {
    // One channel by default, so every pre-existing test still describes a
    // single-channel batch — where a topic and a post are the same thing.
    channels: ["linkedin"],
    numberOfPosts: 5,
    startDate: START,
    endDate: END,
    ...overrides,
  };
}

function post(id: string, options: Record<string, unknown>): GeneratedPostDTO {
  return {
    id,
    companyId: "company-1",
    channel: "LINKEDIN",
    // The generator's default for the manual flow. Bulk never asks for anything
    // else — see the "always drafts" test.
    status: "DRAFT",
    text: "Generated",
    hashtags: [],
    imagePrompt: null,
    notes: null,
    llmProvider: "mock",
    llmModel: "mock",
    mediaUrl: null,
    sourceImageUrl: null,
    origin: brandSetupOrigin(),
    scheduledFor: (options.scheduledFor as Date | undefined) ?? null,
    generationBatchId: (options.generationBatchId as string | undefined) ?? null,
    contentGroupId: (options.contentGroupId as string | undefined) ?? null,
    // Echoed from the pin when one was given, so a fake sibling generation
    // reports the same article and claim its caller asked it to write from.
    primaryFeedItemId: (options.pinnedFeedItemId as string | undefined) ?? null,
    coreMessage: `Core message for ${id}.`,
    topic: `topic-${id}`,
    createdAt: new Date("2026-08-10T00:00:00.000Z"),
  };
}

/**
 * A generation double that succeeds for the first `succeedFor` calls and then
 * answers with `thenFail` — the shape of every partial-success case.
 *
 * Nothing about real generation is simulated: the reservation, the duplicate
 * gates and the LLM have their own tests. What is under test here is the
 * orchestration around them.
 */
function makeDeps(
  options: {
    succeedFor?: number;
    thenFail?: GenerateDraftPostResult;
    postingWindows?: unknown;
    /** Wall-clock ms each generation "takes", on an injected clock. */
    msPerPost?: number;
    softBudgetMs?: number;
    minSlotBudgetMs?: number;
  } = {}
): {
  deps: BulkGeneratePostsDeps;
  calls: () => RecordedCall[];
  audits: () => RecordedAudit[];
} {
  const succeedFor = options.succeedFor ?? Number.POSITIVE_INFINITY;
  const calls: RecordedCall[] = [];
  const audits: RecordedAudit[] = [];

  // A clock that only moves when a generation runs, so the budget is exercised
  // deterministically and instantly. Its absolute value matters for exactly one
  // thing — whether START is still in the future — so it is pinned a week before
  // it rather than left at an arbitrary epoch offset.
  let clock = Date.parse("2026-08-10T09:00:00.000Z");

  const deps: BulkGeneratePostsDeps = {
    now: () => clock,
    softBudgetMs: options.softBudgetMs,
    minSlotBudgetMs: options.minSlotBudgetMs,
    generate: async (slug, channel, userId, isGlobalAdmin, opts = {}) => {
      clock += options.msPerPost ?? 0;
      calls.push({
        slug,
        channel,
        userId,
        isGlobalAdmin,
        options: opts as Record<string, unknown>,
      });
      if (calls.length > succeedFor) {
        return options.thenFail ?? { success: false, code: "NO_FEED_ITEMS_AVAILABLE" };
      }
      return {
        success: true,
        post: post(`post-${calls.length}`, opts as Record<string, unknown>),
        warnings: {
          duplicate: { flagged: false, similarityScore: null, matchedPostId: null },
          safety: { flagged: false, matchedTerms: [] },
          semanticDuplicate: {
            decision: "accept",
            topSimilarity: null,
            matchedPostId: null,
            exhausted: false,
            skipped: false,
          },
        },
      };
    },
    loadPostingWindows: async () => options.postingWindows ?? null,
    newBatchId: () => BATCH_ID,
    // Recorded rather than written: the real one talks to Prisma, and these
    // tests are about orchestration, not storage.
    auditLog: async (entry) => {
      audits.push(entry);
    },
  };

  return { deps, calls: () => calls, audits: () => audits };
}

// ─── The happy path ───────────────────────────────────────────────────────────

describe("bulkGeneratePosts — a fully satisfied request", () => {
  it("generates one post per requested slot and reports the batch", async () => {
    const { deps, calls } = makeDeps();

    const result = await bulkGeneratePosts(SLUG, USER_ID, false, makeInput(), deps);

    assert.equal(result.success, true);
    if (!result.success) return;

    assert.equal(calls().length, 5);
    assert.deepEqual(
      {
        batchId: result.data.batchId,
        requested: result.data.requested,
        generated: result.data.generated,
        failed: result.data.failed,
        notAttempted: result.data.notAttempted,
        stoppedEarly: result.data.stoppedEarly,
        failures: result.data.failures,
      },
      {
        batchId: BATCH_ID,
        requested: 5,
        generated: 5,
        failed: 0,
        notAttempted: 0,
        stoppedEarly: false,
        failures: [],
      }
    );
    assert.deepEqual(result.data.postIds, ["post-1", "post-2", "post-3", "post-4", "post-5"]);
  });

  it("tags every post in the run with the SAME batch id", async () => {
    const { deps, calls } = makeDeps();

    const result = await bulkGeneratePosts(SLUG, USER_ID, false, makeInput(), deps);
    assert.equal(result.success, true);
    if (!result.success) return;

    const ids = new Set(calls().map((c) => c.options.generationBatchId));
    assert.deepEqual([...ids], [result.data.batchId]);
  });

  it("schedules the posts across the requested range, one slot each", async () => {
    const { deps, calls } = makeDeps();

    const result = await bulkGeneratePosts(SLUG, USER_ID, false, makeInput(), deps);
    assert.equal(result.success, true);
    if (!result.success) return;

    // The range is a permitted period, not two publishing dates: the posts are
    // spread across its width and neither boundary is filled just for being one.
    const scheduled = calls().map((c) => slotStamp(c.options.scheduledFor as Date));
    assert.deepEqual(scheduled, [
      "2026-08-18T10:00",
      "2026-08-21T10:00",
      "2026-08-24T10:00",
      "2026-08-26T10:00",
      "2026-08-29T10:00",
    ]);
    // What the caller is told matches what was written, slot for slot.
    assert.deepEqual(
      result.data.posts.map((p) => slotStamp(p.scheduledFor)),
      scheduled
    );
    assert.deepEqual(
      result.data.posts.map((p) => p.index),
      [1, 2, 3, 4, 5]
    );
  });

  it("publishes only on the channel's configured posting days and times", async () => {
    const { deps, calls } = makeDeps({
      postingWindows: [{ day: "MONDAY", start: "07:45", end: "09:00" }],
    });

    await bulkGeneratePosts(SLUG, USER_ID, false, makeInput({ numberOfPosts: 2 }), deps);

    // The period runs Mon 17 → Sun 30, but the channel posts on Mondays: the two
    // posts land on the two Mondays it contains, at the configured 07:45. The
    // dates the user typed are never treated as publishing dates in themselves.
    assert.deepEqual(
      calls().map((c) => slotStamp(c.options.scheduledFor as Date)),
      ["2026-08-17T07:45", "2026-08-24T07:45"]
    );
  });
});

// ─── Bulk posts are manual generations ────────────────────────────────────────

describe("bulkGeneratePosts — bulk posts are ordinary manual drafts", () => {
  it("never asks for a status, so generation's `draft` default stands", async () => {
    const { deps, calls } = makeDeps();

    const result = await bulkGeneratePosts(SLUG, USER_ID, false, makeInput(), deps);
    assert.equal(result.success, true);

    // The manual entry point has no `initialStatus` option at all — only the
    // cron path does — so a fully_automated channel cannot promote these posts
    // at generation time. Asserted on the wire, not on the type, so removing the
    // guard would fail here too.
    for (const call of calls()) {
      assert.ok(!("initialStatus" in call.options), "bulk must not choose a post status");
      assert.ok(!("scheduleId" in call.options), "a bulk post belongs to no weekly schedule");
    }
  });

  it("passes the generation options through to every post unchanged", async () => {
    const { deps, calls } = makeDeps();

    await bulkGeneratePosts(
      SLUG,
      USER_ID,
      true,
      makeInput({
        numberOfPosts: 2,
        contentLanguage: "bg",
        includeSourceLinkOverride: false,
        autoGenerateImageOverride: true,
        llmConfigId: "cfg-7",
        contentSource: { kind: "source", sourceId: "src-1" },
      }),
      deps
    );

    for (const call of calls()) {
      assert.equal(call.slug, SLUG);
      assert.equal(call.channel, "linkedin");
      assert.equal(call.userId, USER_ID);
      assert.equal(call.isGlobalAdmin, true);
      assert.equal(call.options.contentLanguage, "bg");
      assert.equal(call.options.includeSourceLinkOverride, false);
      assert.equal(call.options.autoGenerateImageOverride, true);
      assert.equal(call.options.llmConfigId, "cfg-7");
      assert.deepEqual(call.options.contentSource, { kind: "source", sourceId: "src-1" });
    }
  });
});

// ─── Partial success ──────────────────────────────────────────────────────────

describe("bulkGeneratePosts — partial success", () => {
  it("keeps the posts it wrote and says why the rest are missing", async () => {
    const { deps } = makeDeps({ succeedFor: 3 });

    const result = await bulkGeneratePosts(SLUG, USER_ID, false, makeInput(), deps);

    assert.equal(result.success, true);
    if (!result.success) return;

    assert.equal(result.data.generated, 3);
    assert.equal(result.data.failed, 2);
    assert.deepEqual(result.data.postIds, ["post-1", "post-2", "post-3"]);

    // One attempt failed; the slot after it was never tried.
    assert.equal(result.data.failures.length, 1);
    assert.equal(result.data.notAttempted, 1);
    assert.equal(result.data.stoppedEarly, true);
    assert.equal(result.data.failed, result.data.failures.length + result.data.notAttempted);

    const failure = result.data.failures[0];
    assert.equal(failure.index, 4);
    assert.equal(failure.code, "NO_FEED_ITEMS_AVAILABLE");
    assert.equal(failure.reason, "no_eligible_content");
    assert.ok(failure.message.length > 0);
    assert.equal(slotStamp(failure.scheduledFor), "2026-08-26T10:00");
  });

  it("stops generating instead of trying again for the missing posts", async () => {
    const { deps, calls } = makeDeps({ succeedFor: 3 });

    await bulkGeneratePosts(SLUG, USER_ID, false, makeInput(), deps);

    // 3 successes + the one failure. Retrying would re-claim the same article
    // and re-run the same losing race, or spend money on a provider that is
    // already refusing — and any post reached that way is one the quality gates
    // just rejected.
    assert.equal(calls().length, 4);
  });

  it("treats an exhausted uniqueness budget as a stop, not a reason to lower the bar", async () => {
    const { deps, calls } = makeDeps({
      succeedFor: 2,
      thenFail: {
        success: false,
        code: "CANNOT_GENERATE_UNIQUE_POST",
        message: "Could not generate a sufficiently unique post after all attempts.",
        reason: "semantic_duplicate",
        attempts: 3,
      },
    });

    const result = await bulkGeneratePosts(SLUG, USER_ID, false, makeInput(), deps);

    assert.equal(result.success, true);
    if (!result.success) return;

    assert.equal(result.data.generated, 2);
    assert.equal(result.data.failed, 3);
    assert.equal(result.data.failures[0].reason, "not_unique");
    assert.equal(calls().length, 3);
  });

  it("carries the generator's own diagnostics into a partial batch's failure", async () => {
    const { deps } = makeDeps({
      succeedFor: 2,
      thenFail: {
        success: false,
        code: "CANNOT_GENERATE_UNIQUE_POST",
        reason: "semantic_duplicate",
        attempts: 3,
      },
    });

    const result = await bulkGeneratePosts(SLUG, USER_ID, false, makeInput(), deps);

    assert.equal(result.success, true);
    if (!result.success) return;

    const failure = result.data.failures[0];
    // The coarse grouping the UI switches on…
    assert.equal(failure.reason, "not_unique");
    // …and the generator's own account beneath it, which the multi-channel
    // orchestration layer must pass through rather than flatten to a code.
    assert.equal(failure.uniquenessReason, "semantic_duplicate");
    assert.equal(failure.attempts, 3);
  });

  it("carries a rate limit's retry hint into a partial batch's failure", async () => {
    const { deps } = makeDeps({
      succeedFor: 1,
      thenFail: { success: false, code: "LLM_RATE_LIMITED", retryAfterMs: 30_000 },
    });

    const result = await bulkGeneratePosts(SLUG, USER_ID, false, makeInput(), deps);

    assert.equal(result.success, true);
    if (!result.success) return;

    assert.equal(result.data.failures[0].code, "LLM_RATE_LIMITED");
    assert.equal(result.data.failures[0].retryAfterMs, 30_000);
  });
});

// ─── Nothing generated ────────────────────────────────────────────────────────

describe("bulkGeneratePosts — when nothing could be generated", () => {
  it("fails with the generation code rather than reporting a batch of zero", async () => {
    const { deps, calls } = makeDeps({ succeedFor: 0 });

    const result = await bulkGeneratePosts(SLUG, USER_ID, false, makeInput(), deps);

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, "NO_FEED_ITEMS_AVAILABLE");
    // One attempt, then out — the answer would not change on the second.
    assert.equal(calls().length, 1);
  });

  it("carries the failure's own diagnostics through", async () => {
    const { deps } = makeDeps({
      succeedFor: 0,
      thenFail: {
        success: false,
        code: "LLM_RATE_LIMITED",
        retryAfterMs: 30_000,
      },
    });

    const result = await bulkGeneratePosts(SLUG, USER_ID, false, makeInput(), deps);

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, "LLM_RATE_LIMITED");
    assert.equal(result.retryAfterMs, 30_000);
  });

  it("reports an access failure exactly as a single generation would", async () => {
    const { deps, calls } = makeDeps({
      succeedFor: 0,
      thenFail: { success: false, code: "FORBIDDEN" },
    });

    const result = await bulkGeneratePosts(SLUG, USER_ID, false, makeInput(), deps);

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, "FORBIDDEN");
    assert.equal(calls().length, 1);
  });
});

// ─── Request validation ───────────────────────────────────────────────────────

describe("bulkGeneratePosts — request validation", () => {
  it("rejects a count outside the allowed range before generating anything", async () => {
    for (const numberOfPosts of [0, -1, 11, 2.5]) {
      const { deps, calls } = makeDeps();
      const result = await bulkGeneratePosts(
        SLUG,
        USER_ID,
        false,
        makeInput({ numberOfPosts }),
        deps
      );

      assert.equal(result.success, false, `count ${numberOfPosts}`);
      if (result.success) continue;
      assert.equal(result.code, "INVALID_POST_COUNT");
      assert.equal(calls().length, 0);
    }
  });

  it("rejects a range that ends before it starts", async () => {
    const { deps, calls } = makeDeps();

    const result = await bulkGeneratePosts(
      SLUG,
      USER_ID,
      false,
      makeInput({ startDate: END, endDate: START }),
      deps
    );

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, "INVALID_DATE_RANGE");
    assert.equal(calls().length, 0);
  });

  it("rejects an unparseable date", async () => {
    const { deps } = makeDeps();

    const result = await bulkGeneratePosts(
      SLUG,
      USER_ID,
      false,
      makeInput({ endDate: "2026-02-30" }),
      deps
    );

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, "INVALID_DATE_RANGE");
  });

  it("rejects a period longer than a year", async () => {
    const { deps, calls } = makeDeps();

    // Slot derivation walks the period a day at a time, so an open-ended range
    // is an open-ended allocation inside the request handler.
    const result = await bulkGeneratePosts(
      SLUG,
      USER_ID,
      false,
      makeInput({ startDate: "2026-01-01", endDate: "2027-06-01" }),
      deps
    );

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, "INVALID_DATE_RANGE");
    assert.equal(calls().length, 0);
  });

  it("accepts a single-day range", async () => {
    const { deps } = makeDeps();

    const result = await bulkGeneratePosts(
      SLUG,
      USER_ID,
      false,
      makeInput({ numberOfPosts: 2, startDate: START, endDate: START }),
      deps
    );

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.generated, 2);
  });

  // The injected clock reads 2026-08-10, so anything before that is the past.
  it("refuses a period that has already started, before generating anything", async () => {
    const { deps, calls } = makeDeps();

    const result = await bulkGeneratePosts(
      SLUG,
      USER_ID,
      false,
      makeInput({ startDate: "2026-08-03", endDate: "2026-08-20" }),
      deps
    );

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, "START_DATE_IN_PAST");
    // Nothing may be written: a post scheduled into the past is one the
    // publisher refuses to fire, so the batch would strand every draft it made.
    assert.equal(calls().length, 0);
  });

  it("allows a period starting today", async () => {
    const { deps } = makeDeps();

    const result = await bulkGeneratePosts(
      SLUG,
      USER_ID,
      false,
      makeInput({ numberOfPosts: 2, startDate: "2026-08-10", endDate: "2026-08-14" }),
      deps
    );

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.generated, 2);
  });

  it("answers the range question before the past question", async () => {
    // A malformed or backwards range is not "in the past" — it is unusable, and
    // saying so is more useful than telling the user to pick a later date.
    const { deps } = makeDeps();

    const result = await bulkGeneratePosts(
      SLUG,
      USER_ID,
      false,
      makeInput({ startDate: "2026-08-03", endDate: "2026-08-01" }),
      deps
    );

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, "INVALID_DATE_RANGE");
  });
});

// ─── Custom distribution ──────────────────────────────────────────────────────

describe("bulkGeneratePosts — a user-authored schedule", () => {
  it("schedules each post at exactly the date and time the user chose", async () => {
    // Windows that disagree with every chosen time, precisely so that a slot
    // landing on one of them would be visible here.
    const { deps, calls } = makeDeps({
      postingWindows: [
        { day: "MONDAY", start: "07:45", end: "09:00" },
        { day: "WEDNESDAY", start: "12:00", end: "13:00" },
      ],
    });

    const result = await bulkGeneratePosts(
      SLUG,
      USER_ID,
      false,
      makeInput({
        numberOfPosts: 3,
        customDistribution: [
          { date: "2026-08-19", count: 1, times: ["06:05"] },
          { date: "2026-08-17", count: 2, times: ["21:40", "13:15"] },
        ],
      }),
      deps
    );

    assert.equal(result.success, true);
    if (!result.success) return;

    // The user's own times, ascending whatever order the days and times were
    // sent in — and not one of the channel's windows among them.
    assert.deepEqual(
      calls().map((c) => slotStamp(c.options.scheduledFor as Date)),
      ["2026-08-17T13:15", "2026-08-17T21:40", "2026-08-19T06:05"]
    );
    assert.equal(result.data.generated, 3);
  });

  it("stores each chosen Sofia wall clock as the right UTC instant", async () => {
    // What actually reaches the database. 13:15 Sofia in August (EEST, UTC+3) is
    // 10:15Z — and it is this instant the post card and the reschedule panel
    // read back through the same zone, so the user sees 13:15 again.
    const { deps, calls } = makeDeps();

    await bulkGeneratePosts(
      SLUG,
      USER_ID,
      false,
      makeInput({
        numberOfPosts: 2,
        customDistribution: [{ date: "2026-08-17", count: 2, times: ["13:15", "23:30"] }],
      }),
      deps
    );

    assert.deepEqual(
      calls().map((c) => (c.options.scheduledFor as Date).toISOString()),
      ["2026-08-17T10:15:00.000Z", "2026-08-17T20:30:00.000Z"]
    );
  });

  it("never reads the channel's posting windows in this mode", async () => {
    // The strongest form of "do not recalculate from postingWindows": the
    // service does not even load them, so there is nothing available to
    // recalculate from.
    let loads = 0;
    const { deps } = makeDeps();

    const result = await bulkGeneratePosts(
      SLUG,
      USER_ID,
      false,
      makeInput({
        numberOfPosts: 1,
        customDistribution: [{ date: "2026-08-17", count: 1, times: ["13:15"] }],
      }),
      {
        ...deps,
        loadPostingWindows: async () => {
          loads++;
          return [{ day: "MONDAY", start: "07:45", end: "09:00" }];
        },
      }
    );

    assert.equal(result.success, true);
    assert.equal(loads, 0);
  });

  it("still loads the windows for an even spread", async () => {
    // The other half of the previous test: even distribution is unchanged and
    // depends on them, so a skipped load there would be a silent regression.
    let loads = 0;
    const { deps } = makeDeps();

    await bulkGeneratePosts(SLUG, USER_ID, false, makeInput({ numberOfPosts: 1 }), {
      ...deps,
      loadPostingWindows: async () => {
        loads++;
        return [{ day: "MONDAY", start: "07:45", end: "09:00" }];
      },
    });

    assert.equal(loads, 1);
  });

  it("rejects a distribution whose counts do not add up to the request", async () => {
    const { deps, calls } = makeDeps();

    const result = await bulkGeneratePosts(
      SLUG,
      USER_ID,
      false,
      makeInput({
        numberOfPosts: 5,
        customDistribution: [{ date: "2026-08-18", count: 2, times: ["09:00", "12:00"] }],
      }),
      deps
    );

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, "INVALID_DISTRIBUTION");
    // Rejected before a single generation is paid for.
    assert.equal(calls().length, 0);
  });

  it("rejects a day outside the requested period", async () => {
    const { deps, calls } = makeDeps();

    const result = await bulkGeneratePosts(
      SLUG,
      USER_ID,
      false,
      makeInput({
        numberOfPosts: 1,
        customDistribution: [{ date: "2026-09-15", count: 1, times: ["09:00"] }],
      }),
      deps
    );

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, "INVALID_DISTRIBUTION");
    assert.equal(calls().length, 0);
  });

  it("rejects two posts at the same date and time", async () => {
    const { deps, calls } = makeDeps();

    const result = await bulkGeneratePosts(
      SLUG,
      USER_ID,
      false,
      makeInput({
        numberOfPosts: 2,
        customDistribution: [{ date: "2026-08-18", count: 2, times: ["09:00", "09:00"] }],
      }),
      deps
    );

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, "INVALID_DISTRIBUTION");
    assert.equal(calls().length, 0);
  });

  it("rejects a chosen time that has already gone by", async () => {
    // The injected clock is 2026-08-10 09:00Z — 12:00 in Sofia. A 10:00 slot
    // that same day is behind it, even though the DAY is not in the past, so the
    // start-date rule would let it through.
    const { deps, calls } = makeDeps();

    const result = await bulkGeneratePosts(
      SLUG,
      USER_ID,
      false,
      makeInput({
        numberOfPosts: 1,
        startDate: "2026-08-10",
        endDate: "2026-08-20",
        customDistribution: [{ date: "2026-08-10", count: 1, times: ["10:00"] }],
      }),
      deps
    );

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, "INVALID_DISTRIBUTION");
    assert.equal(calls().length, 0);

    // Later the same day is accepted, so a same-day batch is still possible.
    const later = await bulkGeneratePosts(
      SLUG,
      USER_ID,
      false,
      makeInput({
        numberOfPosts: 1,
        startDate: "2026-08-10",
        endDate: "2026-08-20",
        customDistribution: [{ date: "2026-08-10", count: 1, times: ["18:00"] }],
      }),
      makeDeps().deps
    );
    assert.equal(later.success, true);
  });

  it("rejects a day whose times do not match its count", async () => {
    const { deps, calls } = makeDeps();

    const result = await bulkGeneratePosts(
      SLUG,
      USER_ID,
      false,
      makeInput({
        numberOfPosts: 2,
        customDistribution: [{ date: "2026-08-18", count: 2, times: ["09:00"] }],
      }),
      deps
    );

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, "INVALID_DISTRIBUTION");
    assert.equal(calls().length, 0);
  });

  it("still checks the count and the range before looking at the distribution", async () => {
    const { deps } = makeDeps();

    // A distribution cannot rescue a request that was never allowed: the count
    // is out of bounds, so that is what the caller is told.
    const result = await bulkGeneratePosts(
      SLUG,
      USER_ID,
      false,
      makeInput({
        numberOfPosts: MAX_BULK_POSTS + 1,
        customDistribution: [{ date: "2026-08-18", count: MAX_BULK_POSTS + 1, times: ["09:00"] }],
      }),
      deps
    );

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, "INVALID_POST_COUNT");
  });

  it("is still ordinary drafts in a batch, exactly like an even spread", async () => {
    const { deps, calls } = makeDeps();

    const result = await bulkGeneratePosts(
      SLUG,
      USER_ID,
      false,
      makeInput({
        numberOfPosts: 2,
        customDistribution: [{ date: "2026-08-20", count: 2, times: ["09:00", "18:30"] }],
      }),
      deps
    );

    assert.equal(result.success, true);
    if (!result.success) return;

    assert.equal(result.data.batchId, BATCH_ID);
    for (const call of calls()) {
      assert.equal(call.options.generationBatchId, BATCH_ID);
      // Nothing in this path may ask for a status: generation defaults to draft.
      assert.ok(!("initialStatus" in call.options));
    }
  });
});

// ─── The request time budget ──────────────────────────────────────────────────

describe("bulkGeneratePosts — the request time budget", () => {
  it("stops cleanly instead of running past the function cap", async () => {
    // 100s per post against a 240s budget with a 45s floor: posts 1 and 2 run
    // (0→100→200s), then only 40s is left and the third is not started.
    const { deps, calls } = makeDeps({ msPerPost: 100_000 });

    const result = await bulkGeneratePosts(SLUG, USER_ID, false, makeInput(), deps);

    assert.equal(result.success, true);
    if (!result.success) return;

    assert.equal(calls().length, 2);
    assert.equal(result.data.generated, 2);
    assert.equal(result.data.stoppedEarly, true);
    assert.equal(result.data.stopReason, "time_budget");
    // Running out of time is not a generation failure — nothing failed, three
    // slots were simply never attempted.
    assert.deepEqual(result.data.failures, []);
    assert.equal(result.data.notAttempted, 3);
    assert.equal(result.data.failed, 3);
  });

  it("keeps every post it wrote before the budget ran out", async () => {
    const { deps } = makeDeps({ msPerPost: 100_000 });

    const result = await bulkGeneratePosts(SLUG, USER_ID, false, makeInput(), deps);
    assert.equal(result.success, true);
    if (!result.success) return;

    // The posts are already committed by the generator; a timeout must never be
    // the reason a caller cannot find them.
    assert.deepEqual(result.data.postIds, ["post-1", "post-2"]);
    assert.equal(result.data.batchId, BATCH_ID);
  });

  it("always attempts the first slot, however little budget there is", async () => {
    const { deps, calls } = makeDeps({ msPerPost: 1_000, softBudgetMs: 1 });

    const result = await bulkGeneratePosts(SLUG, USER_ID, false, makeInput(), deps);

    assert.equal(calls().length, 1);
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.generated, 1);
    assert.equal(result.data.stopReason, "time_budget");
  });

  it("does not stop early when the posts are quick", async () => {
    const { deps, calls } = makeDeps({ msPerPost: 5_000 });

    const result = await bulkGeneratePosts(SLUG, USER_ID, false, makeInput(), deps);

    assert.equal(calls().length, 5);
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.generated, 5);
    assert.equal(result.data.stoppedEarly, false);
    assert.equal(result.data.stopReason, null);
  });

  it("reports a generation failure as the stop reason, not the budget", async () => {
    const { deps } = makeDeps({ succeedFor: 3, msPerPost: 5_000 });

    const result = await bulkGeneratePosts(SLUG, USER_ID, false, makeInput(), deps);
    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.stopReason, "generation_failed");
  });
});

// ─── Failure classification ───────────────────────────────────────────────────

describe("classifyBulkFailure", () => {
  it("groups every generation error code into a reason a user can act on", () => {
    const expected: Record<GenerateDraftPostErrorCode, string> = {
      NO_FEED_ITEMS_AVAILABLE: "no_eligible_content",
      SELECTED_SOURCE_UNAVAILABLE: "no_eligible_content",
      CANNOT_GENERATE_UNIQUE_POST: "not_unique",
      LLM_RATE_LIMITED: "provider_error",
      LLM_PROVIDER_ERROR: "provider_error",
      LLM_RESPONSE_PARSE_ERROR: "provider_error",
      NO_ACTIVE_PROVIDER: "configuration",
      LLM_CONFIG_NOT_FOUND: "configuration",
      PROVIDER_CONFIG_MISSING: "configuration",
      POST_TOO_LONG_WITH_URL: "channel_limit",
      NOT_FOUND: "access",
      FORBIDDEN: "access",
      INVALID_CHANNEL: "access",
    };

    for (const [code, reason] of Object.entries(expected)) {
      assert.equal(classifyBulkFailure(code as GenerateDraftPostErrorCode), reason, code);
    }
  });
});

// ─── Audit trail ──────────────────────────────────────────────────────────────

describe("bulkGeneratePosts — the batch's audit entry", () => {
  it("records one entry for the whole request, keyed by the batch", async () => {
    // One "generate 5 posts" click is one decision. Each post already logs its
    // own POST_GENERATED, so a second per-post entry here would only be noise;
    // what the log is missing is the request that produced them.
    const { deps, audits } = makeDeps();

    await bulkGeneratePosts(SLUG, USER_ID, false, makeInput(), deps);

    const entries = audits();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, "POST_BULK_GENERATED");
    assert.equal(entries[0].entityType, "post_batch");
    assert.equal(entries[0].entityId, BATCH_ID);
    assert.equal(entries[0].userId, USER_ID);
    assert.equal(entries[0].companyId, "company-1");
  });

  it("keys a multi-channel batch to the company its posts landed in", async () => {
    const { deps, audits } = makeDeps();

    await bulkGeneratePosts(
      SLUG,
      USER_ID,
      false,
      makeInput({ numberOfPosts: 2, channels: ["linkedin", "facebook"] }),
      deps
    );

    const entries = audits();
    // Still ONE entry for the click, and it knows the company — which now has to
    // travel out of the topic fan-out rather than off a single generation.
    assert.equal(entries.length, 1);
    assert.equal(entries[0].companyId, "company-1");

    const meta = entries[0].metadata as Record<string, unknown>;
    assert.deepEqual(meta.channels, ["linkedin", "facebook"]);
    // Ambiguous for a multi-channel batch, so it is null rather than one of the
    // two — old readers of `channel` keep their meaning instead of a wrong answer.
    assert.equal(meta.channel, null);
    // Topics vs Post rows: 2 topics × 2 channels is the spend this entry explains.
    assert.equal(meta.requested, 2);
    assert.equal(meta.requestedPosts, 4);
    assert.equal(meta.generatedPosts, 4);
    assert.equal((meta.contentGroupIds as string[]).length, 2);
  });

  it("records what was asked for, what came back, and when it will go out", async () => {
    const { deps, audits } = makeDeps();

    const result = await bulkGeneratePosts(SLUG, USER_ID, false, makeInput(), deps);
    assert.equal(result.success, true);
    if (!result.success) return;

    const meta = audits()[0].metadata as Record<string, unknown>;
    assert.equal(meta.channel, "linkedin");
    assert.equal(meta.requested, 5);
    assert.equal(meta.generated, 5);
    assert.equal(meta.failed, 0);
    assert.equal(meta.distribution, "even");
    assert.equal(meta.startDate, START);
    assert.equal(meta.endDate, END);
    assert.equal(meta.stopReason, null);
    // The scheduling window, so a stranded post can be traced back to the batch
    // that scheduled it without reading every post row.
    assert.equal(meta.firstScheduledFor, result.data.posts[0].scheduledFor.toISOString());
    assert.equal(meta.lastScheduledFor, result.data.posts[4].scheduledFor.toISOString());
    assert.deepEqual(
      meta.postIds,
      result.data.posts.map((p) => p.postId)
    );
  });

  it("records a partial batch as partial, with the reason it stopped", async () => {
    const { deps, audits } = makeDeps({ succeedFor: 2 });

    await bulkGeneratePosts(SLUG, USER_ID, false, makeInput(), deps);

    const meta = audits()[0].metadata as Record<string, unknown>;
    assert.equal(meta.requested, 5);
    assert.equal(meta.generated, 2);
    assert.equal(meta.failed, 3);
    assert.equal(meta.stopReason, "generation_failed");
    // The code names WHICH failure ended the run — "generation_failed" alone
    // would not say whether the sources ran dry or the provider fell over.
    assert.equal(meta.failureCode, "NO_FEED_ITEMS_AVAILABLE");
  });

  it("marks a hand-picked distribution as custom", async () => {
    const { deps, audits } = makeDeps();

    await bulkGeneratePosts(
      SLUG,
      USER_ID,
      false,
      makeInput({
        numberOfPosts: 2,
        customDistribution: [{ date: START, count: 2, times: ["09:00", "18:30"] }],
      }),
      deps
    );

    assert.equal((audits()[0].metadata as Record<string, unknown>).distribution, "custom");
  });

  it("writes nothing when not one post was generated", async () => {
    // With no post there is no company to attribute the entry to, and nothing
    // happened worth recording — the caller gets the failure instead.
    const { deps, audits } = makeDeps({ succeedFor: 0 });

    await bulkGeneratePosts(SLUG, USER_ID, false, makeInput(), deps);

    assert.equal(audits().length, 0);
  });
});

// ─── The batch's content mix ──────────────────────────────────────────────────

const SRC_A = "src-a";
const SRC_B = "src-b";

/**
 * A 3/1/1 mix over the default 5-post batch — the same shape the module doc of
 * content-mix.ts reasons about, so the expected source order here is the one
 * `nextDueQuota` documents: A, B, company, A, A.
 */
const BRIEF_MIX: BulkSourceQuota[] = [
  { sourceId: SRC_A, posts: 3 },
  { sourceId: SRC_B, posts: 1 },
  { sourceId: null, posts: 1 },
];

/**
 * The mix key a slot was asked to be written from — company content as null,
 * exactly as the quota that produced it names itself; undefined when the slot
 * carried no pick at all, which is what a run without a mix looks like.
 *
 * Read off the wire rather than off a summary field, because the claim under
 * test is that a mix post is an ORDINARY manual pick: the service must reach the
 * generator with the same `contentSource` ref the dropdown would have sent.
 */
function askedSource(call: RecordedCall): string | null | undefined {
  const ref = call.options.contentSource as ManualContentSourceRef | undefined;
  if (ref === undefined) return undefined;
  return ref.kind === "source" ? ref.sourceId : null;
}

/**
 * A generation double whose answer depends on WHICH source was asked for.
 *
 * `dry` names the sources with nothing left to write from; they fail with the
 * generator's real "pool is empty" code, which is the only failure a mix run
 * treats as a handoff rather than as the end of the batch. `failAttempt` injects
 * one different failure at a chosen call, for the other half of that rule.
 */
function makeMixDeps(
  options: {
    dry?: Array<string | null>;
    enabledSourceIds?: string[];
    failAttempt?: { at: number; result: GenerateDraftPostResult };
  } = {}
): {
  deps: BulkGeneratePostsDeps;
  calls: () => RecordedCall[];
  audits: () => RecordedAudit[];
} {
  const dry = new Set<string | null | undefined>(options.dry ?? []);
  const calls: RecordedCall[] = [];
  const audits: RecordedAudit[] = [];

  const deps: BulkGeneratePostsDeps = {
    now: () => Date.parse("2026-08-10T09:00:00.000Z"),
    loadEnabledSourceIds: async () => new Set(options.enabledSourceIds ?? [SRC_A, SRC_B]),
    generate: async (slug, channel, userId, isGlobalAdmin, opts = {}) => {
      const call: RecordedCall = {
        slug,
        channel,
        userId,
        isGlobalAdmin,
        options: opts as Record<string, unknown>,
      };
      calls.push(call);

      if (options.failAttempt && calls.length === options.failAttempt.at) {
        return options.failAttempt.result;
      }
      if (dry.has(askedSource(call))) {
        return { success: false, code: "NO_FEED_ITEMS_AVAILABLE" };
      }

      return {
        success: true,
        post: post(`post-${calls.length}`, opts as Record<string, unknown>),
        warnings: {
          duplicate: { flagged: false, similarityScore: null, matchedPostId: null },
          safety: { flagged: false, matchedTerms: [] },
          semanticDuplicate: {
            decision: "accept",
            topSimilarity: null,
            matchedPostId: null,
            exhausted: false,
            skipped: false,
          },
        },
      };
    },
    loadPostingWindows: async () => null,
    newBatchId: () => BATCH_ID,
    auditLog: async (entry) => {
      audits.push(entry);
    },
  };

  return { deps, calls: () => calls, audits: () => audits };
}

describe("bulkGeneratePosts — a per-batch content mix", () => {
  it("writes each source the number of posts its quota asked for", async () => {
    const { deps, calls } = makeMixDeps();

    const result = await bulkGeneratePosts(
      SLUG,
      USER_ID,
      false,
      makeInput({ sourceMix: BRIEF_MIX }),
      deps
    );

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.generated, 5);

    // Spread rather than drained: the heaviest quota does not take the first
    // three slots. This is `nextDueQuota`'s ordering reaching the batch intact,
    // not a second ordering implemented here.
    assert.deepEqual(calls().map(askedSource), [SRC_A, SRC_B, null, SRC_A, SRC_A]);
  });

  it("asks for each quota the way the dropdown would, not as a new instruction", async () => {
    // What earns the mix everything generation already does — the reservation,
    // the scope, the `contentSourceId` attribution on the post — is that it
    // arrives as an ordinary manual pick.
    const { deps, calls } = makeMixDeps();

    await bulkGeneratePosts(SLUG, USER_ID, false, makeInput({ sourceMix: BRIEF_MIX }), deps);

    assert.deepEqual(calls()[0].options.contentSource, { kind: "source", sourceId: SRC_A });
    assert.deepEqual(calls()[2].options.contentSource, { kind: "company_mission" });
  });

  it("leaves a batch without a mix exactly as it was", async () => {
    const { deps, calls } = makeMixDeps();

    const result = await bulkGeneratePosts(
      SLUG,
      USER_ID,
      false,
      makeInput({ contentSource: { kind: "source", sourceId: SRC_B } }),
      deps
    );

    assert.equal(result.success, true);
    if (!result.success) return;

    // One choice, applied to every post — the pre-mix behaviour, unchanged.
    assert.deepEqual(
      calls().map((c) => c.options.contentSource),
      Array.from({ length: 5 }, () => ({ kind: "source", sourceId: SRC_B }))
    );
    assert.deepEqual(result.data.exhaustedSources, []);
  });

  it("hands a dry source's posts to the sources that still have material", async () => {
    // The batch was promised 5 posts. A ran out; B and company content wrote
    // what it owed, so the batch is still 5 — which is exactly what
    // transferExhaustedQuotas promises the weekly scheduler.
    const { deps, calls } = makeMixDeps({ dry: [SRC_A] });

    const result = await bulkGeneratePosts(
      SLUG,
      USER_ID,
      false,
      makeInput({ sourceMix: BRIEF_MIX }),
      deps
    );

    assert.equal(result.success, true);
    if (!result.success) return;

    assert.equal(result.data.generated, 5);
    assert.deepEqual(result.data.failures, []);
    assert.equal(result.data.stopReason, null);
    assert.equal(result.data.stoppedEarly, false);
    // Reported, not hidden: the batch matched the mix that was asked for, not
    // the one that was written.
    assert.deepEqual(result.data.exhaustedSources, [SRC_A]);

    // Asked once and never again. A source that is spent is spent for the run —
    // retrying it every slot would be the infinite loop this guards against.
    assert.equal(calls().filter((c) => askedSource(c) === SRC_A).length, 1);
    assert.deepEqual(calls().map(askedSource), [SRC_A, SRC_B, null, SRC_B, SRC_B, SRC_B]);
  });

  it("stops the batch on a failure that is not a source running dry", async () => {
    // Only "nothing left to write from" is a handoff. A provider error says
    // nothing about which source is due next, and retrying it just spends money.
    const { deps } = makeMixDeps({
      failAttempt: { at: 2, result: { success: false, code: "LLM_PROVIDER_ERROR" } },
    });

    const result = await bulkGeneratePosts(
      SLUG,
      USER_ID,
      false,
      makeInput({ sourceMix: BRIEF_MIX }),
      deps
    );

    assert.equal(result.success, true);
    if (!result.success) return;

    assert.equal(result.data.generated, 1);
    assert.equal(result.data.stopReason, "generation_failed");
    assert.equal(result.data.failures.length, 1);
    assert.equal(result.data.failures[0].code, "LLM_PROVIDER_ERROR");
    assert.equal(result.data.notAttempted, 3);
    assert.deepEqual(result.data.exhaustedSources, []);
  });

  it("stops with mix_exhausted once every source has run dry", async () => {
    // Nothing failed — every slot that could be filled was. The run simply got
    // past what the company currently has to say, and says so in its own words.
    const { deps } = makeMixDeps({ dry: [SRC_B, null] });

    const result = await bulkGeneratePosts(
      SLUG,
      USER_ID,
      false,
      makeInput({
        numberOfPosts: 3,
        sourceMix: [
          { sourceId: SRC_A, posts: 1 },
          { sourceId: SRC_B, posts: 1 },
          { sourceId: null, posts: 1 },
        ],
      }),
      deps
    );

    assert.equal(result.success, true);
    if (!result.success) return;

    assert.equal(result.data.generated, 2);
    assert.equal(result.data.stopReason, "mix_exhausted");
    assert.equal(result.data.stoppedEarly, true);
    assert.equal(result.data.notAttempted, 1);
    // No slot failed, so there is nothing in `failures` for a summary to name —
    // which is precisely why this reason exists.
    assert.deepEqual(result.data.failures, []);
    assert.deepEqual(result.data.exhaustedSources, [SRC_B, null]);
  });

  it("answers a mix that wrote nothing exactly as one generation would", async () => {
    // A batch of zero is never a success. The caller gets the generation's own
    // code, so the API reads identically whether one post or five were asked for.
    const { deps, calls, audits } = makeMixDeps({ dry: [SRC_A, SRC_B, null] });

    const result = await bulkGeneratePosts(
      SLUG,
      USER_ID,
      false,
      makeInput({ sourceMix: BRIEF_MIX }),
      deps
    );

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, "NO_FEED_ITEMS_AVAILABLE");

    // Each source tried once, then the run gave up rather than cycling.
    assert.equal(calls().length, 3);
    assert.equal(audits().length, 0);
  });

  it("records the mix this run used and the sources that ran dry", async () => {
    const { deps, audits } = makeMixDeps({ dry: [SRC_A] });

    await bulkGeneratePosts(SLUG, USER_ID, false, makeInput({ sourceMix: BRIEF_MIX }), deps);

    const meta = audits()[0].metadata as Record<string, unknown>;
    // The saved default is not in the log because this run did not use it; what
    // is recorded is the instruction these posts were actually written from.
    assert.deepEqual(meta.sourceMix, BRIEF_MIX);
    assert.deepEqual(meta.exhaustedSources, [SRC_A]);
  });

  it("records no mix for a run that had none", async () => {
    const { deps, audits } = makeMixDeps();

    await bulkGeneratePosts(SLUG, USER_ID, false, makeInput(), deps);

    const meta = audits()[0].metadata as Record<string, unknown>;
    assert.equal(meta.sourceMix, null);
    assert.deepEqual(meta.exhaustedSources, []);
  });

  it("does not change the mix it was handed", async () => {
    // The submitted mix is one run's instruction; the company's saved default is
    // configuration. Nothing in the loop may write back to either — a run that
    // rewrote its own quotas would make the next batch's prefill a fiction.
    const submitted: BulkSourceQuota[] = BRIEF_MIX.map((q) => ({ ...q }));
    const { deps } = makeMixDeps({ dry: [SRC_A] });

    await bulkGeneratePosts(SLUG, USER_ID, false, makeInput({ sourceMix: submitted }), deps);

    assert.deepEqual(submitted, BRIEF_MIX);
  });
});

// ─── A mix the server will not run ────────────────────────────────────────────

describe("bulkGeneratePosts — a content mix the server refuses", () => {
  /** Every rejection must land before a single post is written. */
  async function reject(
    input: Partial<BulkGeneratePostsInput>,
    options: Parameters<typeof makeMixDeps>[0] = {}
  ) {
    const { deps, calls } = makeMixDeps(options);
    const result = await bulkGeneratePosts(SLUG, USER_ID, false, makeInput(input), deps);

    assert.equal(result.success, false);
    if (result.success) throw new Error("expected a rejection");
    assert.equal(result.code, "INVALID_SOURCE_MIX");
    assert.equal(calls().length, 0, "nothing may be generated from a mix that was refused");
    return result;
  }

  it("refuses a mix that does not add up to the number of posts requested", async () => {
    // The load-bearing rule: the mix IS the batch, so one that does not add up
    // would quietly generate a different number of posts than was asked for.
    await reject({ sourceMix: [{ sourceId: SRC_A, posts: 2 }] });
  });

  it("refuses a source this company does not have, or has switched off", async () => {
    // Refused rather than skipped: per-slot it would look like "that source is
    // spent" and hand its posts to sources the user never allocated them to.
    await reject({ sourceMix: [{ sourceId: "src-gone", posts: 5 }] });
    await reject({ sourceMix: [{ sourceId: SRC_B, posts: 5 }] }, { enabledSourceIds: [SRC_A] });
  });

  it("refuses a mix and a single picked source together", async () => {
    // Alternatives, not layers — otherwise the answer belongs to whichever the
    // loop happens to read.
    await reject({
      sourceMix: BRIEF_MIX,
      contentSource: { kind: "source", sourceId: SRC_A },
    });
  });

  it("refuses the same source listed twice", async () => {
    await reject({
      sourceMix: [
        { sourceId: SRC_A, posts: 3 },
        { sourceId: SRC_A, posts: 2 },
      ],
    });
  });

  it("refuses a quota that is not a whole post", async () => {
    await reject({
      sourceMix: [
        { sourceId: SRC_A, posts: 2.5 },
        { sourceId: SRC_B, posts: 2.5 },
      ],
    });
    await reject({
      sourceMix: [
        { sourceId: SRC_A, posts: 0 },
        { sourceId: SRC_B, posts: 5 },
      ],
    });
  });

  it("refuses a mix that names nobody", async () => {
    await reject({ sourceMix: [] });
  });

  it("accepts a mix alongside the pooled default, which is what the form sends", async () => {
    // "Use company rules" is the ABSENCE of a pick, so it is the one content
    // source a mix may accompany — the rule above must not reach this far.
    const { deps, calls } = makeMixDeps();

    const result = await bulkGeneratePosts(
      SLUG,
      USER_ID,
      false,
      makeInput({ sourceMix: BRIEF_MIX, contentSource: { kind: "company_rules" } }),
      deps
    );

    assert.equal(result.success, true);
    assert.equal(calls().length, 5);
  });
});
