import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ALL_CHANNELS } from "@/lib/channels/channel-scope";
import {
  analyticsChannelOf,
  averageEngagementRate,
  averageMetric,
  engagementActions,
  filterByAnalyticsScope,
  matchesAnalyticsScope,
  metricsForScope,
  sumMetric,
  type MetricFigures,
} from "./analytics-metrics";

/** A post with nothing reported — the starting point for every fixture below. */
const NONE: MetricFigures = {
  reactions: null,
  comments: null,
  shares: null,
  impressions: null,
  clicks: null,
  reach: null,
  views: null,
  saves: null,
  follows: null,
};

function figures(overrides: Partial<MetricFigures>): MetricFigures {
  return { ...NONE, ...overrides };
}

describe("analyticsChannelOf — Buffer is the authority", () => {
  it("files a post under the network Buffer says it landed on", () => {
    assert.equal(
      analyticsChannelOf({ channel: "facebook", channelService: "facebook" }),
      "FACEBOOK"
    );
  });

  it("overrides Post.channel when the two disagree", () => {
    // The mismatch found in live data: care-tech's 2026-08-14 post is stored
    // `instagram` and its metrics carry `channelService = facebook`. The
    // engagement happened on Facebook, so that is where it is counted.
    assert.equal(
      analyticsChannelOf({ channel: "instagram", channelService: "facebook" }),
      "FACEBOOK"
    );
  });

  it("places Buffer's account-type variants through the shared map", () => {
    // A business Instagram account is still Instagram. Comparing the raw service
    // string against Post.channel would file it under nothing at all.
    assert.equal(
      analyticsChannelOf({ channel: "instagram", channelService: "instagram-business" }),
      "INSTAGRAM"
    );
    assert.equal(
      analyticsChannelOf({ channel: "linkedin", channelService: "linkedin-company" }),
      "LINKEDIN"
    );
  });

  it("falls back to Post.channel only when Buffer has said nothing", () => {
    // A post the daily sync has not reached yet. It has no engagement figures to
    // misfile, and dropping it would make "Published posts" disagree with the
    // Posts tab for a reason no user could see.
    assert.equal(analyticsChannelOf({ channel: "linkedin", channelService: null }), "LINKEDIN");
  });

  it("falls back when Buffer reports a service the app cannot place", () => {
    assert.equal(
      analyticsChannelOf({ channel: "facebook", channelService: "mastodon" }),
      "FACEBOOK"
    );
  });
});

describe("scope filtering", () => {
  const posts = [
    { id: "fb", channel: "facebook", channelService: "facebook" },
    { id: "ig", channel: "instagram", channelService: "instagram-business" },
    { id: "mismatch", channel: "instagram", channelService: "facebook" },
    { id: "unsynced", channel: "linkedin", channelService: null },
  ];

  it("selects by channelService, not by Post.channel", () => {
    assert.deepEqual(
      filterByAnalyticsScope(posts, "FACEBOOK").map((p) => p.id),
      ["fb", "mismatch"]
    );
    // The mismatched post is NOT in Instagram, even though it is stored as one.
    assert.deepEqual(
      filterByAnalyticsScope(posts, "INSTAGRAM").map((p) => p.id),
      ["ig"]
    );
  });

  it("keeps everything under All Channels", () => {
    assert.equal(filterByAnalyticsScope(posts, ALL_CHANNELS).length, 4);
  });

  it("matches whichever case the scope arrives in", () => {
    assert.ok(matchesAnalyticsScope({ channel: "facebook", channelService: null }, "facebook"));
    assert.ok(matchesAnalyticsScope({ channel: "facebook", channelService: null }, "FACEBOOK"));
  });
});

describe("sumMetric — NULL is not 0", () => {
  it("returns null when NO row reported the metric", () => {
    // Instagram never reports impressions. A 0 here would be a measurement
    // Instagram never made.
    assert.equal(sumMetric([figures({ reach: 10 }), figures({ reach: 4 })], "impressions"), null);
  });

  it("keeps a genuine zero as a zero", () => {
    // Measured, and nothing happened — a real result, not a missing one.
    assert.equal(sumMetric([figures({ shares: 0 }), figures({ shares: 0 })], "shares"), 0);
  });

  it("adds only the rows that reported, ignoring the silent ones", () => {
    assert.equal(
      sumMetric([figures({ reactions: 5 }), figures({}), figures({ reactions: 7 })], "reactions"),
      12
    );
  });

  it("returns null for an empty set rather than 0", () => {
    assert.equal(sumMetric([], "reactions"), null);
  });
});

