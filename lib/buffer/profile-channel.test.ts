import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bufferServiceToChannel, filterProfilesByChannel } from "./profile-channel";

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
