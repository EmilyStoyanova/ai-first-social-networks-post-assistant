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

  it("approves one whose slot has already gone by", async () => {
    // Approval is not clock-dependent: whether a late post still goes out is the
    // sweep's decision (past_due parks it), not a reason to refuse the approval
    // and strand the post in draft.
    const { deps, updates } = makeDeps(bulkDraft(), {
      now: new Date("2026-08-14T09:00:00.000Z"),
    });

    const result = await approvePost("p-1", "owner-1", false, deps);

    assert.equal(result.success, true);
    assert.equal(updates()[0].status, "approved");
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

// ─── The rule on its own ─────────────────────────────────────────────────────

describe("canApprove", () => {
  const manual = { scheduledFor: SOFIA_NOON, manuallyScheduled: true };
  const automatic = { scheduledFor: SOFIA_NOON, manuallyScheduled: false };
  const unscheduled = { scheduledFor: null, manuallyScheduled: false };

  it("accepts a submitted post whatever its origin", () => {
    for (const post of [manual, automatic, unscheduled]) {
      assert.equal(canApprove({ status: "pending_approval", ...post }), true);
    }
  });

  it("accepts a draft only when a person chose its time", () => {
    assert.equal(canApprove({ status: "draft", ...manual }), true);
    assert.equal(canApprove({ status: "draft", ...automatic }), false);
    assert.equal(canApprove({ status: "draft", ...unscheduled }), false);
  });

  it("rejects a bulk draft with no time — there is nothing to wait for", () => {
    // Approving it would leave a post that is never due and never publishes.
    assert.equal(
      canApprove({ status: "draft", scheduledFor: null, manuallyScheduled: true }),
      false
    );
  });

  it("accepts no other status", () => {
    for (const status of ["approved", "rejected", "sent_to_buffer", "published", "failed"]) {
      assert.equal(canApprove({ status, ...manual }), false, `${status} must not be approvable`);
    }
  });
});
