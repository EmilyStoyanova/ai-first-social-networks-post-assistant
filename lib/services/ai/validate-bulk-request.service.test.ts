import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateBulkRequest,
  validateBulkRequestShape,
  validateSourceMix,
  type BulkRequestShape,
} from "./validate-bulk-request.service";
import { MAX_BULK_POSTS } from "@/lib/scheduling/bulk-schedule";

/** A week before the period below, so "the start date is in the future" holds. */
const NOW = new Date("2026-08-10T09:00:00.000Z");
const START = "2026-08-17";
const END = "2026-08-30";

/** A channel whose owner has said when it publishes. */
const CONFIGURED = [
  { day: "MONDAY", start: "09:00", end: "17:00" },
  { day: "THURSDAY", start: "18:30", end: "20:00" },
];

function makeRequest(overrides: Partial<BulkRequestShape> = {}): BulkRequestShape {
  return {
    channels: ["facebook"],
    numberOfPosts: 2,
    startDate: START,
    endDate: END,
    ...overrides,
  };
}

// ─── The pure rules ───────────────────────────────────────────────────────────

describe("validateBulkRequestShape", () => {
  it("accepts an ordinary request", () => {
    assert.equal(validateBulkRequestShape(makeRequest(), NOW), null);
  });

  it("refuses a topic count outside the allowed range", () => {
    for (const numberOfPosts of [0, -1, MAX_BULK_POSTS + 1, 2.5, Number.NaN]) {
      const problem = validateBulkRequestShape(makeRequest({ numberOfPosts }), NOW);
      assert.equal(problem?.code, "INVALID_POST_COUNT", `for ${numberOfPosts}`);
    }
  });

  it("refuses a period that runs backwards or is unparseable", () => {
    assert.equal(
      validateBulkRequestShape(makeRequest({ startDate: END, endDate: START }), NOW)?.code,
      "INVALID_DATE_RANGE"
    );
    assert.equal(
      validateBulkRequestShape(makeRequest({ endDate: "not-a-date" }), NOW)?.code,
      "INVALID_DATE_RANGE"
    );
  });

  it("refuses a period longer than the cap", () => {
    assert.equal(
      validateBulkRequestShape(makeRequest({ endDate: "2028-08-30" }), NOW)?.code,
      "INVALID_DATE_RANGE"
    );
  });

  it("refuses a period that has already begun", () => {
    // Posts scheduled into the past are ones the publisher refuses to fire, so
    // this is cheaper to answer as a request error than as a batch of stranded
    // drafts.
    assert.equal(
      validateBulkRequestShape(makeRequest({ startDate: "2026-08-01" }), NOW)?.code,
      "START_DATE_IN_PAST"
    );
  });

  it("accepts a period starting today", () => {
    assert.equal(validateBulkRequestShape(makeRequest({ startDate: "2026-08-10" }), NOW), null);
  });

  it("refuses a schedule that does not add up to the topics requested", () => {
    const problem = validateBulkRequestShape(
      makeRequest({
        numberOfPosts: 3,
        customDistribution: [{ date: "2026-08-18", count: 1, times: ["10:00"] }],
      }),
      NOW
    );
    assert.equal(problem?.code, "INVALID_DISTRIBUTION");
    assert.ok(problem.message.length > 0);
  });

  it("refuses a schedule with a date outside the period", () => {
    assert.equal(
      validateBulkRequestShape(
        makeRequest({
          numberOfPosts: 1,
          customDistribution: [{ date: "2027-01-05", count: 1, times: ["10:00"] }],
        }),
        NOW
      )?.code,
      "INVALID_DISTRIBUTION"
    );
  });

  it("accepts a schedule that adds up and stays inside the period", () => {
    assert.equal(
      validateBulkRequestShape(
        makeRequest({
          numberOfPosts: 2,
          customDistribution: [
            { date: "2026-08-18", count: 1, times: ["10:00"] },
            { date: "2026-08-20", count: 1, times: ["14:30"] },
          ],
        }),
        NOW
      ),
      null
    );
  });

  it("reports the first problem when a request is wrong in several ways", () => {
    // Ordering is part of the contract: a caller may have built on being told
    // about the count first, so a second fault does not change the answer.
    const problem = validateBulkRequestShape(
      makeRequest({ numberOfPosts: 99, startDate: "2020-01-01", endDate: "2019-01-01" }),
      NOW
    );
    assert.equal(problem?.code, "INVALID_POST_COUNT");
  });

  it("never touches the source mix", () => {
    // The mix needs a database read, so it is deliberately not part of the pure
    // half — a caller using this alone must not silently skip that check.
    assert.equal(
      validateBulkRequestShape(makeRequest({ sourceMix: [{ sourceId: "nope", posts: 99 }] }), NOW),
      null
    );
  });
});

