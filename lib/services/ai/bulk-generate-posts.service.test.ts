import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bulkGeneratePosts,
  classifyBulkFailure,
  type BulkGeneratePostsDeps,
  type BulkGeneratePostsInput,
} from "./bulk-generate-posts.service";
import type {
  GenerateDraftPostErrorCode,
  GenerateDraftPostResult,
  GeneratedPostDTO,
} from "./generate-draft-post.service";
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
    channel: "linkedin",
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
