import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SocialChannel } from "@prisma/client";
import { sendPostToBuffer, type SendablePost } from "./_send-post";
import type { BufferClient } from "@/lib/buffer/buffer-client";

/**
 * The cron half of the channel invariant.
 *
 * `approveAndPublishPost` has refused a cross-network pairing since 2026-08-17,
 * but the SWEEP never did: it addressed posts through a map built from our own
 * `ChannelConfig.channel`, and that column is a copy of what profile sync last
 * saw. `sendPostToBuffer` is the single choke point both the scheduled sweep and
 * the retry step funnel through, so the guard belongs here — a caller that built
 * its own pairing still cannot slip one past it.
 *
 * The assertion that matters in every rejection case is `sent.length === 0`:
 * publishing to the wrong network cannot be undone, so "refused" has to mean
 * Buffer was never called, not that we noticed afterwards.
 */

const PROFILES = [
  { id: "fb-1", name: "Care Tech", service: "facebook" },
  { id: "ig-1", name: "caretech.bg", service: "instagram-business" },
];

function post(channel: SocialChannel, overrides: Partial<SendablePost> = {}): SendablePost {
  return {
    id: `post-${channel}`,
    channel,
    content: "Hello",
    hashtags: [],
    // Instagram cannot publish without one (v2-3 policy), and the policy check
    // runs first — an Instagram fixture without media would fail for the wrong
    // reason and prove nothing about the channel guard.
    mediaAssetId: "media-1",
    mediaAsset: { url: "https://example.test/a.jpg" },
    ...overrides,
  };
}

/** Records what actually reached Buffer. */
function fakeClient() {
  const sent: Array<{ profileIds: string[]; text: string }> = [];
  const client = {
    publishUpdate: async (profileIds: string[], text: string) => {
      sent.push({ profileIds, text });
      return { updateId: "buffer-1", status: "sent", publishedUrl: null };
    },
  } as unknown as BufferClient;
  return { client, sent };
}

describe("sendPostToBuffer — the profile must be on the post's own network", () => {
  it("publishes a Facebook post to a Facebook profile", async () => {
    const { client, sent } = fakeClient();

    const outcome = await sendPostToBuffer(client, post("facebook"), "fb-1", PROFILES);

    assert.equal(outcome.ok, true);
    assert.equal(outcome.ok === true && outcome.updateId, "buffer-1");
    assert.deepEqual(sent[0]?.profileIds, ["fb-1"]);
  });

  it("publishes an Instagram post to an Instagram profile", async () => {
    const { client, sent } = fakeClient();

    const outcome = await sendPostToBuffer(client, post("instagram"), "ig-1", PROFILES);

    assert.equal(outcome.ok, true);
    assert.deepEqual(sent[0]?.profileIds, ["ig-1"]);
  });

  it("refuses a Facebook post addressed to an Instagram profile", async () => {
    const { client, sent } = fakeClient();

    const outcome = await sendPostToBuffer(client, post("facebook"), "ig-1", PROFILES);

    assert.equal(outcome.ok, false);
    assert.equal(sent.length, 0, "Buffer must not be called at all");
    assert.match(outcome.ok === false ? outcome.message : "", /FACEBOOK post/);
  });

  it("refuses an Instagram post addressed to a Facebook profile", async () => {
    // The pairing found in live data: care-tech's 2026-08-14 post is stored
    // `instagram` and carries `channelService = facebook`.
    const { client, sent } = fakeClient();

    const outcome = await sendPostToBuffer(client, post("instagram"), "fb-1", PROFILES);

    assert.equal(outcome.ok, false);
    assert.equal(sent.length, 0, "Buffer must not be called at all");
    assert.match(outcome.ok === false ? outcome.message : "", /INSTAGRAM post/);
  });

  it("refuses a profile Buffer does not list", async () => {
    const { client, sent } = fakeClient();

    const outcome = await sendPostToBuffer(client, post("facebook"), "gone", PROFILES);

    assert.equal(outcome.ok, false);
    assert.equal(sent.length, 0);
  });

  it("does not burn the retry budget on a mismatch — it is a plain failure", async () => {
    // tokenExpired is what aborts a whole run; a mismatch affects ONE post and
    // must not stop the sweep from delivering the rest.
    const { client } = fakeClient();

    const outcome = await sendPostToBuffer(client, post("facebook"), "ig-1", PROFILES);

    assert.equal(outcome.ok === false && outcome.tokenExpired, false);
  });

  it("still rejects a policy violation before it looks at the profile", async () => {
    // Ordering is deliberate: an Instagram post with no image is wrong whatever
    // profile it was addressed to, and that message is the more useful one.
    const { client, sent } = fakeClient();

    const outcome = await sendPostToBuffer(
      client,
      post("instagram", { mediaAssetId: null, mediaAsset: null }),
      "ig-1",
      PROFILES
    );

    assert.equal(outcome.ok, false);
    assert.equal(sent.length, 0);
    assert.match(outcome.ok === false ? outcome.message : "", /image/i);
  });
});
