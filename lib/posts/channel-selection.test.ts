import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  channelLabel,
  channelSortIndex,
  isAllChannelsSelected,
  normalizeChannelSelection,
  sortByChannel,
  toChannelPayload,
  toggleAllChannels,
  toggleChannelSelection,
} from "./channel-selection";

/** What a fully connected company offers, in the canonical display order. */
const ALL = ["FACEBOOK", "LINKEDIN", "INSTAGRAM", "TIKTOK"];

describe("channelLabel / channelSortIndex", () => {
  it("names the four channels", () => {
    assert.equal(channelLabel("FACEBOOK"), "Facebook");
    assert.equal(channelLabel("linkedin"), "LinkedIn");
    assert.equal(channelLabel("INSTAGRAM"), "Instagram");
    assert.equal(channelLabel("TIKTOK"), "TikTok");
  });

  it("renders an unknown channel as itself rather than as a blank", () => {
    // A channel the server knows about before the client does should read as
    // something, not as an empty badge.
    assert.equal(channelLabel("THREADS"), "THREADS");
  });

  it("sorts unknown channels after the known ones", () => {
    assert.ok(channelSortIndex("THREADS") > channelSortIndex("TIKTOK"));
  });

  it("orders items into the canonical display order", () => {
    const items = [{ c: "TIKTOK" }, { c: "FACEBOOK" }, { c: "INSTAGRAM" }, { c: "LINKEDIN" }];
    assert.deepEqual(
      sortByChannel(items, (i) => i.c).map((i) => i.c),
      ALL
    );
  });

  it("does not mutate the array it was given", () => {
    const items = [{ c: "TIKTOK" }, { c: "FACEBOOK" }];
    sortByChannel(items, (i) => i.c);
    assert.deepEqual(
      items.map((i) => i.c),
      ["TIKTOK", "FACEBOOK"]
    );
  });
});

describe("normalizeChannelSelection", () => {
  it("keeps a valid selection, in the available order", () => {
    // Not the order it was given in: the checklist must read the same way every
    // time, whatever order the draft happened to store.
    assert.deepEqual(normalizeChannelSelection(["INSTAGRAM", "FACEBOOK"], ALL), [
      "FACEBOOK",
      "INSTAGRAM",
    ]);
  });

  it("drops a channel that is no longer connected", () => {
    // The case this function exists for: a draft saved while TikTok was
    // connected, restored after it was switched off in settings.
    assert.deepEqual(normalizeChannelSelection(["FACEBOOK", "TIKTOK"], ["FACEBOOK", "LINKEDIN"]), [
      "FACEBOOK",
    ]);
  });

  it("falls back to the first available channel when nothing survives", () => {
    assert.deepEqual(normalizeChannelSelection(["TIKTOK"], ["FACEBOOK", "LINKEDIN"]), ["FACEBOOK"]);
    assert.deepEqual(normalizeChannelSelection([], ALL), ["FACEBOOK"]);
  });

  it("is empty only when the company has connected nothing", () => {
    assert.deepEqual(normalizeChannelSelection(["FACEBOOK"], []), []);
  });

  it("accepts the lowercase spelling the API uses", () => {
    assert.deepEqual(normalizeChannelSelection(["facebook", "linkedin"], ALL), [
      "FACEBOOK",
      "LINKEDIN",
    ]);
  });

  it("collapses a repeated channel", () => {
    assert.deepEqual(normalizeChannelSelection(["FACEBOOK", "FACEBOOK"], ALL), ["FACEBOOK"]);
  });
});

describe("toggleChannelSelection", () => {
  it("adds an unselected channel, in display order", () => {
    assert.deepEqual(toggleChannelSelection(["INSTAGRAM"], "FACEBOOK", ALL), [
      "FACEBOOK",
      "INSTAGRAM",
    ]);
  });

  it("removes a selected channel", () => {
    assert.deepEqual(toggleChannelSelection(["FACEBOOK", "INSTAGRAM"], "FACEBOOK", ALL), [
      "INSTAGRAM",
    ]);
  });

  it("refuses to untick the last remaining channel", () => {
    // Enforced where the selection is made rather than by disabling the submit
    // button — an empty checklist would leave the user guessing which of four
    // boxes makes the error go away.
    assert.deepEqual(toggleChannelSelection(["FACEBOOK"], "FACEBOOK", ALL), ["FACEBOOK"]);
  });

  it("ignores a channel that is not on offer", () => {
    assert.deepEqual(toggleChannelSelection(["FACEBOOK"], "TIKTOK", ["FACEBOOK", "LINKEDIN"]), [
      "FACEBOOK",
    ]);
  });

  it("normalizes stale state on the way through", () => {
    // The click arrives on a selection that still names a disconnected channel;
    // the answer must not carry it forward.
    assert.deepEqual(
      toggleChannelSelection(["FACEBOOK", "TIKTOK"], "LINKEDIN", ["FACEBOOK", "LINKEDIN"]),
      ["FACEBOOK", "LINKEDIN"]
    );
  });

  it("round-trips: adding then removing returns the original", () => {
    const start = ["FACEBOOK"];
    const added = toggleChannelSelection(start, "INSTAGRAM", ALL);
    assert.deepEqual(toggleChannelSelection(added, "INSTAGRAM", ALL), start);
  });
});

describe("isAllChannelsSelected", () => {
  it("is true only when every available channel is selected", () => {
    assert.equal(isAllChannelsSelected(ALL, ALL), true);
    assert.equal(isAllChannelsSelected(["FACEBOOK", "LINKEDIN"], ALL), false);
  });

  it("resolves against what is available now, not against all four", () => {
    // A company with two connected profiles has "all channels" at two — the box
    // must tick, not sit permanently unticked because TikTok is not connected.
    assert.equal(isAllChannelsSelected(["FACEBOOK", "LINKEDIN"], ["FACEBOOK", "LINKEDIN"]), true);
  });

  it("is false when there is nothing to select", () => {
    assert.equal(isAllChannelsSelected([], []), false);
  });

  it("ignores a selected channel that is no longer available", () => {
    assert.equal(isAllChannelsSelected(["FACEBOOK", "TIKTOK"], ["FACEBOOK"]), true);
  });
});

describe("toggleAllChannels", () => {
  it("selects everything currently on offer", () => {
    assert.deepEqual(toggleAllChannels(["FACEBOOK"], ALL), ALL);
  });

  it("selects only the connected channels, not all four", () => {
    assert.deepEqual(toggleAllChannels([], ["FACEBOOK", "INSTAGRAM"]), ["FACEBOOK", "INSTAGRAM"]);
  });

  it("falls back to a single channel when unticked", () => {
    // Not to none: the same invariant the individual toggle keeps.
    assert.deepEqual(toggleAllChannels(ALL, ALL), ["FACEBOOK"]);
  });

  it("stays empty when the company has connected nothing", () => {
    assert.deepEqual(toggleAllChannels([], []), []);
  });

  it("ticking after unticking restores the full set", () => {
    const off = toggleAllChannels(ALL, ALL);
    assert.deepEqual(toggleAllChannels(off, ALL), ALL);
  });
});

describe("toChannelPayload", () => {
  it("lowercases, which is how the channel is spelled on the wire", () => {
    assert.deepEqual(toChannelPayload(["FACEBOOK", "INSTAGRAM"]), ["facebook", "instagram"]);
  });
});