describe("averageMetric — NULL is excluded from the DENOMINATOR", () => {
  it("divides by the posts that reported, not by the posts that exist", () => {
    // The requirement's own example: 4 of 10 posts report reach, so the average
    // is the sum over 4. Dividing by 10 would invent six observations Instagram
    // never made and more than halve a real figure.
    const rows = [
      ...[100, 200, 300, 400].map((reach) => figures({ reach })),
      ...Array.from({ length: 6 }, () => figures({})),
    ];

    const average = averageMetric(rows, "reach");

    assert.equal(average.value, 250);
    assert.equal(average.reported, 4);
  });

  it("counts a reported zero in the denominator", () => {
    // 0 was measured. Averaging 10 and 0 is 5, not 10.
    const average = averageMetric(
      [figures({ comments: 10 }), figures({ comments: 0 })],
      "comments"
    );

    assert.equal(average.value, 5);
    assert.equal(average.reported, 2);
  });

  it("reports null with a zero denominator when nothing was measured", () => {
    assert.deepEqual(averageMetric([figures({}), figures({})], "saves"), {
      value: null,
      reported: 0,
    });
  });
});

describe("metricsForScope — no misleading blends", () => {
  const facebookRows = [figures({ reactions: 3, impressions: 900, clicks: 12 })];
  const instagramRows = [figures({ reactions: 8, reach: 400, saves: 5, views: 120 })];

  it("gives All Channels ONLY the three comparable actions", () => {
    // Reach, impressions, clicks and engagement rate are defined differently per
    // network, so a combined figure would add quantities that measure different
    // things — even though both channels below report plenty.
    assert.deepEqual(metricsForScope([...facebookRows, ...instagramRows], ALL_CHANNELS), [
      "reactions",
      "comments",
      "shares",
    ]);
  });

  it("gives Facebook its impressions and clicks", () => {
    assert.deepEqual(metricsForScope(facebookRows, "FACEBOOK"), [
      "reactions",
      "comments",
      "shares",
      "impressions",
      "clicks",
    ]);
  });

  it("gives Instagram its reach, views and saves — and no impressions", () => {
    const metrics = metricsForScope(instagramRows, "INSTAGRAM");

    assert.deepEqual(metrics, ["reactions", "comments", "shares", "reach", "views", "saves"]);
    assert.ok(!metrics.includes("impressions"), "Instagram does not report impressions");
    assert.ok(!metrics.includes("clicks"), "Instagram does not report clicks");
  });

  it("gives a channel exactly what its stored data holds — nothing invented", () => {
    // LinkedIn: whatever Buffer happened to return for it, decided from the rows
    // rather than from a per-network list anywhere in the code.
    assert.deepEqual(metricsForScope([figures({ reactions: 2, impressions: 50 })], "LINKEDIN"), [
      "reactions",
      "comments",
      "shares",
      "impressions",
    ]);
  });

  it("still offers the three actions when nothing reported them", () => {
    // They render "—". A card that silently vanished would be worse than one
    // that says the figure is not there.
    assert.deepEqual(metricsForScope([figures({})], "FACEBOOK"), [
      "reactions",
      "comments",
      "shares",
    ]);
  });

  it("keeps a network metric reported as a genuine zero", () => {
    assert.ok(metricsForScope([figures({ clicks: 0 })], "FACEBOOK").includes("clicks"));
  });
});

describe("averageEngagementRate", () => {
  it("averages only the posts that reported a rate", () => {
    const summary = averageEngagementRate([
      { engagementRate: 10, engagementRateDenominator: "impressions" },
      { engagementRate: 20, engagementRateDenominator: "impressions" },
      { engagementRate: null, engagementRateDenominator: null },
    ]);

    assert.equal(summary.value, 15);
    assert.equal(summary.reported, 2);
    assert.equal(summary.basis, "impressions");
  });

  it("carries the denominator so the label can name it", () => {
    const summary = averageEngagementRate([
      { engagementRate: 4, engagementRateDenominator: "reach" },
    ]);

    assert.equal(summary.basis, "reach");
  });

  it("drops the label when the rows disagree about the denominator", () => {
    // Should be impossible inside one channel. If it ever happens, an unlabelled
    // figure is the honest answer — not a guess at which basis won.
    const summary = averageEngagementRate([
      { engagementRate: 4, engagementRateDenominator: "reach" },
      { engagementRate: 6, engagementRateDenominator: "impressions" },
    ]);

    assert.equal(summary.value, 5);
    assert.equal(summary.basis, null);
  });

  it("is null, not 0, when no post reported a rate", () => {
    assert.deepEqual(
      averageEngagementRate([{ engagementRate: null, engagementRateDenominator: null }]),
      { value: null, reported: 0, basis: null }
    );
  });
});

describe("engagementActions — the channel-neutral score", () => {
  it("adds the three actions that mean the same thing everywhere", () => {
    assert.equal(engagementActions(figures({ reactions: 5, comments: 2, shares: 1 })), 8);
  });

  it("ignores network-specific metrics entirely", () => {
    // Reach must never enter a ranking that All Channels also uses.
    assert.equal(engagementActions(figures({ reactions: 5, reach: 9000 })), 5);
  });

  it("is null for a post nothing was measured on", () => {
    // Not 0: an unmeasured post has not scored zero, and ranking it last would
    // say that it had.
    assert.equal(engagementActions(figures({ reach: 100 })), null);
  });

  it("is 0 for a post measured at zero", () => {
    assert.equal(engagementActions(figures({ reactions: 0 })), 0);
  });
});