// ─── The content mix ──────────────────────────────────────────────────────────

describe("validateSourceMix", () => {
  const enabled = new Set(["source-a", "source-b"]);

  it("accepts a mix that adds up and names real, enabled sources", () => {
    assert.equal(
      validateSourceMix(
        [
          { sourceId: "source-a", posts: 1 },
          { sourceId: null, posts: 1 },
        ],
        2,
        undefined,
        enabled
      ),
      null
    );
  });

  it("refuses a mix that does not add up to the topics requested", () => {
    // Load-bearing: the mix IS the batch, so a mix that does not add up would
    // silently generate a different number of topics than the button promised.
    assert.ok(validateSourceMix([{ sourceId: "source-a", posts: 3 }], 2, undefined, enabled));
  });

  it("refuses a source this company does not have or has switched off", () => {
    assert.ok(validateSourceMix([{ sourceId: "source-z", posts: 2 }], 2, undefined, enabled));
  });

  it("refuses the same source listed twice", () => {
    assert.ok(
      validateSourceMix(
        [
          { sourceId: "source-a", posts: 1 },
          { sourceId: "source-a", posts: 1 },
        ],
        2,
        undefined,
        enabled
      )
    );
  });

  it("refuses a quota that is not a whole post", () => {
    assert.ok(validateSourceMix([{ sourceId: "source-a", posts: 0 }], 0, undefined, enabled));
    assert.ok(validateSourceMix([{ sourceId: "source-a", posts: 1.5 }], 1.5, undefined, enabled));
  });

  it("refuses a mix that names nobody", () => {
    assert.ok(validateSourceMix([], 2, undefined, enabled));
  });

  it("refuses a mix and a single picked source together", () => {
    // Alternatives, not layers — letting both through would leave the answer to
    // whichever the generation loop happened to read.
    assert.ok(
      validateSourceMix(
        [{ sourceId: "source-a", posts: 2 }],
        2,
        { kind: "source", sourceId: "source-b" },
        enabled
      )
    );
  });

  it("accepts a mix alongside the pooled default, which is what the form sends", () => {
    assert.equal(
      validateSourceMix(
        [{ sourceId: "source-a", posts: 2 }],
        2,
        { kind: "company_rules" },
        enabled
      ),
      null
    );
  });
});

// ─── The whole check ──────────────────────────────────────────────────────────

describe("validateBulkRequest", () => {
  const loadEnabledSourceIds = async () => new Set(["source-a"]);
  const loadPostingWindows = async () => CONFIGURED;

  it("accepts a valid request", async () => {
    const problem = await validateBulkRequest("acme", makeRequest(), NOW, {
      loadEnabledSourceIds,
      loadPostingWindows,
    });

    assert.equal(problem, null);
  });

  it("does not read the content sources when no mix was submitted", async () => {
    let reads = 0;
    const problem = await validateBulkRequest("acme", makeRequest(), NOW, {
      loadPostingWindows,
      loadEnabledSourceIds: async () => {
        reads += 1;
        return new Set<string>();
      },
    });

    assert.equal(problem, null);
    assert.equal(reads, 0);
  });

  it("answers a shape problem before reading the database", async () => {
    let reads = 0;
    const countingRead = async () => {
      reads += 1;
      return new Set<string>();
    };

    const problem = await validateBulkRequest(
      "acme",
      makeRequest({ numberOfPosts: 99, sourceMix: [{ sourceId: "source-a", posts: 99 }] }),
      NOW,
      {
        loadEnabledSourceIds: countingRead,
        loadPostingWindows: async () => {
          reads += 1;
          return CONFIGURED;
        },
      }
    );

    assert.equal(problem?.code, "INVALID_POST_COUNT");
    assert.equal(reads, 0);
  });

  it("checks a submitted mix against the company's real sources", async () => {
    const problem = await validateBulkRequest(
      "acme",
      makeRequest({ sourceMix: [{ sourceId: "source-nope", posts: 2 }] }),
      NOW,
      { loadEnabledSourceIds, loadPostingWindows }
    );

    assert.equal(problem?.code, "INVALID_SOURCE_MIX");
  });

  it("accepts a mix that names real sources and adds up", async () => {
    const problem = await validateBulkRequest(
      "acme",
      makeRequest({ sourceMix: [{ sourceId: "source-a", posts: 2 }] }),
      NOW,
      { loadEnabledSourceIds, loadPostingWindows }
    );

    assert.equal(problem, null);
  });
});

