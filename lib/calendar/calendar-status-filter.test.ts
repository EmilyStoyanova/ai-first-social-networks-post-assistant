import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CALENDAR_STATUS_FILTERS,
  buildCalendarStatusQuery,
  calendarStatusCounts,
  filterByCalendarStatus,
  matchesCalendarStatusFilter,
  resolveCalendarStatusFilter,
} from "./calendar-status-filter";

/** Every status a post can hold, one post each — the whole workflow in a list. */
const EVERY_STATUS = [
  { id: "draft", status: "DRAFT" },
  { id: "pending", status: "PENDING_APPROVAL" },
  { id: "approved", status: "APPROVED" },
  { id: "rejected", status: "REJECTED" },
  { id: "sent", status: "SENT_TO_BUFFER" },
  { id: "published", status: "PUBLISHED" },
  { id: "failed", status: "FAILED" },
];

function ids(filter: Parameters<typeof filterByCalendarStatus>[1]): string[] {
  return filterByCalendarStatus(EVERY_STATUS, filter).map((p) => p.id);
}

describe("resolveCalendarStatusFilter", () => {
  it("accepts each of the four filters", () => {
    for (const filter of CALENDAR_STATUS_FILTERS) {
      assert.equal(resolveCalendarStatusFilter(filter), filter);
    }
  });

  it("falls back to 'all' for anything unrecognized", () => {
    assert.equal(resolveCalendarStatusFilter(undefined), "all");
    assert.equal(resolveCalendarStatusFilter("pending_approval"), "all");
    assert.equal(resolveCalendarStatusFilter(["nonsense"]), "all");
  });

  it("tolerates casing and whitespace", () => {
    assert.equal(resolveCalendarStatusFilter(" Drafts "), "drafts");
  });
});

describe("the mapping from post statuses to calendar buckets", () => {
  it("shows everything under All Posts, including rejected and failed", () => {
    // The bucket a post needing attention is always visible in.
    assert.deepEqual(
      ids("all"),
      EVERY_STATUS.map((p) => p.id)
    );
  });

  it("counts draft and pending approval as Drafts — both mean 'not approved yet'", () => {
    assert.deepEqual(ids("drafts"), ["draft", "pending"]);
  });

  it("counts approved, and only approved, as Scheduled", () => {
    // The workflow's own definition: `publishCandidateWhere` selects
    // status "approved" with a scheduledFor, so approved IS the delivery queue.
    assert.deepEqual(ids("scheduled"), ["approved"]);
  });

  it("counts sent_to_buffer and published as Published", () => {
    // The same pair the posts grid and the metrics sync treat as "it went out".
    assert.deepEqual(ids("published"), ["sent", "published"]);
  });

  it("keeps rejected out of Drafts — rejection is a decision, not work in progress", () => {
    assert.equal(matchesCalendarStatusFilter("REJECTED", "drafts"), false);
    assert.equal(matchesCalendarStatusFilter("REJECTED", "scheduled"), false);
    assert.equal(matchesCalendarStatusFilter("REJECTED", "published"), false);
    assert.equal(matchesCalendarStatusFilter("REJECTED", "all"), true);
  });

  it("keeps failed out of Published and Scheduled — the post did not go out, and is not coming", () => {
    assert.equal(matchesCalendarStatusFilter("FAILED", "published"), false);
    assert.equal(matchesCalendarStatusFilter("FAILED", "scheduled"), false);
    assert.equal(matchesCalendarStatusFilter("FAILED", "drafts"), false);
    assert.equal(matchesCalendarStatusFilter("FAILED", "all"), true);
  });

  it("puts every post in at most one bucket besides All Posts", () => {
    // Overlapping buckets would make the counts add up to more than the period
    // holds, which is the first thing an owner would notice.
    for (const post of EVERY_STATUS) {
      const matched = (["drafts", "scheduled", "published"] as const).filter((filter) =>
        matchesCalendarStatusFilter(post.status, filter)
      );
      assert.ok(matched.length <= 1, `${post.status} matched ${matched.join(", ")}`);
    }
  });

  it("reads a raw lowercase Prisma value the same as an uppercased one", () => {
    assert.equal(matchesCalendarStatusFilter("sent_to_buffer", "published"), true);
    assert.equal(matchesCalendarStatusFilter(" approved ", "scheduled"), true);
  });
});

describe("calendarStatusCounts", () => {
  it("counts every filter from the same predicate the grid uses", () => {
    assert.deepEqual(calendarStatusCounts(EVERY_STATUS), {
      all: 7,
      drafts: 2,
      scheduled: 1,
      published: 2,
    });
  });

  it("is all zeroes for an empty period", () => {
    assert.deepEqual(calendarStatusCounts([]), {
      all: 0,
      drafts: 0,
      scheduled: 0,
      published: 0,
    });
  });
});

describe("buildCalendarStatusQuery", () => {
  it("changes the filter and keeps the week the user is looking at", () => {
    const params = new URLSearchParams(
      buildCalendarStatusQuery("view=month&date=2026-08-18&status=all", "published")
    );

    assert.equal(params.get("status"), "published");
    assert.equal(params.get("view"), "month");
    assert.equal(params.get("date"), "2026-08-18");
  });
});
