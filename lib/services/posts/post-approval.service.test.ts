import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { approvePost, canApprove } from "./post-approval.service";
import type { ApprovalDb, ApprovalDeps } from "./post-approval.service";
import { decidePublish } from "@/lib/scheduling/publish-window";

// 12:00 Europe/Sofia (UTC+3) — the slot from the bug report, and the moment
// twelve minutes before it when the owner pressed Approve.
const SOFIA_NOON = new Date("2026-08-12T09:00:00.000Z");
const APPROVED_AT = new Date("2026-08-12T08:48:00.000Z");

interface PostRow {
  companyId: string;
  status: string;
  scheduledFor: Date | null;
  manuallyScheduled: boolean;
}

/** A manual bulk post as bulkGeneratePosts writes it: a draft with a time. */
function bulkDraft(overrides: Partial<PostRow> = {}): PostRow {
  return {
    companyId: "co-1",
    status: "draft",
    scheduledFor: SOFIA_NOON,
    manuallyScheduled: true,
    ...overrides,
  };
}

/**
 * A SINGLE manually generated post with a chosen time, as the generation form
 * writes it (generate-draft-post.service.ts: `manuallyScheduled` is derived from
 * `scheduledFor` with no `scheduleId`).
 *
 * Byte-identical to `bulkDraft` — and that IS the assertion. `PostRow` is the
 * whole shape the approval and publishing rules read, and there is no batch
 * field in it, so nothing downstream can tell a single post from a bulk one.
 * Kept as its own factory because the single-post flow is what the regression
 * tests below are about, and a reader should not have to know they are the same.
 */
function singleDraft(overrides: Partial<PostRow> = {}): PostRow {
  return {
    companyId: "co-1",
    status: "draft",
    scheduledFor: SOFIA_NOON,
    manuallyScheduled: true,
    ...overrides,
  };
}

/** A cron post: a time the weekly filler estimated, no batch. */
function cronPost(overrides: Partial<PostRow> = {}): PostRow {
  return {
    companyId: "co-1",
    status: "pending_approval",
    scheduledFor: SOFIA_NOON,
    manuallyScheduled: false,
    ...overrides,
  };
}

interface UpdateData {
  status: string;
  approvedById?: string;
  approvedAt?: Date;
  [key: string]: unknown;
}

function makeDeps(
  post: PostRow | null,
  options: { role?: string | null; now?: Date } = {}
): {
  deps: ApprovalDeps;
  updates: () => UpdateData[];
  audits: () => string[];
  membershipLookups: () => number;
} {
  const updates: UpdateData[] = [];
  const audits: string[] = [];
  let membershipLookups = 0;

  const db: ApprovalDb = {
    post: {
      findUnique: async () => post,
      update: async (args) => {
        updates.push(args.data as UpdateData);
        return {};
      },
    },
    companyMember: {
      findFirst: async () => {
        membershipLookups++;
        const role = options.role === undefined ? "owner" : options.role;
        return role === null ? null : { role };
      },
    },
  };

  return {
    deps: {
      db,
      auditLog: async (entry) => {
        audits.push(entry.action);
      },
      now: () => options.now ?? APPROVED_AT,
    },
    updates: () => updates,
    audits: () => audits,
    membershipLookups: () => membershipLookups,
  };
}

// ─── The bug: a manual bulk draft could not be approved at all ────────────────