// ─── No posting windows, even distribution ────────────────────────────────────
//
// The manual half of "the system never invents an hour". An even spread is
// derived entirely from the channel's configured times, so a channel with none
// cannot be planned for — and is told so, rather than being given a default hour
// (which is what used to happen) or being handed a silent batch of zero (which
// is what removing the default alone would have produced).

describe("validateBulkRequest — the posting-window requirement", () => {
  const loadEnabledSourceIds = async () => new Set(["source-a"]);

  /** Every shape a channel with nothing configured can arrive in. */
  const NOTHING_CONFIGURED = [null, undefined, [], {}, "windows", 0, [{ day: "FUNDAY" }]];

  it("refuses an even distribution over a channel with no windows", async () => {
    for (const windows of NOTHING_CONFIGURED) {
      const problem = await validateBulkRequest("acme", makeRequest(), NOW, {
        loadEnabledSourceIds,
        loadPostingWindows: async () => windows,
      });

      assert.equal(problem?.code, "NO_POSTING_WINDOWS", `for ${JSON.stringify(windows)}`);
    }
  });

  it("names the channels that need configuring", async () => {
    const problem = await validateBulkRequest(
      "acme",
      makeRequest({ channels: ["facebook", "linkedin"] }),
      NOW,
      {
        loadEnabledSourceIds,
        // LinkedIn is set up; Facebook is not. The message has to say which.
        loadPostingWindows: async (_slug, channel) => (channel === "linkedin" ? CONFIGURED : null),
      }
    );

    assert.equal(problem?.code, "NO_POSTING_WINDOWS");
    assert.match(problem.message, /facebook/);
    assert.doesNotMatch(problem.message, /linkedin/);
  });

  it("refuses when ONE channel of a multi-channel batch is unconfigured", async () => {
    // Each channel plans its own slots from its own windows, so one without any
    // is enough — there is no hour for its share of the batch.
    const problem = await validateBulkRequest(
      "acme",
      makeRequest({ channels: ["facebook", "linkedin", "instagram"] }),
      NOW,
      {
        loadEnabledSourceIds,
        loadPostingWindows: async (_slug, channel) => (channel === "instagram" ? [] : CONFIGURED),
      }
    );

    assert.equal(problem?.code, "NO_POSTING_WINDOWS");
  });

  it("accepts an even distribution when every channel has windows", async () => {
    const problem = await validateBulkRequest(
      "acme",
      makeRequest({ channels: ["facebook", "linkedin"] }),
      NOW,
      { loadEnabledSourceIds, loadPostingWindows: async () => CONFIGURED }
    );

    assert.equal(problem, null);
  });

  it("does not require windows for a CUSTOM distribution", async () => {
    // The other way out: the user names every date and time, so the channel's
    // schedule has nothing to contribute and its absence cannot block anything.
    let reads = 0;
    const problem = await validateBulkRequest(
      "acme",
      makeRequest({
        numberOfPosts: 2,
        customDistribution: [
          { date: "2026-08-18", count: 1, times: ["11:30"] },
          { date: "2026-08-20", count: 1, times: ["14:30"] },
        ],
      }),
      NOW,
      {
        loadEnabledSourceIds,
        loadPostingWindows: async () => {
          reads += 1;
          return null;
        },
      }
    );

    assert.equal(problem, null);
    // Not merely tolerated — never asked about.
    assert.equal(reads, 0);
  });

  it("still refuses a custom distribution with an unfilled time, without inventing one", async () => {
    // The empty string is what an unseeded time input sends. It must come back
    // as a validation error, NOT as a post quietly scheduled at some default.
    const problem = await validateBulkRequest(
      "acme",
      makeRequest({
        numberOfPosts: 1,
        customDistribution: [{ date: "2026-08-18", count: 1, times: [""] }],
      }),
      NOW,
      { loadEnabledSourceIds, loadPostingWindows: async () => null }
    );

    assert.equal(problem?.code, "INVALID_DISTRIBUTION");
  });

  it("answers the window problem before the content mix", async () => {
    // Ordering is contract, as it is for the pure rules: a batch that cannot be
    // scheduled at all is not usefully told about its content mix first.
    const problem = await validateBulkRequest(
      "acme",
      makeRequest({ sourceMix: [{ sourceId: "source-nope", posts: 2 }] }),
      NOW,
      { loadEnabledSourceIds, loadPostingWindows: async () => null }
    );

    assert.equal(problem?.code, "NO_POSTING_WINDOWS");
  });
});

