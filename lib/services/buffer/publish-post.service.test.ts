import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Prisma, SocialChannel } from "@prisma/client";
import { approveAndPublishPost } from "./publish-post.service";
import type { PublishPostDb, PublishPostDeps, BufferSender } from "./publish-post.service";
import { BufferApiError, BufferNoConnectionError } from "@/lib/buffer/buffer-errors";
import type { createAuditLog } from "@/lib/services/audit/audit-log.service";

const POST_ID = "post-1";
const COMPANY_ID = "company-1";
const USER_ID = "user-1";
const PROFILE_ID = "profile-1";

type AuditEntry = Parameters<typeof createAuditLog>[0];

interface PostRow {
  companyId: string;
  status: string;
  channel: SocialChannel;
  content: string;
  hashtags: string[];
  mediaAssetId: string | null;
  mediaAsset: { url: string } | null;
}

function makePost(overrides: Partial<PostRow> = {}): PostRow {
  return {
    companyId: COMPANY_ID,
    status: "draft",
    // linkedin carries no blocking media constraint, so the policy check passes
    // and each test exercises the path it is actually about.
    channel: "linkedin" as SocialChannel,
    content: "Hello world",
    hashtags: ["ai"],
    mediaAssetId: null,
    mediaAsset: null,
    ...overrides,
  };
}

interface Harness {
  deps: PublishPostDeps;
  updates: () => Prisma.PostUncheckedUpdateInput[];
  audits: () => AuditEntry[];
  sent: () => { profileIds: string[]; text: string; mediaUrl?: string }[];
}

function makeDeps(
  post: PostRow | null,
  options: {
    role?: string | null;
    /** Thrown from publishUpdate to model Buffer refusing the post. */
    bufferError?: Error;
    /** Thrown from resolving the client, e.g. no connection on file. */
    clientError?: Error;
  } = {}
): Harness {
  const updates: Prisma.PostUncheckedUpdateInput[] = [];
  const audits: AuditEntry[] = [];
  const sent: { profileIds: string[]; text: string; mediaUrl?: string }[] = [];

  const db: PublishPostDb = {
    post: {
      findUnique: async () => post,
      update: async (args) => {
        updates.push(args.data);
        return {};
      },
    },
    companyMember: {
      findFirst: async () =>
        options.role === null || options.role === undefined ? null : { role: options.role },
    },
  };

  const sender: BufferSender = {
    publishUpdate: async (profileIds, text, opts) => {
      if (options.bufferError) throw options.bufferError;
      sent.push({ profileIds, text, mediaUrl: opts?.mediaUrl });
      return { updateId: "buffer-update-1", status: "sent", publishedUrl: "https://x.test/p/1" };
    },
  };

  return {
    deps: {
      db,
      auditLog: (async (entry: AuditEntry) => {
        audits.push(entry);
      }) as typeof createAuditLog,
      bufferClient: async () => {
        if (options.clientError) throw options.clientError;
        return sender;
      },
    },
    updates: () => updates,
    audits: () => audits,
    sent: () => sent,
  };
}

// ─── Access control ──────────────────────────────────────────────────────────

describe("approveAndPublishPost — access", () => {
  it("hides a post that does not exist", async () => {
    const h = makeDeps(null);
    const result = await approveAndPublishPost(POST_ID, PROFILE_ID, USER_ID, false, h.deps);

    assert.equal(result.success, false);
    assert.equal(result.success === false && result.code, "NOT_FOUND");
  });

  it("refuses an editor, who hands off with submitForApproval instead", async () => {
    const h = makeDeps(makePost({ status: "pending_approval" }), { role: "editor" });
    const result = await approveAndPublishPost(POST_ID, PROFILE_ID, USER_ID, false, h.deps);

    assert.equal(result.success, false);
    assert.equal(result.success === false && result.code, "FORBIDDEN");
    // Nothing was approved, published, or written on the way to the refusal.
    assert.deepEqual(h.updates(), []);
    assert.deepEqual(h.sent(), []);
    assert.deepEqual(h.audits(), []);
  });

  it("treats a non-member as not finding the post at all", async () => {
    const h = makeDeps(makePost(), { role: null });
    const result = await approveAndPublishPost(POST_ID, PROFILE_ID, USER_ID, false, h.deps);

    assert.equal(result.success === false && result.code, "NOT_FOUND");
  });

  it("lets a global admin through without a membership row", async () => {
    const h = makeDeps(makePost(), { role: null });
    const result = await approveAndPublishPost(POST_ID, PROFILE_ID, USER_ID, true, h.deps);

    assert.equal(result.success, true);
  });
});

