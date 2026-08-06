import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PERFORMANCE_CHANNEL_PARAM,
  buildPerformanceChannelQuery,
  channelLabel,
  eligiblePerformanceChannels,
  normalizeChannel,
  resolvePerformanceChannel,
} from "./performance-channels";

describe("eligiblePerformanceChannels", () => {
  it("keeps only channels that are both Buffer-connected and have published", () => {
    const eligible = eligiblePerformanceChannels({
      bufferConnected: ["facebook", "instagram", "linkedin"],
      withPublishedPosts: ["facebook", "linkedin", "tiktok"],
    });

    assert.deepEqual(eligible, ["FACEBOOK", "LINKEDIN"]);
  });

  it("drops a connected channel that has never published", () => {
    const eligible = eligiblePerformanceChannels({
      bufferConnected: ["facebook", "tiktok"],
      withPublishedPosts: ["facebook"],
    });

    assert.deepEqual(eligible, ["FACEBOOK"]);
  });

  it("drops a published channel that is no longer connected to Buffer", () => {
    // Metrics for the disconnected channel may still exist; the panel cannot
    // promise to keep them current, so it stops offering the channel.
    const eligible = eligiblePerformanceChannels({
      bufferConnected: ["instagram"],
      withPublishedPosts: ["instagram", "facebook"],
    });

    assert.deepEqual(eligible, ["INSTAGRAM"]);
  });

  it("returns nothing when the two sets do not overlap", () => {
    assert.deepEqual(
      eligiblePerformanceChannels({
        bufferConnected: ["facebook"],
        withPublishedPosts: ["linkedin"],
      }),
      []
    );
  });

  it("returns nothing for a company with no channels at all", () => {
    assert.deepEqual(
      eligiblePerformanceChannels({ bufferConnected: [], withPublishedPosts: [] }),
      []
    );
  });

  it("normalizes casing from both sides before comparing", () => {
    // Prisma enums arrive lowercase; Buffer uses its own casing.
    const eligible = eligiblePerformanceChannels({
      bufferConnected: ["facebook", " Instagram "],
      withPublishedPosts: ["FACEBOOK", "instagram"],
    });

    assert.deepEqual(eligible, ["FACEBOOK", "INSTAGRAM"]);
  });

  it("de-duplicates channels configured against more than one Buffer profile", () => {
    const eligible = eligiblePerformanceChannels({
      bufferConnected: ["facebook", "facebook"],
      withPublishedPosts: ["facebook"],
    });

    assert.deepEqual(eligible, ["FACEBOOK"]);
  });

  it("orders alphabetically so options do not move as posts are published", () => {
    const eligible = eligiblePerformanceChannels({
      bufferConnected: ["tiktok", "facebook", "linkedin", "instagram"],
      withPublishedPosts: ["tiktok", "facebook", "linkedin", "instagram"],
    });

    assert.deepEqual(eligible, ["FACEBOOK", "INSTAGRAM", "LINKEDIN", "TIKTOK"]);
  });
});

describe("resolvePerformanceChannel", () => {
  const eligible = ["FACEBOOK", "INSTAGRAM"];

  it("honours a requested channel that is eligible", () => {
    assert.equal(resolvePerformanceChannel(eligible, "instagram"), "INSTAGRAM");
  });

  it("falls back to the first eligible channel when none was requested", () => {
    assert.equal(resolvePerformanceChannel(eligible, undefined), "FACEBOOK");
  });

  it("falls back when the requested channel is no longer eligible", () => {
    // A bookmark outliving a Buffer disconnection must still land on data.
    assert.equal(resolvePerformanceChannel(eligible, "TIKTOK"), "FACEBOOK");
  });

  it("reads the first value of a repeated query parameter", () => {
    assert.equal(resolvePerformanceChannel(eligible, ["instagram", "facebook"]), "INSTAGRAM");
  });

  it("answers null when nothing is eligible", () => {
    assert.equal(resolvePerformanceChannel([], "facebook"), null);
  });
});

describe("buildPerformanceChannelQuery", () => {
  it("sets the channel parameter", () => {
    const query = buildPerformanceChannelQuery("", "instagram");
    assert.equal(new URLSearchParams(query).get(PERFORMANCE_CHANNEL_PARAM), "INSTAGRAM");
  });

  it("preserves parameters that belong to other controls", () => {
    const query = buildPerformanceChannelQuery("status=published&page=2", "facebook");
    const params = new URLSearchParams(query);

    assert.equal(params.get("status"), "published");
    assert.equal(params.get("page"), "2");
    assert.equal(params.get(PERFORMANCE_CHANNEL_PARAM), "FACEBOOK");
  });

  it("replaces an existing channel rather than appending a second one", () => {
    const query = buildPerformanceChannelQuery("channel=FACEBOOK", "linkedin");
    assert.deepEqual(new URLSearchParams(query).getAll(PERFORMANCE_CHANNEL_PARAM), ["LINKEDIN"]);
  });
});

describe("channelLabel", () => {
  it("uses each network's own capitalisation", () => {
    assert.equal(channelLabel("linkedin"), "LinkedIn");
    assert.equal(channelLabel("TIKTOK"), "TikTok");
    assert.equal(channelLabel("facebook"), "Facebook");
    assert.equal(channelLabel("instagram"), "Instagram");
  });

  it("shows an unknown channel as given rather than hiding it", () => {
    assert.equal(channelLabel("mastodon"), "mastodon");
  });
});

describe("normalizeChannel", () => {
  it("upper-cases and trims", () => {
    assert.equal(normalizeChannel(" facebook "), "FACEBOOK");
  });
});