// ─── The period and the schedule have to meet ─────────────────────────────────
//
// Having a schedule is not the same as having room in it. Two further ways an
// even distribution can be unanswerable, both decided entirely by the request
// and the saved configuration, and both refused here rather than resolved by
// publishing on a weekday nobody configured or past the end of a window.

describe("validateBulkRequest — the period has to contain the schedule", () => {
  const loadEnabledSourceIds = async () => new Set(["source-a"]);

  /** Mondays only, one hour wide — one slot per Monday in the period. */
  const MONDAY_ONLY = [{ day: "MONDAY", start: "09:00", end: "10:00" }];
  /** One Friday afternoon: five hourly slots per Friday in the period. */
  const FRIDAY_AFTERNOON = [{ day: "FRIDAY", start: "12:00", end: "17:00" }];

  it("refuses a period holding none of the channel's posting days", async () => {
    // Tue–Thu asked of a Monday-only channel. It used to publish on all three at
    // Monday's hour; now the request is refused and the user widens the period.
    const problem = await validateBulkRequest(
      "acme",
      makeRequest({ numberOfPosts: 1, startDate: "2026-08-18", endDate: "2026-08-20" }),
      NOW,
      { loadEnabledSourceIds, loadPostingWindows: async () => MONDAY_ONLY }
    );

    assert.equal(problem?.code, "NO_POSTING_DAYS_IN_PERIOD");
    // The days are named, because that is what makes the refusal actionable.
    assert.match(problem.message, /Monday/);
    assert.match(problem.message, /facebook/);
  });

  it("refuses more posts than the period has room for", async () => {
    // One Friday, five hourly slots, six posts. The sixth used to become 17:00.
    const problem = await validateBulkRequest(
      "acme",
      makeRequest({ numberOfPosts: 6, startDate: "2026-08-21", endDate: "2026-08-21" }),
      NOW,
      { loadEnabledSourceIds, loadPostingWindows: async () => FRIDAY_AFTERNOON }
    );

    assert.equal(problem?.code, "INSUFFICIENT_POSTING_SLOTS");
    assert.match(problem.message, /6 posts were requested/);
    assert.match(problem.message, /facebook has room for 5/);
  });

  it("accepts a request that fills the period exactly", async () => {
    const problem = await validateBulkRequest(
      "acme",
      makeRequest({ numberOfPosts: 5, startDate: "2026-08-21", endDate: "2026-08-21" }),
      NOW,
      { loadEnabledSourceIds, loadPostingWindows: async () => FRIDAY_AFTERNOON }
    );

    assert.equal(problem, null);
  });

  it("plans each channel from its OWN windows", async () => {
    // Facebook publishes on the Monday in this period; Instagram does not
    // publish that week at all. Facebook's schedule cannot cover for it, and the
    // whole request is refused rather than half of it quietly generated.
    const problem = await validateBulkRequest(
      "acme",
      makeRequest({
        channels: ["facebook", "instagram"],
        numberOfPosts: 1,
        startDate: "2026-08-17",
        endDate: "2026-08-17",
      }),
      NOW,
      {
        loadEnabledSourceIds,
        loadPostingWindows: async (_slug, channel) =>
          channel === "facebook" ? MONDAY_ONLY : FRIDAY_AFTERNOON,
      }
    );

    assert.equal(problem?.code, "NO_POSTING_DAYS_IN_PERIOD");
    assert.match(problem.message, /instagram/);
    assert.doesNotMatch(problem.message, /facebook/);
  });

  it("refuses the whole batch when one channel of several is short of room", async () => {
    // LinkedIn has all week; Instagram has one Friday afternoon. Generating the
    // LinkedIn versions and dropping the Instagram ones would leave a batch whose
    // content exists on one network and not the other, found out in the grid.
    const problem = await validateBulkRequest(
      "acme",
      makeRequest({
        channels: ["linkedin", "instagram"],
        numberOfPosts: 6,
        startDate: "2026-08-17",
        endDate: "2026-08-21",
      }),
      NOW,
      {
        loadEnabledSourceIds,
        loadPostingWindows: async (_slug, channel) =>
          channel === "linkedin"
            ? ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"].map((day) => ({
                day,
                start: "09:00",
                end: "12:00",
              }))
            : FRIDAY_AFTERNOON,
      }
    );

    assert.equal(problem?.code, "INSUFFICIENT_POSTING_SLOTS");
    assert.match(problem.message, /instagram has room for 5/);
    assert.doesNotMatch(problem.message, /linkedin has room/);
  });

  it("reports the reasons in the order they are worth fixing", async () => {
    // No schedule at all cannot be helped by a wider period, so it is said
    // first; a period that contains no posting day at all is said before one
    // that merely has too little room in it.
    const byChannel: Record<string, unknown> = {
      facebook: null, // no schedule
      linkedin: MONDAY_ONLY, // has one, but not in a Fri-only period
      instagram: FRIDAY_AFTERNOON, // has room for 5, not 6
    };
    const request = makeRequest({
      channels: ["facebook", "linkedin", "instagram"],
      numberOfPosts: 6,
      startDate: "2026-08-21",
      endDate: "2026-08-21",
    });
    const deps = {
      loadEnabledSourceIds,
      loadPostingWindows: async (_slug: string, channel: string) => byChannel[channel],
    };

    assert.equal(
      (await validateBulkRequest("acme", request, NOW, deps))?.code,
      "NO_POSTING_WINDOWS"
    );

    byChannel.facebook = FRIDAY_AFTERNOON;
    assert.equal(
      (await validateBulkRequest("acme", request, NOW, deps))?.code,
      "NO_POSTING_DAYS_IN_PERIOD"
    );

    byChannel.linkedin = FRIDAY_AFTERNOON;
    assert.equal(
      (await validateBulkRequest("acme", request, NOW, deps))?.code,
      "INSUFFICIENT_POSTING_SLOTS"
    );
  });

  it("applies none of this to a CUSTOM distribution", async () => {
    // The user named every date and time, including days the channel does not
    // normally publish on and more posts than its windows would hold. That is
    // the whole point of the mode, and the windows are never even read.
    let reads = 0;
    const problem = await validateBulkRequest(
      "acme",
      makeRequest({
        numberOfPosts: 3,
        startDate: "2026-08-18",
        endDate: "2026-08-18",
        customDistribution: [{ date: "2026-08-18", count: 3, times: ["08:00", "12:00", "21:00"] }],
      }),
      NOW,
      {
        loadEnabledSourceIds,
        loadPostingWindows: async () => {
          reads += 1;
          return MONDAY_ONLY;
        },
      }
    );

    assert.equal(problem, null);
    assert.equal(reads, 0);
  });
});