describe("approvePost — a manual bulk draft scheduled for later", () => {
  it("approves it without sending it to Buffer", async () => {
    // The reported failure: the post is created as a draft with a 12:00 slot, the
    // owner approves at 11:48, and the approve route answered 422 — leaving the
    // publish button, which sends immediately, as the only way forward.
    const { deps, updates, audits } = makeDeps(bulkDraft());

    const result = await approvePost("p-1", "owner-1", false, deps);

    assert.deepEqual(result, { success: true, status: "APPROVED" });

    assert.equal(updates().length, 1);
    const data = updates()[0];
    assert.equal(data.status, "approved");
    assert.equal(data.approvedById, "owner-1");
    assert.deepEqual(data.approvedAt, APPROVED_AT);

    // Nothing about delivery is written, because nothing was delivered. This
    // service has no Buffer client to call in the first place — these assertions
    // are here so a future edit cannot quietly give it one.
    assert.notEqual(data.status, "sent_to_buffer");
    for (const field of ["bufferUpdateId", "publishedAt", "publishedPostUrl"]) {
      assert.equal(field in data, false, `${field} must not be written by an approval`);
    }
    assert.deepEqual(audits(), ["POST_APPROVED"], "approval only — no publish entry");
  });

  it("leaves scheduledFor and manuallyScheduled untouched", async () => {
    // The sweep finds the post by exactly these two fields, so an approval that
    // rewrote either would either lose the schedule or turn the post automatic.
    const { deps, updates } = makeDeps(bulkDraft());

    await approvePost("p-1", "owner-1", false, deps);

    for (const field of ["scheduledFor", "manuallyScheduled"]) {
      assert.equal(field in updates()[0], false, `${field} must survive the approval`);
    }
  });

  it("hands the post to the sweep, which still waits for 12:00", async () => {
    // The whole point of approving without publishing: at 11:48 the publisher
    // must pass over this post, and at 12:00 pick it up.
    const post = bulkDraft();
    const { deps } = makeDeps(post);

    await approvePost("p-1", "owner-1", false, deps);

    // Unchanged by the approval, so this is what the sweep will read.
    const candidate = {
      scheduledFor: post.scheduledFor,
      manuallyScheduled: post.manuallyScheduled,
    };
    assert.equal(decidePublish(candidate, APPROVED_AT), "not_due");
    assert.equal(decidePublish(candidate, SOFIA_NOON), "publish");
  });

  it("refuses one whose slot has already gone by, asking for a new time", async () => {
    // Approval IS clock-dependent for these now. It used to be granted, on the
    // reasoning that the sweep would decide whether a late post still went out —
    // but the sweep can only park it, so all that produced was an approved post
    // that would never publish and said nothing about why. Asking for a new time
    // is the answer the person can act on. See the SCHEDULE_MISSED block below.
    const { deps, updates } = makeDeps(bulkDraft(), {
      now: new Date("2026-08-14T09:00:00.000Z"),
    });

    const result = await approvePost("p-1", "owner-1", false, deps);

    assert.equal(result.success === false && result.code, "SCHEDULE_MISSED");
    assert.deepEqual(updates(), []);
  });

  it("approves it for a global admin without a membership", async () => {
    const { deps, updates, membershipLookups } = makeDeps(bulkDraft(), { role: null });

    const result = await approvePost("p-1", "admin-1", true, deps);

    assert.equal(result.success, true);
    assert.equal(updates()[0].approvedById, "admin-1");
    assert.equal(membershipLookups(), 0);
  });

  it("still refuses an editor", async () => {
    const { deps, updates, audits } = makeDeps(bulkDraft(), { role: "editor" });

    const result = await approvePost("p-1", "editor-1", false, deps);

    assert.equal(result.success, false);
    assert.equal(result.success === false && result.code, "FORBIDDEN");
    assert.deepEqual(updates(), []);
    assert.deepEqual(audits(), []);
  });
});

// ─── Everything else keeps the contract it had ────────────────────────────────

describe("approvePost — unchanged for other posts", () => {
  it("approves a submitted post", async () => {
    const { deps, updates, audits } = makeDeps(cronPost());

    const result = await approvePost("p-1", "owner-1", false, deps);

    assert.deepEqual(result, { success: true, status: "APPROVED" });
    assert.equal(updates()[0].status, "approved");
    assert.deepEqual(audits(), ["POST_APPROVED"]);
  });

  it("refuses a plain draft, which must still be submitted first", async () => {
    const { deps, updates, audits } = makeDeps(
      bulkDraft({ scheduledFor: null, manuallyScheduled: false })
    );

    const result = await approvePost("p-1", "owner-1", false, deps);

    assert.equal(result.success, false);
    assert.equal(result.success === false && result.code, "INVALID_TRANSITION");
    assert.deepEqual(updates(), [], "a refused approval writes nothing");
    assert.deepEqual(audits(), []);
  });

  it("refuses a cron draft, schedule or no schedule", async () => {
    // The guard that keeps this change out of the automated pipeline: a cron
    // draft is publishable up to 48 hours early, so approving one here would
    // move its publish time, not just its status.
    const { deps, updates } = makeDeps(cronPost({ status: "draft" }));

    const result = await approvePost("p-1", "owner-1", false, deps);

    assert.equal(result.success === false && result.code, "INVALID_TRANSITION");
    assert.deepEqual(updates(), []);
  });

  it("refuses an already approved post rather than re-stamping it", async () => {
    const { deps, updates } = makeDeps(bulkDraft({ status: "approved" }));

    const result = await approvePost("p-1", "owner-1", false, deps);

    assert.equal(result.success === false && result.code, "INVALID_TRANSITION");
    assert.deepEqual(updates(), []);
  });

  it("refuses a rejected bulk post — it has to be resubmitted", async () => {
    const { deps, updates } = makeDeps(bulkDraft({ status: "rejected" }));

    const result = await approvePost("p-1", "owner-1", false, deps);

    assert.equal(result.success === false && result.code, "INVALID_TRANSITION");
    assert.deepEqual(updates(), []);
  });

  it("refuses a post already sent to Buffer", async () => {
    const { deps, updates } = makeDeps(bulkDraft({ status: "sent_to_buffer" }));

    const result = await approvePost("p-1", "owner-1", false, deps);

    assert.equal(result.success === false && result.code, "INVALID_TRANSITION");
    assert.deepEqual(updates(), []);
  });

  it("names the status it refused, so the card can explain itself", async () => {
    const { deps } = makeDeps(bulkDraft({ scheduledFor: null, manuallyScheduled: false }));

    const result = await approvePost("p-1", "owner-1", false, deps);

    assert.match(result.success === false ? (result.message ?? "") : "", /DRAFT/);
  });

  it("is NOT_FOUND for a missing post", async () => {
    const { deps, updates } = makeDeps(null);

    const result = await approvePost("p-1", "owner-1", false, deps);

    assert.equal(result.success === false && result.code, "NOT_FOUND");
    assert.deepEqual(updates(), []);
  });

  it("is NOT_FOUND for someone outside the company", async () => {
    // Not FORBIDDEN: a non-member is not told the post exists.
    const { deps, updates } = makeDeps(bulkDraft(), { role: null });

    const result = await approvePost("p-1", "outsider-1", false, deps);

    assert.equal(result.success === false && result.code, "NOT_FOUND");
    assert.deepEqual(updates(), []);
  });
});

