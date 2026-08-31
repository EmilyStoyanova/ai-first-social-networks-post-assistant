import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Prisma, SocialChannel } from "@prisma/client";
import { approveAndPublishPost } from "./publish-post.service";
import type {
  PublishPostDb,
  PublishPostDeps,
  BufferSender,
  TargetProfile,
} from "./publish-post.service";
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
  scheduledFor: Date | null;
  manuallyScheduled: boolean;
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
    // Unscheduled and not from a bulk run — the plain "publish this now" case
    // every test below is about unless it says otherwise.
    scheduledFor: null,
    manuallyScheduled: false,
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
    /** Pins the clock the due-check reads. */
    now?: Date;
    /**
     * What Buffer reports as connected. Defaults to ONE profile, on the post's
     * own network — the correctly-paired case every test is about unless it says
     * otherwise.
     */
    profiles?: TargetProfile[];
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

  const profiles: TargetProfile[] = options.profiles ?? [
    { id: PROFILE_ID, name: "Target profile", service: post?.channel ?? "linkedin" },
  ];

  const sender: BufferSender = {
    getProfiles: async () => profiles,
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
      now: () => options.now ?? new Date(),
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

  it("refuses an editor — approving is theirs now, publishing never is", async () => {
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

// ─── The target profile's social network ─────────────────────────────────────
// A post may only go to a profile on its OWN network. The selector filters the
// list it offers, but `profileId` arrives from the browser, so the refusal has
// to live here — the API is reachable without the picker.

const FB_PAGE: TargetProfile = { id: "fb-1", name: "Acme Page", service: "facebook" };
const FB_PAGE_2: TargetProfile = { id: "fb-2", name: "Acme Support", service: "facebook" };
const IG_ACCOUNT: TargetProfile = { id: "ig-1", name: "@acme", service: "instagram-business" };

/** Instagram blocks a post with no image (v2-3), so its posts carry one here. */
const IG_MEDIA = { mediaAssetId: "media-1", mediaAsset: { url: "https://img.test/a.png" } };

describe("approveAndPublishPost — profile must match the post's channel", () => {
  it("publishes a Facebook post to a Facebook profile", async () => {
    const h = makeDeps(makePost({ channel: "facebook" as SocialChannel }), {
      role: "owner",
      profiles: [FB_PAGE, IG_ACCOUNT],
    });

    const result = await approveAndPublishPost(POST_ID, FB_PAGE.id, USER_ID, false, h.deps);

    assert.equal(result.success, true);
    assert.deepEqual(h.sent()[0].profileIds, [FB_PAGE.id]);
  });

  it("refuses a Facebook post aimed at an Instagram profile", async () => {
    const h = makeDeps(makePost({ channel: "facebook" as SocialChannel }), {
      role: "owner",
      profiles: [FB_PAGE, IG_ACCOUNT],
    });

    const result = await approveAndPublishPost(POST_ID, IG_ACCOUNT.id, USER_ID, false, h.deps);

    assert.equal(result.success, false);
    assert.equal(result.success === false && result.code, "CHANNEL_MISMATCH");
    // Buffer was never called and nothing was written, so the post is unharmed.
    assert.deepEqual(h.sent(), []);
    assert.deepEqual(h.updates(), []);
    assert.deepEqual(h.audits(), []);
  });

  it("publishes an Instagram post to an Instagram profile", async () => {
    const h = makeDeps(makePost({ channel: "instagram" as SocialChannel, ...IG_MEDIA }), {
      role: "owner",
      profiles: [FB_PAGE, IG_ACCOUNT],
    });

    const result = await approveAndPublishPost(POST_ID, IG_ACCOUNT.id, USER_ID, false, h.deps);

    assert.equal(result.success, true);
    assert.deepEqual(h.sent()[0].profileIds, [IG_ACCOUNT.id]);
  });

  it("refuses an Instagram post aimed at a Facebook profile", async () => {
    const h = makeDeps(makePost({ channel: "instagram" as SocialChannel, ...IG_MEDIA }), {
      role: "owner",
      profiles: [FB_PAGE, IG_ACCOUNT],
    });

    const result = await approveAndPublishPost(POST_ID, FB_PAGE.id, USER_ID, false, h.deps);

    assert.equal(result.success === false && result.code, "CHANNEL_MISMATCH");
    assert.deepEqual(h.sent(), []);
    assert.deepEqual(h.updates(), []);
  });

  it("names both networks and the profile, so the owner can see the mix-up", async () => {
    const h = makeDeps(makePost({ channel: "facebook" as SocialChannel }), {
      role: "owner",
      profiles: [IG_ACCOUNT],
    });

    const result = await approveAndPublishPost(POST_ID, IG_ACCOUNT.id, USER_ID, false, h.deps);

    const message = result.success === false ? (result.message ?? "") : "";
    assert.match(message, /FACEBOOK/);
    assert.match(message, /INSTAGRAM/);
    assert.match(message, /@acme/);
  });

  it("lets either of two Facebook pages take the post", async () => {
    // Several profiles on one network is the case the selector must offer in
    // full; both must therefore be publishable.
    for (const page of [FB_PAGE, FB_PAGE_2]) {
      const h = makeDeps(makePost({ channel: "facebook" as SocialChannel }), {
        role: "owner",
        profiles: [FB_PAGE, FB_PAGE_2, IG_ACCOUNT],
      });

      const result = await approveAndPublishPost(POST_ID, page.id, USER_ID, false, h.deps);

      assert.equal(result.success, true, `${page.name} should be publishable`);
      assert.deepEqual(h.sent()[0].profileIds, [page.id]);
    }
  });

  it("reads the account TYPE Buffer reports, not just the bare service name", async () => {
    // instagram-business / instagram-creator are Instagram. Comparing Buffer's
    // raw service string with Post.channel would reject a real account.
    for (const service of ["instagram", "instagram-business", "instagram-creator"]) {
      const h = makeDeps(makePost({ channel: "instagram" as SocialChannel, ...IG_MEDIA }), {
        role: "owner",
        profiles: [{ id: "ig-x", name: "@acme", service }],
      });

      const result = await approveAndPublishPost(POST_ID, "ig-x", USER_ID, false, h.deps);

      assert.equal(result.success, true, `${service} should count as Instagram`);
    }
  });

  it("refuses a network this app cannot place, rather than trying it", async () => {
    const h = makeDeps(makePost({ channel: "facebook" as SocialChannel }), {
      role: "owner",
      profiles: [{ id: "other-1", name: "Acme", service: "mastodon" }],
    });

    const result = await approveAndPublishPost(POST_ID, "other-1", USER_ID, false, h.deps);

    assert.equal(result.success === false && result.code, "CHANNEL_MISMATCH");
    assert.deepEqual(h.sent(), []);
  });

  it("reports a profile Buffer does not know as INVALID_PROFILE", async () => {
    const h = makeDeps(makePost({ channel: "facebook" as SocialChannel }), {
      role: "owner",
      profiles: [FB_PAGE],
    });

    const result = await approveAndPublishPost(POST_ID, "not-connected", USER_ID, false, h.deps);

    assert.equal(result.success === false && result.code, "INVALID_PROFILE");
    assert.deepEqual(h.sent(), []);
    assert.deepEqual(h.updates(), []);
  });

  it("checks the schedule before the profile — a NOT_DUE post is refused as NOT_DUE", async () => {
    // Ordering matters for the message the card shows: the timing is the more
    // useful complaint, and it needs no Buffer call to make.
    const h = makeDeps(
      makePost({
        channel: "facebook" as SocialChannel,
        status: "pending_approval",
        scheduledFor: new Date("2026-08-12T09:00:00.000Z"),
        manuallyScheduled: true,
      }),
      {
        role: "owner",
        now: new Date("2026-08-12T08:48:00.000Z"),
        profiles: [IG_ACCOUNT],
      }
    );

    const result = await approveAndPublishPost(POST_ID, IG_ACCOUNT.id, USER_ID, false, h.deps);

    assert.equal(result.success === false && result.code, "NOT_DUE");
  });
});

// ─── The schedule a person set ───────────────────────────────────────────────
// Reported from manual testing: a bulk post scheduled for 12:00 Europe/Sofia was
// approved at 11:48 and went to Buffer immediately. Approving is not publishing;
// only the sweep may send a manually scheduled post, and only once it is due.

const SOFIA_NOON = new Date("2026-08-12T09:00:00.000Z"); // 12:00 Europe/Sofia (UTC+3)

describe("approveAndPublishPost — manually scheduled", () => {
  it("does not send a future-scheduled bulk post approved 12 minutes early", async () => {
    const h = makeDeps(
      makePost({
        status: "pending_approval",
        scheduledFor: SOFIA_NOON,
        manuallyScheduled: true,
      }),
      { role: "owner", now: new Date("2026-08-12T08:48:00.000Z") } // 11:48 Sofia
    );

    const result = await approveAndPublishPost(POST_ID, PROFILE_ID, USER_ID, false, h.deps);

    assert.equal(result.success, false);
    assert.equal(result.success === false && result.code, "NOT_DUE");
    // The whole point: Buffer was never called.
    assert.deepEqual(h.sent(), []);
    // And nothing was written — no approval, no publish, no partial state.
    assert.deepEqual(h.updates(), []);
    assert.deepEqual(h.audits(), []);
  });

  it("refuses one second early, because early is early", async () => {
    const h = makeDeps(
      makePost({
        status: "pending_approval",
        scheduledFor: SOFIA_NOON,
        manuallyScheduled: true,
      }),
      { role: "owner", now: new Date(SOFIA_NOON.getTime() - 1000) }
    );

    const result = await approveAndPublishPost(POST_ID, PROFILE_ID, USER_ID, false, h.deps);

    assert.equal(result.success === false && result.code, "NOT_DUE");
    assert.deepEqual(h.sent(), []);
  });

  it("refuses a global admin too — the schedule is not a permission", async () => {
    const h = makeDeps(
      makePost({
        status: "pending_approval",
        scheduledFor: SOFIA_NOON,
        manuallyScheduled: true,
      }),
      { now: new Date("2026-08-12T08:48:00.000Z") }
    );

    const result = await approveAndPublishPost(POST_ID, PROFILE_ID, USER_ID, true, h.deps);

    assert.equal(result.success === false && result.code, "NOT_DUE");
    assert.deepEqual(h.sent(), []);
  });

  it("refuses an already-approved post whose time is still ahead", async () => {
    // The state the fixed flow leaves a post in: approved, waiting for the sweep.
    const h = makeDeps(
      makePost({ status: "approved", scheduledFor: SOFIA_NOON, manuallyScheduled: true }),
      { role: "owner", now: new Date("2026-08-12T08:48:00.000Z") }
    );

    const result = await approveAndPublishPost(POST_ID, PROFILE_ID, USER_ID, false, h.deps);

    assert.equal(result.success === false && result.code, "NOT_DUE");
    assert.deepEqual(h.sent(), []);
    assert.deepEqual(h.updates(), []);
  });

  it("names the scheduled time in the refusal, so the card can explain itself", async () => {
    const h = makeDeps(
      makePost({
        status: "pending_approval",
        scheduledFor: SOFIA_NOON,
        manuallyScheduled: true,
      }),
      { role: "owner", now: new Date("2026-08-12T08:48:00.000Z") }
    );

    const result = await approveAndPublishPost(POST_ID, PROFILE_ID, USER_ID, false, h.deps);

    assert.equal(result.success, false);
    assert.match(
      result.success === false ? (result.message ?? "") : "",
      /2026-08-12T09:00:00\.000Z/
    );
  });

  it("refuses it exactly on time too — the sweep is what sends it", async () => {
    const h = makeDeps(
      makePost({ status: "approved", scheduledFor: SOFIA_NOON, manuallyScheduled: true }),
      { role: "owner", now: SOFIA_NOON }
    );

    const result = await approveAndPublishPost(POST_ID, PROFILE_ID, USER_ID, false, h.deps);

    assert.equal(result.success === false && result.code, "NOT_DUE");
    assert.deepEqual(h.sent(), []);
    assert.deepEqual(h.updates(), []);
  });

  it("refuses one that is overdue but still inside the sweep's grace window", async () => {
    // The reported confusion, and the bypass this closes: a 12:00 post approved
    // at 12:04 used to go out at 12:04 by hand, because it had technically become
    // due. The sweep still delivers it — see publishScheduledPosts — but the card
    // does not, because nobody asked for a publish, only for an approval.
    const h = makeDeps(
      makePost({ status: "pending_approval", scheduledFor: SOFIA_NOON, manuallyScheduled: true }),
      { role: "owner", now: new Date(SOFIA_NOON.getTime() + 4 * 60 * 1000) }
    );

    const result = await approveAndPublishPost(POST_ID, PROFILE_ID, USER_ID, false, h.deps);

    assert.equal(result.success === false && result.code, "NOT_DUE");
    assert.deepEqual(h.sent(), []);
    // Nothing at all was written, so the post is still approvable through the
    // plain approve route and still carries the time it was given.
    assert.deepEqual(h.updates(), []);
    assert.deepEqual(h.audits(), []);
  });

  it("refuses a manual post whose slot is long gone — a reschedule is its way out", async () => {
    // The sweep parks these rather than firing them late. Recovery moved from
    // "publish it by hand" to "give it a new time", which the card's schedule
    // panel offers; publishing it here would be the same unasked-for immediate
    // send, just later.
    const h = makeDeps(
      makePost({ status: "approved", scheduledFor: SOFIA_NOON, manuallyScheduled: true }),
      { role: "owner", now: new Date("2026-08-14T09:00:00.000Z") }
    );

    const result = await approveAndPublishPost(POST_ID, PROFILE_ID, USER_ID, false, h.deps);

    assert.equal(result.success === false && result.code, "NOT_DUE");
    assert.deepEqual(h.sent(), []);
  });

  it("names the schedule in the refusal without claiming the time is still ahead", async () => {
    // The message is shown for an overdue post as well now, so it must not say
    // the post "cannot be published before then".
    const h = makeDeps(
      makePost({ status: "approved", scheduledFor: SOFIA_NOON, manuallyScheduled: true }),
      { role: "owner", now: new Date(SOFIA_NOON.getTime() + 4 * 60 * 1000) }
    );

    const result = await approveAndPublishPost(POST_ID, PROFILE_ID, USER_ID, false, h.deps);
    const message = result.success === false ? (result.message ?? "") : "";

    assert.match(message, /2026-08-12T09:00:00\.000Z/);
    assert.doesNotMatch(message, /before then/);
  });
});

describe("approveAndPublishPost — schedules the gate must not touch", () => {
  it("publishes an unscheduled draft on demand, as it always has", async () => {
    const h = makeDeps(makePost({ status: "draft" }), { role: "owner" });
    const result = await approveAndPublishPost(POST_ID, PROFILE_ID, USER_ID, false, h.deps);

    assert.equal(result.success, true);
    assert.equal(h.sent().length, 1);
  });

  it("publishes an automatic cron post early, keeping its look-ahead", async () => {
    // manuallyScheduled === false means the weekly filler picked the time as an
    // estimate. That behaviour is deliberately unchanged.
    const h = makeDeps(
      makePost({ status: "approved", scheduledFor: SOFIA_NOON, manuallyScheduled: false }),
      { role: "owner", now: new Date("2026-08-12T08:48:00.000Z") }
    );

    const result = await approveAndPublishPost(POST_ID, PROFILE_ID, USER_ID, false, h.deps);

    assert.equal(result.success, true);
    assert.equal(h.sent().length, 1);
  });

  it("keeps scheduledFor and manuallyScheduled out of the update it writes", async () => {
    // Exercised on an automatic post because a hand-scheduled one no longer
    // reaches this write at all. The invariant is unchanged: publishing records
    // delivery and never rewrites the time or whose time it was.
    const h = makeDeps(
      makePost({ status: "approved", scheduledFor: SOFIA_NOON, manuallyScheduled: false }),
      { role: "owner", now: SOFIA_NOON }
    );

    await approveAndPublishPost(POST_ID, PROFILE_ID, USER_ID, false, h.deps);

    assert.equal(h.updates().length, 1);
    assert.equal("manuallyScheduled" in h.updates()[0], false);
    assert.equal("scheduledFor" in h.updates()[0], false);
  });

  it("publishes an automatic post scheduled days out", async () => {
    const h = makeDeps(
      makePost({ status: "approved", scheduledFor: SOFIA_NOON, manuallyScheduled: false }),
      { role: "owner", now: new Date("2026-08-01T09:00:00.000Z") }
    );

    const result = await approveAndPublishPost(POST_ID, PROFILE_ID, USER_ID, false, h.deps);

    assert.equal(result.success, true);
    assert.equal(h.sent().length, 1);
  });

  it("checks access before the schedule — an editor is refused as an editor", async () => {
    const h = makeDeps(
      makePost({
        status: "pending_approval",
        scheduledFor: SOFIA_NOON,
        manuallyScheduled: true,
      }),
      { role: "editor", now: new Date("2026-08-12T08:48:00.000Z") }
    );

    const result = await approveAndPublishPost(POST_ID, PROFILE_ID, USER_ID, false, h.deps);

    assert.equal(result.success === false && result.code, "FORBIDDEN");
    assert.deepEqual(h.sent(), []);
  });

  it("checks status before the schedule — a rejected post is INVALID_STATUS", async () => {
    const h = makeDeps(
      makePost({ status: "rejected", scheduledFor: SOFIA_NOON, manuallyScheduled: true }),
      { role: "owner", now: new Date("2026-08-12T08:48:00.000Z") }
    );

    const result = await approveAndPublishPost(POST_ID, PROFILE_ID, USER_ID, false, h.deps);

    assert.equal(result.success === false && result.code, "INVALID_STATUS");
    assert.deepEqual(h.sent(), []);
  });
});