// ─── The combined owner action ───────────────────────────────────────────────

describe("approveAndPublishPost — owner draft", () => {
  it("approves and publishes a draft in one call", async () => {
    const h = makeDeps(makePost({ status: "draft" }), { role: "owner" });
    const result = await approveAndPublishPost(POST_ID, PROFILE_ID, USER_ID, false, h.deps);

    assert.equal(result.success, true);
    assert.equal(result.success === true && result.data.approved, true);

    // One write carries both halves, so the post is never observably
    // approved-but-unpublished.
    const [update] = h.updates();
    assert.equal(h.updates().length, 1);
    assert.equal(update.status, "sent_to_buffer");
    assert.equal(update.bufferUpdateId, "buffer-update-1");
    assert.equal(update.approvedById, USER_ID);
    assert.ok(update.approvedAt instanceof Date);
  });

  it("sends the content and hashtags Buffer should render", async () => {
    const h = makeDeps(
      makePost({ hashtags: ["ai", "launch"], mediaAsset: { url: "https://img.test/a.png" } }),
      { role: "owner" }
    );
    await approveAndPublishPost(POST_ID, PROFILE_ID, USER_ID, false, h.deps);

    const [call] = h.sent();
    assert.deepEqual(call.profileIds, [PROFILE_ID]);
    assert.equal(call.text, "Hello world\n\n#ai #launch");
    assert.equal(call.mediaUrl, "https://img.test/a.png");
  });

  it("logs the approval it performed as well as the publish", async () => {
    const h = makeDeps(makePost({ status: "draft" }), { role: "owner" });
    await approveAndPublishPost(POST_ID, PROFILE_ID, USER_ID, false, h.deps);

    // Traceability matches the click-by-click route the owner no longer walks.
    assert.deepEqual(
      h.audits().map((a) => a.action),
      ["POST_APPROVED", "POST_PUBLISHED"]
    );
    assert.equal(h.audits()[0].entityId, POST_ID);
    assert.equal(h.audits()[0].userId, USER_ID);
  });
});

describe("approveAndPublishPost — owner pending approval", () => {
  it("takes a post awaiting approval straight to Buffer", async () => {
    const h = makeDeps(makePost({ status: "pending_approval" }), { role: "owner" });
    const result = await approveAndPublishPost(POST_ID, PROFILE_ID, USER_ID, false, h.deps);

    assert.equal(result.success, true);
    assert.equal(result.success === true && result.data.approved, true);
    assert.equal(h.updates()[0].status, "sent_to_buffer");
    assert.equal(h.updates()[0].approvedById, USER_ID);
    assert.deepEqual(
      h.audits().map((a) => a.action),
      ["POST_APPROVED", "POST_PUBLISHED"]
    );
  });
});