// ─── The same guarantee, for a SINGLE manually generated post ────────────────
// The generation form can give one post a time (`scheduledFor` + the derived
// `manuallyScheduled`), exactly as a bulk run gives one to each of its posts.
// These pin down that approving such a post does not deliver it, and that the
// sweep is what does — the single-post half of the guarantee the block above
// establishes for bulk.

describe("approvePost — a single manually generated post scheduled for later", () => {
  it("approves it at 11:48 without sending it to Buffer", async () => {
    const { deps, updates, audits } = makeDeps(singleDraft());

    const result = await approvePost("p-1", "owner-1", false, deps);

    assert.deepEqual(result, { success: true, status: "APPROVED" });

    const data = updates()[0];
    assert.equal(updates().length, 1);
    assert.equal(data.status, "approved");
    assert.equal(data.approvedById, "owner-1");
    // Approved and waiting — never delivered, and never made to LOOK delivered.
    assert.notEqual(data.status, "sent_to_buffer");
    for (const field of ["bufferUpdateId", "publishedAt", "publishedPostUrl"]) {
      assert.equal(field in data, false, `${field} must not be written by an approval`);
    }
    assert.deepEqual(audits(), ["POST_APPROVED"], "approval only — no publish entry");
  });

  it("remains eligible for the sweep, which waits for 12:00 and then sends it", async () => {
    const post = singleDraft();
    const { deps, updates } = makeDeps(post);

    await approvePost("p-1", "owner-1", false, deps);

    // The approval writes neither field, so these are what the sweep reads.
    for (const field of ["scheduledFor", "manuallyScheduled"]) {
      assert.equal(field in updates()[0], false, `${field} must survive the approval`);
    }

    const candidate = {
      scheduledFor: post.scheduledFor,
      manuallyScheduled: post.manuallyScheduled,
    };
    assert.equal(decidePublish(candidate, APPROVED_AT), "not_due");
    assert.equal(decidePublish(candidate, SOFIA_NOON), "publish");
  });

  it("is indistinguishable from a bulk post to both rules", async () => {
    // The requirement in one assertion: from the publishing system's point of
    // view a hand-scheduled single post IS a hand-scheduled bulk post. Nothing
    // reads `generationBatchId` to decide any of this.
    const single = singleDraft();
    const bulk = bulkDraft();

    assert.deepEqual(single, bulk);

    for (const at of [APPROVED_AT, SOFIA_NOON]) {
      assert.equal(
        decidePublish(single, at),
        decidePublish(bulk, at),
        `single and bulk must agree at ${at.toISOString()}`
      );
    }
    assert.equal(canApprove(single, APPROVED_AT), canApprove(bulk, APPROVED_AT));
  });

  it("leaves an UNSCHEDULED single draft to the immediate publish path", async () => {
    // No time was chosen, so there is nothing to wait for: approval alone is
    // refused and the card's approve-and-publish action stays the way out. That
    // is the pre-existing behaviour for every ordinary draft, unchanged.
    const { deps, updates } = makeDeps(
      singleDraft({ scheduledFor: null, manuallyScheduled: false })
    );

    const result = await approvePost("p-1", "owner-1", false, deps);

    assert.equal(result.success, false);
    assert.equal(result.success === false && result.code, "INVALID_TRANSITION");
    assert.deepEqual(updates(), []);
  });
});