// ─── A period that has already begun ──────────────────────────────────────────
//
// A bulk period may legitimately start TODAY, and by the time somebody fills the
// form in, today's window has usually already opened. Every eligible slot becomes
// a real `Post.scheduledFor`, so the ones behind the clock have to go — otherwise
// a batch planned at 15:00 is scheduled for 09:00 that morning and is past due
// before it has been written.

describe("validateBulkRequest — today's window may already be spent", () => {
  const loadEnabledSourceIds = async () => new Set(["source-a"]);

  /** 2026-08-21, a Friday. 09:00–14:00 Sofia = five slots, 06:00Z…10:00Z. */
  const FRIDAY = "2026-08-21";
  const FRIDAY_MORNING = [{ day: "FRIDAY", start: "09:00", end: "14:00" }];

  /** 11:30 Sofia on that Friday — three slots gone, two still ahead. */
  const MIDWAY = new Date("2026-08-21T08:30:00.000Z");
  /** 20:00 Sofia on that Friday — the window is over. */
  const AFTERWARDS = new Date("2026-08-21T17:00:00.000Z");

  const today = (overrides = {}) =>
    makeRequest({ numberOfPosts: 1, startDate: FRIDAY, endDate: FRIDAY, ...overrides });

  it("counts only the slots still ahead as available", async () => {
    // Five slots on the day, three of them behind the clock. The count the user
    // is given has to be the two that remain, not the five the window describes.
    const problem = await validateBulkRequest("acme", today({ numberOfPosts: 3 }), MIDWAY, {
      loadEnabledSourceIds,
      loadPostingWindows: async () => FRIDAY_MORNING,
    });

    assert.equal(problem?.code, "INSUFFICIENT_POSTING_SLOTS");
    assert.match(problem.message, /3 posts were requested/);
    assert.match(problem.message, /facebook has room for 2/);
  });

  it("accepts a request that fits the slots still ahead", async () => {
    const problem = await validateBulkRequest("acme", today({ numberOfPosts: 2 }), MIDWAY, {
      loadEnabledSourceIds,
      loadPostingWindows: async () => FRIDAY_MORNING,
    });

    assert.equal(problem, null);
  });

  it("has its own code once every slot has gone by", async () => {
    // Not INSUFFICIENT_POSTING_SLOTS with zero: "ask for fewer posts" is wrong
    // advice when no number of posts fits.
    const problem = await validateBulkRequest("acme", today(), AFTERWARDS, {
      loadEnabledSourceIds,
      loadPostingWindows: async () => FRIDAY_MORNING,
    });

    assert.equal(problem?.code, "NO_FUTURE_POSTING_SLOTS");
    assert.match(problem.message, /facebook/);
    assert.match(problem.message, /already passed/);
  });

  it("keeps 'the day never occurs' distinct from 'the day is over'", async () => {
    // Both leave nothing to schedule, and they are fixed differently: one by
    // widening the period, the other by choosing a later one.
    const problem = await validateBulkRequest(
      "acme",
      makeRequest({ numberOfPosts: 1, startDate: "2026-08-18", endDate: "2026-08-20" }),
      NOW,
      { loadEnabledSourceIds, loadPostingWindows: async () => FRIDAY_MORNING }
    );

    assert.equal(problem?.code, "NO_POSTING_DAYS_IN_PERIOD");
  });

  it("refuses the whole batch when one channel of several has nothing left", async () => {
    // Facebook still has its afternoon; Instagram published this morning only.
    // Generating the Facebook half would leave a batch whose content exists on
    // one network and not the other.
    const problem = await validateBulkRequest(
      "acme",
      today({ channels: ["facebook", "instagram"] }),
      MIDWAY,
      {
        loadEnabledSourceIds,
        loadPostingWindows: async (_slug, channel) =>
          channel === "facebook"
            ? FRIDAY_MORNING
            : [{ day: "FRIDAY", start: "07:00", end: "09:00" }],
      }
    );

    assert.equal(problem?.code, "NO_FUTURE_POSTING_SLOTS");
    assert.match(problem.message, /instagram/);
    assert.doesNotMatch(problem.message, /facebook/);
  });

  it("leaves a period that has not started alone", async () => {
    const problem = await validateBulkRequest("acme", today({ numberOfPosts: 5 }), NOW, {
      loadEnabledSourceIds,
      loadPostingWindows: async () => FRIDAY_MORNING,
    });

    assert.equal(problem, null);
  });

  it("does not apply the rule to a CUSTOM distribution — it has its own", async () => {
    // Custom mode already refuses a chosen time that has gone by, as
    // `time_in_past`, with the same strict comparison. Nothing here changes it,
    // and the windows are still never read.
    const past = await validateBulkRequest(
      "acme",
      today({
        numberOfPosts: 1,
        customDistribution: [{ date: FRIDAY, count: 1, times: ["09:00"] }],
      }),
      MIDWAY,
      { loadEnabledSourceIds, loadPostingWindows: async () => FRIDAY_MORNING }
    );
    assert.equal(past?.code, "INVALID_DISTRIBUTION");

    // …and a time still ahead is accepted, on a day the channel does not even
    // publish slots for by then.
    const ahead = await validateBulkRequest(
      "acme",
      today({
        numberOfPosts: 1,
        customDistribution: [{ date: FRIDAY, count: 1, times: ["22:00"] }],
      }),
      MIDWAY,
      { loadEnabledSourceIds, loadPostingWindows: async () => FRIDAY_MORNING }
    );
    assert.equal(ahead, null);
  });
});