describe("approveAndPublishPost — already approved", () => {
  it("publishes without re-stamping or logging a second approval", async () => {
    const h = makeDeps(makePost({ status: "approved" }), { role: "owner" });
    const result = await approveAndPublishPost(POST_ID, PROFILE_ID, USER_ID, false, h.deps);

    assert.equal(result.success, true);
    assert.equal(result.success === true && result.data.approved, false);

    const [update] = h.updates();
    assert.equal(update.status, "sent_to_buffer");
    // The original approver and timestamp must survive untouched.
    assert.equal(update.approvedById, undefined);
    assert.equal(update.approvedAt, undefined);
    assert.deepEqual(
      h.audits().map((a) => a.action),
      ["POST_PUBLISHED"]
    );
  });

  it("publishes a fully automated channel's post, approved at generation", async () => {
    // No human ever approved it — approvedById is null — and the owner should
    // still be able to send it with the same single action.
    const h = makeDeps(makePost({ status: "approved", channel: "facebook" as SocialChannel }), {
      role: "owner",
    });
    const result = await approveAndPublishPost(POST_ID, PROFILE_ID, USER_ID, false, h.deps);

    assert.equal(result.success, true);
    assert.equal(result.success === true && result.data.approved, false);
    assert.equal(h.updates()[0].status, "sent_to_buffer");
    assert.equal(h.updates()[0].approvedById, undefined);
  });

  it("refuses a rejected post, which must be resubmitted instead", async () => {
    const h = makeDeps(makePost({ status: "rejected" }), { role: "owner" });
    const result = await approveAndPublishPost(POST_ID, PROFILE_ID, USER_ID, false, h.deps);

    assert.equal(result.success === false && result.code, "INVALID_STATUS");
    assert.deepEqual(h.updates(), []);
  });

  it("refuses a post already sent to Buffer", async () => {
    const h = makeDeps(makePost({ status: "sent_to_buffer" }), { role: "owner" });
    const result = await approveAndPublishPost(POST_ID, PROFILE_ID, USER_ID, false, h.deps);

    assert.equal(result.success === false && result.code, "INVALID_STATUS");
    assert.deepEqual(h.updates(), []);
  });
});

// ─── Buffer failure leaves nothing half-done ─────────────────────────────────

describe("approveAndPublishPost — Buffer failure", () => {
  it("leaves a draft unapproved and unpublished when Buffer refuses", async () => {
    const h = makeDeps(makePost({ status: "draft" }), {
      role: "owner",
      bufferError: new BufferApiError("Buffer is down", 502),
    });
    const result = await approveAndPublishPost(POST_ID, PROFILE_ID, USER_ID, false, h.deps);

    assert.equal(result.success, false);
    assert.equal(result.success === false && result.code, "BUFFER_API_ERROR");

    // The critical invariant: no write happened, so the post keeps the status it
    // arrived with and the owner can simply try again.
    assert.deepEqual(h.updates(), []);
    // And no approval was logged for an approval that never took effect.
    assert.deepEqual(h.audits(), []);
  });

  it("leaves a pending post pending when Buffer refuses", async () => {
    const h = makeDeps(makePost({ status: "pending_approval" }), {
      role: "owner",
      bufferError: new BufferApiError("rate limited", 429),
    });
    const result = await approveAndPublishPost(POST_ID, PROFILE_ID, USER_ID, false, h.deps);

    assert.equal(result.success === false && result.code, "BUFFER_API_ERROR");
    assert.deepEqual(h.updates(), []);
    assert.deepEqual(h.audits(), []);
  });

  it("reports a missing Buffer connection without touching the post", async () => {
    const h = makeDeps(makePost(), {
      role: "owner",
      clientError: new BufferNoConnectionError(),
    });
    const result = await approveAndPublishPost(POST_ID, PROFILE_ID, USER_ID, false, h.deps);

    assert.equal(result.success === false && result.code, "NO_CONNECTION");
    assert.deepEqual(h.updates(), []);
  });
});

// ─── Publish validations still gate the combined action ──────────────────────

describe("approveAndPublishPost — policy", () => {
  it("rejects an Instagram post with no image before Buffer is called", async () => {
    const h = makeDeps(
      makePost({ status: "draft", channel: "instagram" as SocialChannel, mediaAssetId: null }),
      { role: "owner" }
    );
    const result = await approveAndPublishPost(POST_ID, PROFILE_ID, USER_ID, false, h.deps);

    assert.equal(result.success, false);
    assert.equal(result.success === false && result.code, "POLICY_VIOLATION");
    // Approval must not slip through on a post that cannot be published.
    assert.deepEqual(h.updates(), []);
    assert.deepEqual(h.sent(), []);
  });
});