// ─── A missed slot must be rescheduled before it can be approved ─────────────
// Enforced in the SERVICE, not just on the card: POST /api/v1/posts/[id]/approve
// is reachable without the UI, and a post approved after its slot would be
// committed to a publish at a moment nobody named.

describe("approvePost — its chosen time has already gone by", () => {
  const ONE_MINUTE_LATE = new Date(SOFIA_NOON.getTime() + 60_000);

  it("refuses a direct API approval one minute after the slot", async () => {
    const { deps, updates, audits } = makeDeps(singleDraft(), { now: ONE_MINUTE_LATE });

    const result = await approvePost("p-1", "owner-1", false, deps);

    assert.equal(result.success, false);
    assert.equal(result.success === false && result.code, "SCHEDULE_MISSED");
    // Nothing written, so the post is intact and one reschedule is all it needs.
    assert.deepEqual(updates(), []);
    assert.deepEqual(audits(), []);
  });

  it("refuses one whose slot is exactly now", async () => {
    const { deps, updates } = makeDeps(singleDraft(), { now: SOFIA_NOON });

    const result = await approvePost("p-1", "owner-1", false, deps);

    assert.equal(result.success === false && result.code, "SCHEDULE_MISSED");
    assert.deepEqual(updates(), []);
  });

  it("refuses one whose slot is days gone", async () => {
    const { deps } = makeDeps(singleDraft(), { now: new Date("2026-08-20T09:00:00.000Z") });

    const result = await approvePost("p-1", "owner-1", false, deps);

    assert.equal(result.success === false && result.code, "SCHEDULE_MISSED");
  });

  it("refuses a submitted post too, not only a draft", async () => {
    const { deps } = makeDeps(singleDraft({ status: "pending_approval" }), {
      now: ONE_MINUTE_LATE,
    });

    const result = await approvePost("p-1", "owner-1", false, deps);

    assert.equal(result.success === false && result.code, "SCHEDULE_MISSED");
  });

  it("refuses a global admin as well — a missed time is not a permission", async () => {
    const { deps } = makeDeps(singleDraft(), { role: null, now: ONE_MINUTE_LATE });

    const result = await approvePost("p-1", "admin-1", true, deps);

    assert.equal(result.success === false && result.code, "SCHEDULE_MISSED");
  });

  it("names the missed time, so the card can explain itself", async () => {
    const { deps } = makeDeps(singleDraft(), { now: ONE_MINUTE_LATE });

    const result = await approvePost("p-1", "owner-1", false, deps);
    const message = result.success === false ? (result.message ?? "") : "";

    assert.match(message, /2026-08-12T09:00:00\.000Z/);
    assert.match(message, /new publish time/);
  });

  it("approves it once it has been rescheduled into the future", async () => {
    // Reschedule → choose a future time → Approve, through the real service.
    const rescheduled = singleDraft({
      scheduledFor: new Date(ONE_MINUTE_LATE.getTime() + 60 * 60 * 1000),
    });
    const { deps, updates, audits } = makeDeps(rescheduled, { now: ONE_MINUTE_LATE });

    const result = await approvePost("p-1", "owner-1", false, deps);

    assert.deepEqual(result, { success: true, status: "APPROVED" });
    assert.equal(updates()[0].status, "approved");
    // Still not published — the sweep does that at the new time.
    assert.notEqual(updates()[0].status, "sent_to_buffer");
    assert.deepEqual(audits(), ["POST_APPROVED"]);
  });

  it("leaves a post already approved before its slot alone", async () => {
    // The distinction that matters: this post WAS approved in time, so the
    // sweep's grace is what applies to it and this rule must not reach it. The
    // status refusal answers first, and no reschedule is demanded of it.
    const { deps } = makeDeps(singleDraft({ status: "approved" }), { now: ONE_MINUTE_LATE });

    const result = await approvePost("p-1", "owner-1", false, deps);

    assert.equal(result.success === false && result.code, "INVALID_TRANSITION");
  });

  it("does not apply to a cron post whose estimate has passed", async () => {
    const { deps, updates } = makeDeps(cronPost(), { now: ONE_MINUTE_LATE });

    const result = await approvePost("p-1", "owner-1", false, deps);

    assert.equal(result.success, true);
    assert.equal(updates()[0].status, "approved");
  });

  it("does not apply to an unscheduled submitted post", async () => {
    const { deps } = makeDeps(cronPost({ scheduledFor: null, manuallyScheduled: false }), {
      now: ONE_MINUTE_LATE,
    });

    const result = await approvePost("p-1", "owner-1", false, deps);

    assert.equal(result.success, true);
  });
});

