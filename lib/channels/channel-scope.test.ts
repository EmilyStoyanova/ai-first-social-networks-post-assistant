import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_CHANNELS,
  availableChannels,
  channelScopeFilter,
  channelScopeOptions,
  channelScopeSlug,
  filterPostsByChannelScope,
  matchesChannelScope,
  resolveChannelScope,
} from "./channel-scope";
import type { ChannelConfigItem } from "@/lib/services/company/list-channel-configs.service";

/** A channel config as `listChannelConfigs` returns one, in the columns that matter. */
function config(channel: string, overrides: Partial<ChannelConfigItem> = {}): ChannelConfigItem {
  return {
    id: `cfg-${channel}`,
    channel,
    bufferProfileId: `profile-${channel}`,
    bufferProfileName: `${channel} page`,
    enabled: true,
    imageRequired: false,
    includeSourceLink: false,
    autoGenerateImage: false,
    postingLanguage: null,
    postsPerDay: 1,
    postsPerWeek: 5,
    postingWindows: [],
    automationModeOverride: null,
    updatedAt: null,
    ...overrides,
  };
}

function post(channel: string, id = channel) {
  return { id, channel };
}

describe("availableChannels", () => {
  it("offers only channels that are enabled AND backed by a Buffer profile", () => {
    // The exact rule generation uses. A channel switched off in settings, or one
    // whose profile was never connected, has nothing to browse.
    const configs = [
      config("facebook"),
      config("instagram", { enabled: false }),
      config("linkedin", { bufferProfileId: null }),
    ];

    assert.deepEqual(availableChannels(configs), ["FACEBOOK"]);
  });

  it("uppercases and orders by the canonical display order, not by config order", () => {
    // Prisma hands these back lowercase and alphabetical; the app's order is
    // Facebook, LinkedIn, Instagram, TikTok (CHANNEL_ORDER).
    const configs = [config("instagram"), config("linkedin"), config("facebook")];

    assert.deepEqual(availableChannels(configs), ["FACEBOOK", "LINKEDIN", "INSTAGRAM"]);
  });

  it("collapses two profiles on the same network into one channel", () => {
    // A company with two Facebook pages holds two ChannelConfig rows. Browsing
    // is addressed by network, so that is one tab, not two.
    const configs = [
      config("facebook", { id: "cfg-a", bufferProfileId: "page-a" }),
      config("facebook", { id: "cfg-b", bufferProfileId: "page-b" }),
    ];

    assert.deepEqual(availableChannels(configs), ["FACEBOOK"]);
  });

  it("is empty for a company that has connected nothing", () => {
    assert.deepEqual(availableChannels([]), []);
  });
});

describe("channelScopeOptions", () => {
  it("always leads with All Channels", () => {
    assert.deepEqual(channelScopeOptions([config("facebook"), config("instagram")]), [
      ALL_CHANNELS,
      "FACEBOOK",
      "INSTAGRAM",
    ]);
  });

  it("offers All Channels even when the company has exactly one network", () => {
    // The area's home, and where every fallback lands — it must not appear and
    // disappear as networks are connected.
    assert.deepEqual(channelScopeOptions([config("linkedin")]), [ALL_CHANNELS, "LINKEDIN"]);
  });
});

describe("resolveChannelScope", () => {
  const available = [ALL_CHANNELS, "FACEBOOK", "INSTAGRAM"];

  it("accepts the URL's lowercase segment", () => {
    assert.equal(resolveChannelScope(available, "facebook"), "FACEBOOK");
  });

  it("accepts 'all'", () => {
    assert.equal(resolveChannelScope(available, "all"), ALL_CHANNELS);
  });

  it("falls back to All Channels for a network this company does not have", () => {
    // The stale-link case: someone's bookmark outlived the Buffer connection.
    assert.equal(resolveChannelScope(available, "linkedin"), ALL_CHANNELS);
  });

  it("falls back to All Channels for a typo, a missing segment, or an array", () => {
    assert.equal(resolveChannelScope(available, "facebok"), ALL_CHANNELS);
    assert.equal(resolveChannelScope(available, undefined), ALL_CHANNELS);
    assert.equal(resolveChannelScope(available, ["nonsense"]), ALL_CHANNELS);
  });

  it("tolerates surrounding whitespace and odd casing", () => {
    assert.equal(resolveChannelScope(available, "  FaceBook "), "FACEBOOK");
  });
});

describe("matchesChannelScope", () => {
  it("admits every channel under All Channels", () => {
    for (const channel of ["FACEBOOK", "INSTAGRAM", "LINKEDIN", "TIKTOK"]) {
      assert.equal(matchesChannelScope(channel, ALL_CHANNELS), true);
    }
  });

  it("admits only its own channel otherwise", () => {
    assert.equal(matchesChannelScope("FACEBOOK", "FACEBOOK"), true);
    assert.equal(matchesChannelScope("INSTAGRAM", "FACEBOOK"), false);
  });
});

describe("filterPostsByChannelScope", () => {
  const posts = [post("FACEBOOK", "a"), post("INSTAGRAM", "b"), post("FACEBOOK", "c")];

  it("returns every post under All Channels, in order", () => {
    assert.deepEqual(
      filterPostsByChannelScope(posts, ALL_CHANNELS).map((p) => p.id),
      ["a", "b", "c"]
    );
  });

  it("keeps only the scope's own posts", () => {
    assert.deepEqual(
      filterPostsByChannelScope(posts, "FACEBOOK").map((p) => p.id),
      ["a", "c"]
    );
  });

  it("keeps posts on a channel the company has since disconnected", () => {
    // History is history: a TikTok post that went out is still a TikTok post
    // after the profile is removed, and All Channels must still show it.
    const withRetired = [...posts, post("TIKTOK", "d")];

    assert.deepEqual(
      filterPostsByChannelScope(withRetired, ALL_CHANNELS).map((p) => p.id),
      ["a", "b", "c", "d"]
    );
  });

  it("does not mutate the input", () => {
    const original = [...posts];
    filterPostsByChannelScope(posts, ALL_CHANNELS).push(post("TIKTOK", "x"));
    assert.deepEqual(posts, original);
  });
});

describe("channelScopeSlug / channelScopeFilter", () => {
  it("renders a scope as its URL segment", () => {
    assert.equal(channelScopeSlug(ALL_CHANNELS), "all");
    assert.equal(channelScopeSlug("FACEBOOK"), "facebook");
  });

  it("turns a scope into a Prisma value, or null for 'do not narrow'", () => {
    // Null rather than a list of four: All Channels is the ABSENCE of a
    // constraint, so connecting a fifth network needs no query change.
    assert.equal(channelScopeFilter(ALL_CHANNELS), null);
    assert.equal(channelScopeFilter("INSTAGRAM"), "instagram");
  });
});
