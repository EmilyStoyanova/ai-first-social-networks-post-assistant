import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bufferServiceToChannel,
  checkProfileChannel,
  filterProfilesByChannel,
} from "./profile-channel";

describe("bufferServiceToChannel", () => {
  it("places the plain service strings", () => {
    assert.equal(bufferServiceToChannel("facebook"), "facebook");
    assert.equal(bufferServiceToChannel("instagram"), "instagram");
    assert.equal(bufferServiceToChannel("linkedin"), "linkedin");
    assert.equal(bufferServiceToChannel("tiktok"), "tiktok");
  });

  it("places the account-type variants Buffer actually reports", () => {
    // A business Instagram account is still Instagram — the whole reason the
    // service string cannot be compared with Post.channel directly.
    assert.equal(bufferServiceToChannel("instagram-business"), "instagram");
    assert.equal(bufferServiceToChannel("instagram-creator"), "instagram");
    assert.equal(bufferServiceToChannel("facebook-group"), "facebook");
    assert.equal(bufferServiceToChannel("linkedin-company"), "linkedin");
    assert.equal(bufferServiceToChannel("linkedin-page"), "linkedin");
  });

  it("normalises case and spacing", () => {
    assert.equal(bufferServiceToChannel("Instagram Business"), "instagram");
    assert.equal(bufferServiceToChannel("FACEBOOK"), "facebook");
  });

  it("refuses a service it cannot place, rather than guessing", () => {
    // Null is what makes an unknown profile ineligible for every channel.
    assert.equal(bufferServiceToChannel("mastodon"), null);
    assert.equal(bufferServiceToChannel(""), null);
  });
});

interface Item {
  id: string;
  channel: string;
}

const PROFILES: Item[] = [
  { id: "fb-1", channel: "FACEBOOK" },
  { id: "ig-1", channel: "INSTAGRAM" },
  { id: "fb-2", channel: "FACEBOOK" },
  { id: "li-1", channel: "LINKEDIN" },
];

describe("filterProfilesByChannel", () => {
  it("keeps EVERY profile on the requested network, in order", () => {
    // A company with two Facebook pages must still choose which page.
    assert.deepEqual(
      filterProfilesByChannel(PROFILES, "FACEBOOK").map((p) => p.id),
      ["fb-1", "fb-2"]
    );
  });

  it("drops the other networks", () => {
    assert.deepEqual(
      filterProfilesByChannel(PROFILES, "INSTAGRAM").map((p) => p.id),
      ["ig-1"]
    );
    assert.deepEqual(
      filterProfilesByChannel(PROFILES, "LINKEDIN").map((p) => p.id),
      ["li-1"]
    );
  });

  it("matches whichever case the channel arrives in", () => {
    // Uppercase through the API, lowercase through Prisma.
    assert.deepEqual(
      filterProfilesByChannel(PROFILES, "facebook").map((p) => p.id),
      ["fb-1", "fb-2"]
    );
  });

  it("returns nothing when the network has no connected profile", () => {
    assert.deepEqual(filterProfilesByChannel(PROFILES, "TIKTOK"), []);
  });
});

/**
 * The invariant: a post only ever goes out on its OWN social network.
 *
 * Judged from the service Buffer reports for the target profile, because our own
 * `ChannelConfig.channel` is a stale-able copy — care-tech's 2026-08-14 post is
 * stored `instagram` and was delivered to a Facebook page, and no check reading
 * our column could have seen it. Both publish paths (the manual action and the
 * cron sender) call this, so neither can permit what the other refuses.
 */
const BUFFER_PROFILES = [
  { id: "fb-1", name: "Care Tech", service: "facebook" },
  { id: "ig-1", name: "caretech.bg", service: "instagram-business" },
  { id: "li-1", name: "Edamame.Digital", service: "linkedin-company" },
  { id: "xx-1", name: "Somewhere Else", service: "mastodon" },
];

describe("checkProfileChannel", () => {
  it("allows a Facebook post on a Facebook profile", () => {
    assert.deepEqual(checkProfileChannel(BUFFER_PROFILES, "fb-1", "facebook"), { ok: true });
  });

  it("allows an Instagram post on an Instagram profile", () => {
    // instagram-business, not "instagram" — the account-type variant is exactly
    // the case a raw string comparison would have refused.
    assert.deepEqual(checkProfileChannel(BUFFER_PROFILES, "ig-1", "instagram"), { ok: true });
  });

  it("allows a LinkedIn post on a LinkedIn company page", () => {
    assert.deepEqual(checkProfileChannel(BUFFER_PROFILES, "li-1", "linkedin"), { ok: true });
  });

  it("rejects a Facebook post addressed to an Instagram profile", () => {
    const result = checkProfileChannel(BUFFER_PROFILES, "ig-1", "facebook");
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, "CHANNEL_MISMATCH");
    // The message names both networks and the profile, so the owner can act on it.
    assert.match(result.ok === false ? result.message : "", /FACEBOOK post/);
    assert.match(result.ok === false ? result.message : "", /INSTAGRAM profile/);
    assert.match(result.ok === false ? result.message : "", /caretech\.bg/);
  });

  it("rejects an Instagram post addressed to a Facebook profile", () => {
    // The mismatch actually found in production, in its original direction.
    const result = checkProfileChannel(BUFFER_PROFILES, "fb-1", "instagram");
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, "CHANNEL_MISMATCH");
    assert.match(result.ok === false ? result.message : "", /INSTAGRAM post/);
    assert.match(result.ok === false ? result.message : "", /FACEBOOK profile/);
  });

  it("matches whichever case the channel arrives in", () => {
    // Uppercase through the API, lowercase through Prisma — one helper, both.
    assert.deepEqual(checkProfileChannel(BUFFER_PROFILES, "fb-1", "FACEBOOK"), { ok: true });
  });

  it("refuses a profile whose service it cannot place, rather than guessing", () => {
    const result = checkProfileChannel(BUFFER_PROFILES, "xx-1", "facebook");
    assert.equal(result.ok === false && result.code, "CHANNEL_MISMATCH");
  });

  it("reports a profile Buffer does not list at all", () => {
    // Distinct from a mismatch: the profile is gone or belongs to another
    // account, which is a different thing for the caller to say.
    const result = checkProfileChannel(BUFFER_PROFILES, "ghost", "facebook");
    assert.equal(result.ok === false && result.code, "UNKNOWN_PROFILE");
  });
});