// ─── The rule on its own ─────────────────────────────────────────────────────

describe("canApprove", () => {
  const manual = { scheduledFor: SOFIA_NOON, manuallyScheduled: true };
  const automatic = { scheduledFor: SOFIA_NOON, manuallyScheduled: false };
  const unscheduled = { scheduledFor: null, manuallyScheduled: false };

  // 11:48, twelve minutes before the 12:00 slot — the schedule is still ahead, so
  // these cases are about STATUS alone.
  const BEFORE = APPROVED_AT;

  it("accepts a submitted post whatever its origin", () => {
    for (const post of [manual, automatic, unscheduled]) {
      assert.equal(canApprove({ status: "pending_approval", ...post }, BEFORE), null);
    }
  });

  it("accepts a draft only when a person chose its time", () => {
    assert.equal(canApprove({ status: "draft", ...manual }, BEFORE), null);
    assert.equal(canApprove({ status: "draft", ...automatic }, BEFORE), "INVALID_TRANSITION");
    assert.equal(canApprove({ status: "draft", ...unscheduled }, BEFORE), "INVALID_TRANSITION");
  });

  it("rejects a bulk draft with no time — there is nothing to wait for", () => {
    // Approving it would leave a post that is never due and never publishes.
    assert.equal(
      canApprove({ status: "draft", scheduledFor: null, manuallyScheduled: true }, BEFORE),
      "INVALID_TRANSITION"
    );
  });

  it("accepts no other status", () => {
    for (const status of ["approved", "rejected", "sent_to_buffer", "published", "failed"]) {
      assert.equal(
        canApprove({ status, ...manual }, BEFORE),
        "INVALID_TRANSITION",
        `${status} must not be approvable`
      );
    }
  });

  // ── The second question: has the post's own time gone by? ──────────────────

  it("refuses a hand-scheduled post whose time has passed", () => {
    // One minute past is past — no grace here, deliberately. The person did not
    // approve in time, so the 12:00 promise cannot be kept and a new one is owed.
    const oneMinuteLate = new Date(SOFIA_NOON.getTime() + 60_000);

    for (const status of ["draft", "pending_approval"]) {
      assert.equal(canApprove({ status, ...manual }, oneMinuteLate), "SCHEDULE_MISSED");
    }
  });

  it("refuses one whose time is exactly now", () => {
    // The slot has arrived, so it can no longer be published AT it — the same
    // reason refuseScheduleTime will not let that instant be chosen.
    assert.equal(canApprove({ status: "draft", ...manual }, SOFIA_NOON), "SCHEDULE_MISSED");
  });

  it("accepts one a millisecond before its time", () => {
    const justInTime = new Date(SOFIA_NOON.getTime() - 1);

    assert.equal(canApprove({ status: "draft", ...manual }, justInTime), null);
  });

  it("refuses one whose time is far in the past", () => {
    assert.equal(
      canApprove({ status: "draft", ...manual }, new Date("2026-09-01T09:00:00.000Z")),
      "SCHEDULE_MISSED"
    );
  });

  it("accepts it again once it has been rescheduled into the future", () => {
    // The whole flow: Reschedule → choose a future time → Approve.
    const now = new Date(SOFIA_NOON.getTime() + 60_000);
    const missed = { status: "draft", ...manual };
    assert.equal(canApprove(missed, now), "SCHEDULE_MISSED");

    const rescheduled = { ...missed, scheduledFor: new Date(now.getTime() + 60 * 60 * 1000) };
    assert.equal(canApprove(rescheduled, now), null);
  });

  it("names the status refusal ahead of the schedule one", () => {
    // A post that cannot be approved at all should not be told to pick a new
    // time — that would be advice it cannot act on.
    assert.equal(
      canApprove({ status: "sent_to_buffer", ...manual }, new Date(SOFIA_NOON.getTime() + 60_000)),
      "INVALID_TRANSITION"
    );
  });

  it("ignores the clock for posts nobody hand-scheduled", () => {
    // A cron estimate is not a promise, and an unscheduled post has no time to
    // miss. Both keep approving exactly as before, however late it is.
    const late = new Date("2026-09-01T09:00:00.000Z");

    assert.equal(canApprove({ status: "pending_approval", ...automatic }, late), null);
    assert.equal(canApprove({ status: "pending_approval", ...unscheduled }, late), null);
  });
});
