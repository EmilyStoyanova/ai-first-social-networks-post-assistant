import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SocialChannel } from "@prisma/client";
import { autoApprovePosts } from "./auto-approve-posts.service";
import type { AutoApproveDb, AutoApprovePostsDeps } from "./auto-approve-posts.service";

interface ChannelRow {
  channel: SocialChannel;
  automationModeOverride: string | null;
}

interface PostRow {
  id: string;
  channel: SocialChannel;
  safetyFlagged: boolean;
}

function makeDeps(
  channels: ChannelRow[],
  posts: PostRow[]
): {
  deps: AutoApprovePostsDeps;
  approvedIds: () => string[] | null;
  auditedIds: () => string[];
  queriedChannels: () => SocialChannel[] | null;
} {
  let approved: string[] | null = null;
  let queried: SocialChannel[] | null = null;
  const audited: string[] = [];

  const db: AutoApproveDb = {
    channelConfig: { findMany: async () => channels },
    post: {
      findMany: async (args) => {
        queried = args.where.channel.in;
        // Mirror production's filter: only pending posts on automated channels.
        return posts.filter((p) => args.where.channel.in.includes(p.channel));
      },
      updateMany: async (args) => {
        approved = args.where.id.in;
        return { count: args.where.id.in.length };
      },
    },
  };

  return {
    deps: {
      db,
      auditLog: async (entry) => {
        audited.push(entry.entityId ?? "");
      },
    },
    approvedIds: () => approved,
    auditedIds: () => audited,
    queriedChannels: () => queried,
  };
}

const FB: SocialChannel = "facebook";
const LI: SocialChannel = "linkedin";

describe("autoApprovePosts — fully_automated", () => {
  it("approves pending posts on a fully automated company", async () => {
    const { deps, approvedIds, auditedIds } = makeDeps(
      [{ channel: FB, automationModeOverride: null }],
      [{ id: "p-1", channel: FB, safetyFlagged: false }]
    );

    const summary = await autoApprovePosts("co-1", "fully_automated", deps);

    assert.equal(summary.approved, 1);
    assert.equal(summary.heldForReview, 0);
    assert.deepEqual(approvedIds(), ["p-1"]);
    assert.deepEqual(auditedIds(), ["p-1"], "an automated approval is still audited");
  });

  it("is what carries a cron-generated post past approval", async () => {
    // Generation stops at pending_approval for every mode (Variant B); this
    // step is the only thing that moves a post on without a human.
    const { deps, approvedIds } = makeDeps(
      [{ channel: FB, automationModeOverride: null }],
      [
        { id: "p-1", channel: FB, safetyFlagged: false },
        { id: "p-2", channel: FB, safetyFlagged: false },
      ]
    );

    const summary = await autoApprovePosts("co-1", "fully_automated", deps);

    assert.equal(summary.approved, 2);
    assert.deepEqual(approvedIds(), ["p-1", "p-2"]);
  });
});

describe("autoApprovePosts — semi_automated", () => {
  it("approves nothing and does not even query for posts", async () => {
    const { deps, approvedIds, queriedChannels } = makeDeps(
      [{ channel: FB, automationModeOverride: null }],
      [{ id: "p-1", channel: FB, safetyFlagged: false }]
    );

    const summary = await autoApprovePosts("co-1", "semi_automated", deps);

    assert.deepEqual(summary, { approved: 0, heldForReview: 0, channels: [] });
    assert.equal(approvedIds(), null, "no post may be updated");
    assert.equal(queriedChannels(), null, "it short-circuits before the post query");
  });
});

describe("autoApprovePosts — channel override decides", () => {
  it("a fully_automated channel on a semi_automated company is approved", async () => {
    const { deps, approvedIds } = makeDeps(
      [
        { channel: FB, automationModeOverride: "fully_automated" },
        { channel: LI, automationModeOverride: null },
      ],
      [
        { id: "fb-1", channel: FB, safetyFlagged: false },
        { id: "li-1", channel: LI, safetyFlagged: false },
      ]
    );

    const summary = await autoApprovePosts("co-1", "semi_automated", deps);

    assert.deepEqual(summary.channels, [FB]);
    assert.deepEqual(approvedIds(), ["fb-1"], "the semi_automated channel is untouched");
  });

  it("a semi_automated channel on a fully_automated company is held", async () => {
    const { deps, approvedIds } = makeDeps(
      [
        { channel: FB, automationModeOverride: "semi_automated" },
        { channel: LI, automationModeOverride: null },
      ],
      [
        { id: "fb-1", channel: FB, safetyFlagged: false },
        { id: "li-1", channel: LI, safetyFlagged: false },
      ]
    );

    const summary = await autoApprovePosts("co-1", "fully_automated", deps);

    assert.deepEqual(summary.channels, [LI]);
    assert.deepEqual(approvedIds(), ["li-1"], "the override wins over the company default");
  });
});

describe("autoApprovePosts — safety flag", () => {
  it("never approves a flagged post, even fully automated", async () => {
    const { deps, approvedIds, auditedIds } = makeDeps(
      [{ channel: FB, automationModeOverride: null }],
      [{ id: "p-1", channel: FB, safetyFlagged: true }]
    );

    const summary = await autoApprovePosts("co-1", "fully_automated", deps);

    assert.equal(summary.approved, 0);
    assert.equal(summary.heldForReview, 1);
    assert.equal(approvedIds(), null, "no update may be issued for a flagged post alone");
    assert.deepEqual(auditedIds(), []);
  });

  it("approves the clean posts and holds only the flagged one", async () => {
    const { deps, approvedIds } = makeDeps(
      [{ channel: FB, automationModeOverride: null }],
      [
        { id: "clean-1", channel: FB, safetyFlagged: false },
        { id: "flagged-1", channel: FB, safetyFlagged: true },
        { id: "clean-2", channel: FB, safetyFlagged: false },
      ]
    );

    const summary = await autoApprovePosts("co-1", "fully_automated", deps);

    assert.equal(summary.approved, 2);
    assert.equal(summary.heldForReview, 1);
    assert.deepEqual(approvedIds(), ["clean-1", "clean-2"]);
  });
});

describe("autoApprovePosts — nothing to do", () => {
  it("returns an empty summary when no channel is enabled", async () => {
    const { deps } = makeDeps([], [{ id: "p-1", channel: FB, safetyFlagged: false }]);

    assert.deepEqual(await autoApprovePosts("co-1", "fully_automated", deps), {
      approved: 0,
      heldForReview: 0,
      channels: [],
    });
  });

  it("issues no update when there are no pending posts", async () => {
    const { deps, approvedIds } = makeDeps([{ channel: FB, automationModeOverride: null }], []);

    const summary = await autoApprovePosts("co-1", "fully_automated", deps);

    assert.equal(summary.approved, 0);
    assert.equal(approvedIds(), null);
  });
});
