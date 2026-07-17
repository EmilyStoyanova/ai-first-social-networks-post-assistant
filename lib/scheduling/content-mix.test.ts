import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyFallbackTransfers,
  COMPANY_CONTENT_SOURCE_ID,
  contentMixTarget,
  contentMixTotal,
  findUnknownSourceId,
  nextDueQuota,
  projectMixSources,
  remainingByQuota,
  resolveContentMix,
  validateContentMix,
  type MixQuota,
  type MixSourceInput,
} from "./content-mix";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function source(overrides: Partial<MixSourceInput> & { id: string }): MixSourceInput {
  return {
    name: overrides.id,
    enabled: true,
    postsPerWeek: null,
    fallbackPolicy: "skip",
    ...overrides,
  };
}

/** The example distribution from the v2-8 brief: RSS A=3, RSS B=1, company=1. */
const BRIEF_SOURCES = [
  source({ id: "rss-a", name: "RSS A", postsPerWeek: 3 }),
  source({ id: "rss-b", name: "RSS B", postsPerWeek: 1 }),
];
const BRIEF_COMPANY_QUOTA = 1;

function counts(entries: Array<[string | null, number]> = []): Map<string | null, number> {
  return new Map(entries);
}

// ─── resolveContentMix ────────────────────────────────────────────────────────

describe("resolveContentMix", () => {
  it("returns null when nothing is configured (backward compatibility)", () => {
    // The load-bearing legacy case: a pre-v2-8 company has sources but no quotas
    // anywhere. null is the signal that tells the scheduler to keep pooling.
    const mix = resolveContentMix({
      sources: [source({ id: "rss-a" }), source({ id: "rss-b" })],
      companyContentPostsPerWeek: null,
    });
    assert.equal(mix, null);
  });

  it("returns null when a company has no sources at all", () => {
    assert.equal(resolveContentMix({ sources: [], companyContentPostsPerWeek: null }), null);
  });

  it("treats a company-content quota alone as a configured mix", () => {
    const mix = resolveContentMix({ sources: [], companyContentPostsPerWeek: 5 });
    assert.deepEqual(mix, [
      { sourceId: COMPANY_CONTENT_SOURCE_ID, postsPerWeek: 5, fallbackPolicy: "skip" },
    ]);
  });

  it("treats a company-content quota of 0 as configured, not as absent", () => {
    // 0 and null differ: 0 means "no mission posts", null means "no mix at all".
    const mix = resolveContentMix({ sources: BRIEF_SOURCES, companyContentPostsPerWeek: 0 });
    assert.equal(mix?.length, 3);
    assert.equal(contentMixTotal(mix!), 4);
  });

  it("builds the brief's distribution", () => {
    const mix = resolveContentMix({
      sources: BRIEF_SOURCES,
      companyContentPostsPerWeek: BRIEF_COMPANY_QUOTA,
    });
    assert.deepEqual(mix, [
      { sourceId: "rss-a", postsPerWeek: 3, fallbackPolicy: "skip" },
      { sourceId: "rss-b", postsPerWeek: 1, fallbackPolicy: "skip" },
      { sourceId: COMPANY_CONTENT_SOURCE_ID, postsPerWeek: 1, fallbackPolicy: "skip" },
    ]);
    assert.equal(contentMixTotal(mix!), 5);
  });

  it("excludes disabled sources so a stale quota cannot distort the mix", () => {
    const mix = resolveContentMix({
      sources: [...BRIEF_SOURCES, source({ id: "rss-c", postsPerWeek: 9, enabled: false })],
      companyContentPostsPerWeek: 1,
    });
    assert.deepEqual(
      mix?.map((q) => q.sourceId),
      ["rss-a", "rss-b", COMPANY_CONTENT_SOURCE_ID]
    );
    assert.equal(contentMixTotal(mix!), 5);
  });

  it("resolves an enabled source added after the mix was saved to a 0 quota", () => {
    // Never re-pool: the configured quotas still apply, the newcomer just gets
    // nothing until an owner assigns it a value.
    const mix = resolveContentMix({
      sources: [...BRIEF_SOURCES, source({ id: "rss-new", postsPerWeek: null })],
      companyContentPostsPerWeek: 1,
    });
    assert.equal(mix?.find((q) => q.sourceId === "rss-new")?.postsPerWeek, 0);
    assert.equal(contentMixTotal(mix!), 5);
  });

  it("falls back to the default policy for an unrecognized stored value", () => {
    const mix = resolveContentMix({
      sources: [source({ id: "rss-a", postsPerWeek: 1, fallbackPolicy: "nonsense" })],
      companyContentPostsPerWeek: null,
    });
    assert.equal(mix?.[0].fallbackPolicy, "skip");
  });
});

describe("contentMixTarget", () => {
  it("is null when unconfigured and the total when configured", () => {
    assert.equal(contentMixTarget({ sources: BRIEF_SOURCES, companyContentPostsPerWeek: 1 }), 5);
    assert.equal(
      contentMixTarget({ sources: [source({ id: "a" })], companyContentPostsPerWeek: null }),
      null
    );
  });
});

// ─── validateContentMix — valid distributions ─────────────────────────────────

describe("validateContentMix — valid", () => {
  it("accepts the brief's distribution against a matching weekly target", () => {
    const result = validateContentMix({
      sources: BRIEF_SOURCES,
      companyContentPostsPerWeek: BRIEF_COMPANY_QUOTA,
      channelTargets: [{ channel: "facebook", postsPerWeek: 5 }],
    });
    assert.deepEqual(result, { valid: true });
  });

  it("accepts one recipe shared by several channels on the same target", () => {
    const result = validateContentMix({
      sources: BRIEF_SOURCES,
      companyContentPostsPerWeek: 1,
      channelTargets: [
        { channel: "facebook", postsPerWeek: 5 },
        { channel: "linkedin", postsPerWeek: 5 },
      ],
    });
    assert.deepEqual(result, { valid: true });
  });

  it("accepts an unconfigured mix regardless of the channel target", () => {
    // Backward compatibility: legacy companies must never be blocked by a
    // validation rule for a feature they have not opted into.
    const result = validateContentMix({
      sources: [source({ id: "rss-a" }), source({ id: "rss-b" })],
      companyContentPostsPerWeek: null,
      channelTargets: [{ channel: "facebook", postsPerWeek: 5 }],
    });
    assert.deepEqual(result, { valid: true });
  });

  it("accepts a configured mix when no channel is enabled yet", () => {
    const result = validateContentMix({
      sources: BRIEF_SOURCES,
      companyContentPostsPerWeek: 1,
      channelTargets: [],
    });
    assert.deepEqual(result, { valid: true });
  });

  it("ignores a disabled channel's divergent target", () => {
    // channelTargets only ever carries enabled channels; a disabled facebook at
    // 3/week must not block a linkedin-only mix of 5.
    const result = validateContentMix({
      sources: BRIEF_SOURCES,
      companyContentPostsPerWeek: 1,
      channelTargets: [{ channel: "linkedin", postsPerWeek: 5 }],
    });
    assert.deepEqual(result, { valid: true });
  });

  it("accepts a mix that is entirely company content", () => {
    const result = validateContentMix({
      sources: [],
      companyContentPostsPerWeek: 5,
      channelTargets: [{ channel: "facebook", postsPerWeek: 5 }],
    });
    assert.deepEqual(result, { valid: true });
  });

  it("accepts a zero quota inside an otherwise valid mix", () => {
    const result = validateContentMix({
      sources: [source({ id: "rss-a", postsPerWeek: 5 }), source({ id: "rss-b", postsPerWeek: 0 })],
      companyContentPostsPerWeek: 0,
      channelTargets: [{ channel: "facebook", postsPerWeek: 5 }],
    });
    assert.deepEqual(result, { valid: true });
  });
});

// ─── validateContentMix — invalid totals ──────────────────────────────────────

describe("validateContentMix — invalid totals", () => {
  it("rejects a mix that under-fills the weekly target", () => {
    const result = validateContentMix({
      sources: BRIEF_SOURCES,
      companyContentPostsPerWeek: 0,
      channelTargets: [{ channel: "facebook", postsPerWeek: 5 }],
    });
    assert.equal(result.valid, false);
    assert.equal(result.valid === false && result.error.code, "MIX_TOTAL_MISMATCH");
    assert.match(result.valid === false ? result.error.message : "", /totals 4 .* target is 5/);
  });

  it("rejects a mix that over-fills the weekly target", () => {
    // 3 + 1 + 2 = 6 against a target of 5 — over, but still under the ceiling,
    // so this isolates the total rule from the MIX_EXCEEDS_MAX rule below.
    const result = validateContentMix({
      sources: BRIEF_SOURCES,
      companyContentPostsPerWeek: 2,
      channelTargets: [{ channel: "facebook", postsPerWeek: 5 }],
    });
    assert.equal(result.valid, false);
    assert.equal(result.valid === false && result.error.code, "MIX_TOTAL_MISMATCH");
  });

  it("rejects a mix above the per-channel weekly ceiling", () => {
    // The ceiling cannot be applied by truncation — dropping posts would mean
    // choosing whose quota to cut — so it is a rejection, even though the mix
    // matches the requested target exactly.
    const result = validateContentMix({
      sources: [source({ id: "rss-a", postsPerWeek: 8 })],
      companyContentPostsPerWeek: 0,
      channelTargets: [{ channel: "facebook", postsPerWeek: 8 }],
    });
    assert.equal(result.valid, false);
    assert.equal(result.valid === false && result.error.code, "MIX_EXCEEDS_MAX");
  });

  it("accepts a mix exactly at the ceiling", () => {
    const result = validateContentMix({
      sources: [source({ id: "rss-a", postsPerWeek: 7 })],
      companyContentPostsPerWeek: 0,
      channelTargets: [{ channel: "facebook", postsPerWeek: 7 }],
    });
    assert.deepEqual(result, { valid: true });
  });

  it("rejects an enabled source left without a quota", () => {
    const result = validateContentMix({
      sources: [...BRIEF_SOURCES, source({ id: "rss-c", name: "RSS C", postsPerWeek: null })],
      companyContentPostsPerWeek: 1,
      channelTargets: [{ channel: "facebook", postsPerWeek: 5 }],
    });
    assert.equal(result.valid, false);
    assert.equal(result.valid === false && result.error.code, "MIX_SOURCE_UNASSIGNED");
    assert.match(result.valid === false ? result.error.message : "", /RSS C/);
  });

  it("rejects enabled channels with differing weekly targets", () => {
    const result = validateContentMix({
      sources: BRIEF_SOURCES,
      companyContentPostsPerWeek: 1,
      channelTargets: [
        { channel: "facebook", postsPerWeek: 5 },
        { channel: "linkedin", postsPerWeek: 3 },
      ],
    });
    assert.equal(result.valid, false);
    assert.equal(result.valid === false && result.error.code, "MIX_CHANNEL_TARGETS_DIFFER");
  });

  it("rejects a negative quota", () => {
    const result = validateContentMix({
      sources: [
        source({ id: "rss-a", postsPerWeek: -1 }),
        source({ id: "rss-b", postsPerWeek: 6 }),
      ],
      companyContentPostsPerWeek: 0,
      channelTargets: [{ channel: "facebook", postsPerWeek: 5 }],
    });
    assert.equal(result.valid, false);
    assert.equal(result.valid === false && result.error.code, "MIX_INVALID_VALUE");
  });

  it("rejects a fractional quota", () => {
    const result = validateContentMix({
      sources: [source({ id: "rss-a", postsPerWeek: 2.5 })],
      companyContentPostsPerWeek: 2.5,
      channelTargets: [{ channel: "facebook", postsPerWeek: 5 }],
    });
    assert.equal(result.valid, false);
    assert.equal(result.valid === false && result.error.code, "MIX_INVALID_VALUE");
  });

  it("rejects a fallback policy that has no implementation yet", () => {
    // The column accepts the wider vocabulary so a later phase needs no
    // migration, but an unimplemented policy must never silently act as "skip".
    const result = validateContentMix({
      sources: [source({ id: "rss-a", postsPerWeek: 5, fallbackPolicy: "allow_reuse" })],
      companyContentPostsPerWeek: 0,
      channelTargets: [{ channel: "facebook", postsPerWeek: 5 }],
    });
    assert.equal(result.valid, false);
    assert.equal(result.valid === false && result.error.code, "MIX_UNSUPPORTED_FALLBACK");
  });

  it("accepts use_another_source", () => {
    const result = validateContentMix({
      sources: [
        source({ id: "rss-a", postsPerWeek: 3, fallbackPolicy: "use_another_source" }),
        source({ id: "rss-b", postsPerWeek: 2 }),
      ],
      companyContentPostsPerWeek: 0,
      channelTargets: [{ channel: "facebook", postsPerWeek: 5 }],
    });
    assert.equal(result.valid, true);
  });
});

// ─── nextDueQuota ─────────────────────────────────────────────────────────────

const BRIEF_QUOTAS: MixQuota[] = [
  { sourceId: "rss-a", postsPerWeek: 3, fallbackPolicy: "skip" },
  { sourceId: "rss-b", postsPerWeek: 1, fallbackPolicy: "skip" },
  { sourceId: COMPANY_CONTENT_SOURCE_ID, postsPerWeek: 1, fallbackPolicy: "skip" },
];

/** Replays a full week by repeatedly asking which source is due next. */
function drain(
  quotas: MixQuota[],
  exhausted: Set<string | null> = new Set()
): Array<string | null> {
  const generated = counts();
  const order: Array<string | null> = [];
  for (let i = 0; i < 50; i++) {
    const due = nextDueQuota({ quotas, generatedBySource: generated, exhausted });
    if (!due) break;
    order.push(due.sourceId);
    generated.set(due.sourceId, (generated.get(due.sourceId) ?? 0) + 1);
  }
  return order;
}

describe("nextDueQuota", () => {
  it("hands out exactly the configured distribution over a full week", () => {
    const order = drain(BRIEF_QUOTAS);
    assert.equal(order.length, 5);
    assert.equal(order.filter((s) => s === "rss-a").length, 3);
    assert.equal(order.filter((s) => s === "rss-b").length, 1);
    assert.equal(order.filter((s) => s === COMPANY_CONTENT_SOURCE_ID).length, 1);
  });

  it("spreads sources across the week instead of draining the biggest first", () => {
    // Ranking by outstanding fraction rather than absolute deficit is what stops
    // RSS A's 3 posts from taking Mon/Tue/Wed as a block.
    assert.deepEqual(drain(BRIEF_QUOTAS), [
      "rss-a",
      "rss-b",
      COMPANY_CONTENT_SOURCE_ID,
      "rss-a",
      "rss-a",
    ]);
  });

  it("is deterministic — the same inputs always yield the same order", () => {
    assert.deepEqual(drain(BRIEF_QUOTAS), drain(BRIEF_QUOTAS));
  });

  it("returns null once every quota is filled", () => {
    const generated = counts([
      ["rss-a", 3],
      ["rss-b", 1],
      [COMPANY_CONTENT_SOURCE_ID, 1],
    ]);
    assert.equal(
      nextDueQuota({ quotas: BRIEF_QUOTAS, generatedBySource: generated, exhausted: new Set() }),
      null
    );
  });

  it("resumes mid-week from posts already generated", () => {
    // The cron budget is 3 LLM calls/run, so a 5-post week always spans runs.
    // With rss-a 2/3 and rss-b 1/1 done, company content is the only quota
    // still wholly outstanding, so it is due next.
    const due = nextDueQuota({
      quotas: BRIEF_QUOTAS,
      generatedBySource: counts([
        ["rss-a", 2],
        ["rss-b", 1],
      ]),
      exhausted: new Set(),
    });
    assert.equal(due?.sourceId, COMPANY_CONTENT_SOURCE_ID);
  });

  it("finishes the last outstanding quota when it is the only one left", () => {
    const due = nextDueQuota({
      quotas: BRIEF_QUOTAS,
      generatedBySource: counts([
        ["rss-a", 2],
        ["rss-b", 1],
        [COMPANY_CONTENT_SOURCE_ID, 1],
      ]),
      exhausted: new Set(),
    });
    assert.equal(due?.sourceId, "rss-a");
  });

  it("never picks a quota already at target", () => {
    const generated = counts([["rss-b", 1]]);
    const order: Array<string | null> = [];
    for (let i = 0; i < 4; i++) {
      const due = nextDueQuota({
        quotas: BRIEF_QUOTAS,
        generatedBySource: generated,
        exhausted: new Set(),
      });
      if (!due) break;
      order.push(due.sourceId);
      generated.set(due.sourceId, (generated.get(due.sourceId) ?? 0) + 1);
    }
    assert.equal(order.includes("rss-b"), false);
  });

  it("skips a quota of zero entirely", () => {
    const quotas: MixQuota[] = [
      { sourceId: "rss-a", postsPerWeek: 5, fallbackPolicy: "skip" },
      { sourceId: "rss-b", postsPerWeek: 0, fallbackPolicy: "skip" },
    ];
    assert.equal(drain(quotas).includes("rss-b"), false);
  });
});

// ─── nextDueQuota — exhausted sources ─────────────────────────────────────────

describe("nextDueQuota — exhausted sources", () => {
  it("skips an exhausted source and leaves its quota unfilled", () => {
    // The core anti-reassignment guarantee: RSS A runs dry, so the week ends
    // with 2 posts (RSS B + company), NOT with RSS A's 3 handed to someone else.
    const order = drain(BRIEF_QUOTAS, new Set(["rss-a"]));
    assert.deepEqual(order.sort(), ["rss-b", COMPANY_CONTENT_SOURCE_ID].sort());
    assert.equal(order.includes("rss-a"), false);
  });

  it("does not reassign an exhausted source's quota to other sources", () => {
    const order = drain(BRIEF_QUOTAS, new Set(["rss-a"]));
    assert.equal(order.filter((s) => s === "rss-b").length, 1, "rss-b keeps its own quota of 1");
    assert.equal(
      order.filter((s) => s === COMPANY_CONTENT_SOURCE_ID).length,
      1,
      "company content keeps its own quota of 1"
    );
  });

  it("keeps filling other quotas when one source is exhausted mid-week", () => {
    const generated = counts([["rss-a", 1]]);
    const due = nextDueQuota({
      quotas: BRIEF_QUOTAS,
      generatedBySource: generated,
      exhausted: new Set(["rss-a"]),
    });
    assert.notEqual(due, null);
    assert.notEqual(due?.sourceId, "rss-a");
  });

  it("returns null when every remaining quota is exhausted", () => {
    const due = nextDueQuota({
      quotas: BRIEF_QUOTAS,
      generatedBySource: counts(),
      exhausted: new Set(["rss-a", "rss-b", COMPANY_CONTENT_SOURCE_ID]),
    });
    assert.equal(due, null);
  });

  it("can exhaust the company-content quota without affecting RSS quotas", () => {
    const order = drain(BRIEF_QUOTAS, new Set([COMPANY_CONTENT_SOURCE_ID]));
    assert.equal(order.filter((s) => s === "rss-a").length, 3);
    assert.equal(order.filter((s) => s === "rss-b").length, 1);
    assert.equal(order.includes(COMPANY_CONTENT_SOURCE_ID), false);
  });
});

// ─── applyFallbackTransfers — use_another_source ──────────────────────────────

/** Shorthand for an RSS quota that hands its shortfall on when it runs dry. */
function handsOff(sourceId: string, postsPerWeek: number): MixQuota {
  return { sourceId, postsPerWeek, fallbackPolicy: "use_another_source" };
}

/** Shorthand for an RSS quota that keeps its shortfall to itself. */
function keeps(sourceId: string, postsPerWeek: number): MixQuota {
  return { sourceId, postsPerWeek, fallbackPolicy: "skip" };
}

function quotaFor(quotas: readonly MixQuota[], sourceId: string | null): number {
  return quotas.find((q) => q.sourceId === sourceId)?.postsPerWeek ?? -1;
}

describe("applyFallbackTransfers", () => {
  it("changes nothing while every source still has articles", () => {
    const quotas = [handsOff("rss-a", 3), keeps("rss-b", 2)];
    assert.deepEqual(
      applyFallbackTransfers({ quotas, generatedBySource: counts(), exhausted: new Set() }),
      quotas
    );
  });

  it("leaves a 'skip' source's shortfall exactly where it is", () => {
    // The pre-existing default must be untouched by this feature: opting in is
    // the only way a quota ever moves.
    const quotas = [keeps("rss-a", 3), keeps("rss-b", 2)];
    const effective = applyFallbackTransfers({
      quotas,
      generatedBySource: counts([["rss-a", 1]]),
      exhausted: new Set(["rss-a"]),
    });
    assert.deepEqual(effective, quotas);
  });

  it("hands an exhausted source's shortfall to the one source that can write it", () => {
    // The brief's example: RSS A=3 and RSS B=2, but A has only 1 article, so the
    // week must still produce 5 posts — as A=1, B=4.
    const effective = applyFallbackTransfers({
      quotas: [handsOff("rss-a", 3), keeps("rss-b", 2)],
      generatedBySource: counts([["rss-a", 1]]),
      exhausted: new Set(["rss-a"]),
    });
    assert.equal(quotaFor(effective, "rss-a"), 1);
    assert.equal(quotaFor(effective, "rss-b"), 4);
  });

  it("a recipient's own policy is irrelevant — it is the donor that decides", () => {
    // rss-b above is a "skip" source and still received. Asserted explicitly
    // because the opposite reading (both sides must opt in) is a tempting one.
    const effective = applyFallbackTransfers({
      quotas: [handsOff("rss-a", 2), keeps("rss-b", 1)],
      generatedBySource: counts(),
      exhausted: new Set(["rss-a"]),
    });
    assert.equal(quotaFor(effective, "rss-b"), 3);
  });

  it("preserves the weekly total", () => {
    // The whole point of the feature, and the one property that must hold for
    // every arrangement of donors and recipients.
    const quotas = [handsOff("rss-a", 3), handsOff("rss-b", 2), keeps("rss-c", 2)];
    const generated = counts([["rss-a", 1]]);
    for (const exhausted of [
      new Set<string | null>(),
      new Set<string | null>(["rss-a"]),
      new Set<string | null>(["rss-a", "rss-b"]),
    ]) {
      const effective = applyFallbackTransfers({ quotas, generatedBySource: generated, exhausted });
      assert.equal(
        contentMixTotal(effective),
        contentMixTotal(quotas),
        `total changed for exhausted={${[...exhausted].join(",")}}`
      );
    }
  });

  it("leaves a donor owing nothing — it keeps only what it wrote", () => {
    const effective = applyFallbackTransfers({
      quotas: [handsOff("rss-a", 3), keeps("rss-b", 2)],
      generatedBySource: counts([["rss-a", 2]]),
      exhausted: new Set(["rss-a"]),
    });
    assert.equal(quotaFor(effective, "rss-a"), 2);
    assert.equal(quotaFor(effective, "rss-b"), 3);
  });

  it("splits the shortfall evenly between candidates instead of picking the first", () => {
    // RSS A runs dry; B and C both have articles, so they take one extra each —
    // not two for B and none for C.
    const effective = applyFallbackTransfers({
      quotas: [handsOff("rss-a", 2), keeps("rss-b", 2), keeps("rss-c", 2)],
      generatedBySource: counts(),
      exhausted: new Set(["rss-a"]),
    });
    assert.equal(quotaFor(effective, "rss-b"), 3);
    assert.equal(quotaFor(effective, "rss-c"), 3);
  });

  it("gives an indivisible remainder to the earliest candidates", () => {
    // 3 posts across 2 candidates cannot be even; 2/1 is as close as it gets,
    // and list order decides who takes the odd one so runs stay reproducible.
    const effective = applyFallbackTransfers({
      quotas: [handsOff("rss-a", 3), keeps("rss-b", 1), keeps("rss-c", 1)],
      generatedBySource: counts(),
      exhausted: new Set(["rss-a"]),
    });
    assert.equal(quotaFor(effective, "rss-b"), 3);
    assert.equal(quotaFor(effective, "rss-c"), 2);
  });

  it("pools the shortfall of several donors before splitting it", () => {
    const effective = applyFallbackTransfers({
      quotas: [handsOff("rss-a", 2), handsOff("rss-b", 2), keeps("rss-c", 1), keeps("rss-d", 1)],
      generatedBySource: counts(),
      exhausted: new Set(["rss-a", "rss-b"]),
    });
    assert.equal(quotaFor(effective, "rss-c"), 3);
    assert.equal(quotaFor(effective, "rss-d"), 3);
  });

  it("never hands posts to a source that is itself out of articles", () => {
    const effective = applyFallbackTransfers({
      quotas: [handsOff("rss-a", 2), keeps("rss-b", 2), keeps("rss-c", 2)],
      generatedBySource: counts(),
      exhausted: new Set(["rss-a", "rss-b"]),
    });
    assert.equal(quotaFor(effective, "rss-b"), 2, "rss-b is dry and must not be topped up");
    assert.equal(quotaFor(effective, "rss-c"), 4);
  });

  it("never hands posts to a source configured to write none", () => {
    // A quota of 0 means "not this feed". Treating it as spare capacity would
    // publish from a source the owner switched off in all but name.
    const effective = applyFallbackTransfers({
      quotas: [handsOff("rss-a", 2), keeps("rss-b", 0), keeps("rss-c", 2)],
      generatedBySource: counts(),
      exhausted: new Set(["rss-a"]),
    });
    assert.equal(quotaFor(effective, "rss-b"), 0);
    assert.equal(quotaFor(effective, "rss-c"), 4);
  });

  it("never hands posts to a disabled source", () => {
    // Disabled sources are dropped before a quota exists, so the transfer never
    // sees them. Driven through resolveContentMix to prove the real path.
    const quotas = resolveContentMix({
      sources: [
        source({ id: "rss-a", postsPerWeek: 3, fallbackPolicy: "use_another_source" }),
        source({ id: "rss-b", postsPerWeek: 2, enabled: false }),
      ],
      companyContentPostsPerWeek: null,
    });
    assert.equal(
      quotas?.some((q) => q.sourceId === "rss-b"),
      false
    );
    const effective = applyFallbackTransfers({
      quotas: quotas ?? [],
      generatedBySource: counts(),
      exhausted: new Set(["rss-a"]),
    });
    assert.deepEqual(effective, quotas, "no candidate exists, so nothing moved");
  });

  it("never takes from or gives to company content", () => {
    // Mission posts do not run out, and a feed's shortfall must not silently
    // become more brand copy than the owner asked for.
    const effective = applyFallbackTransfers({
      quotas: [
        handsOff("rss-a", 2),
        keeps("rss-b", 2),
        { sourceId: COMPANY_CONTENT_SOURCE_ID, postsPerWeek: 1, fallbackPolicy: "skip" },
      ],
      generatedBySource: counts(),
      exhausted: new Set(["rss-a", COMPANY_CONTENT_SOURCE_ID]),
    });
    assert.equal(quotaFor(effective, COMPANY_CONTENT_SOURCE_ID), 1, "company quota is untouched");
    assert.equal(quotaFor(effective, "rss-b"), 4, "the RSS shortfall went to the RSS source");
  });

  it("leaves the shortfall unfilled when no candidate remains — the skip outcome", () => {
    const quotas = [handsOff("rss-a", 3), handsOff("rss-b", 2)];
    const effective = applyFallbackTransfers({
      quotas,
      generatedBySource: counts(),
      exhausted: new Set(["rss-a", "rss-b"]),
    });
    assert.deepEqual(effective, quotas);
    // Still owed 5, so the schedule stays open and the next run retries.
    assert.equal(
      remainingByQuota({
        quotas,
        generatedBySource: counts(),
        exhausted: new Set(["rss-a", "rss-b"]),
      }).reduce((sum, r) => sum + r.remaining, 0),
      5
    );
  });

  it("reports nothing outstanding once a transfer has been fully written", () => {
    // The schedule can only flip to "ready" if the donor stops being owed the
    // posts it gave away.
    const remaining = remainingByQuota({
      quotas: [handsOff("rss-a", 3), keeps("rss-b", 2)],
      generatedBySource: counts([
        ["rss-a", 1],
        ["rss-b", 4],
      ]),
      exhausted: new Set(["rss-a"]),
    });
    assert.equal(
      remaining.reduce((sum, r) => sum + r.remaining, 0),
      0
    );
  });

  it("does not mutate its input", () => {
    const quotas = [handsOff("rss-a", 3), keeps("rss-b", 2)];
    applyFallbackTransfers({
      quotas,
      generatedBySource: counts([["rss-a", 1]]),
      exhausted: new Set(["rss-a"]),
    });
    assert.equal(quotaFor(quotas, "rss-a"), 3);
    assert.equal(quotaFor(quotas, "rss-b"), 2);
  });

  it("is deterministic — the same inputs always yield the same transfer", () => {
    const input = {
      quotas: [handsOff("rss-a", 3), keeps("rss-b", 1), keeps("rss-c", 1)],
      generatedBySource: counts(),
      exhausted: new Set(["rss-a"]),
    };
    assert.deepEqual(applyFallbackTransfers(input), applyFallbackTransfers(input));
  });
});

// ─── nextDueQuota — use_another_source ────────────────────────────────────────

/**
 * Replays a full week the way fillChannelFromMix does, with each source holding
 * a fixed stock of articles: ask what is due, and when that source has nothing
 * left, mark it exhausted and ask again. Sources absent from `stock` never run
 * out.
 */
function drainWithStock(
  quotas: MixQuota[],
  stock: Map<string | null, number>
): Array<string | null> {
  const generated = counts();
  const exhausted = new Set<string | null>();
  const order: Array<string | null> = [];

  for (let i = 0; i < 50; i++) {
    const due = nextDueQuota({ quotas, generatedBySource: generated, exhausted });
    if (!due) break;
    const written = generated.get(due.sourceId) ?? 0;
    if (written >= (stock.get(due.sourceId) ?? Infinity)) {
      exhausted.add(due.sourceId);
      continue;
    }
    order.push(due.sourceId);
    generated.set(due.sourceId, written + 1);
  }

  return order;
}

describe("nextDueQuota — use_another_source", () => {
  it("still hits the weekly post count when a source runs dry", () => {
    // RSS A=3 + RSS B=2 with only 1 article in A: the week owes 5 posts and
    // must deliver 5, as A=1 and B=4.
    const order = drainWithStock(
      [handsOff("rss-a", 3), keeps("rss-b", 2)],
      new Map([["rss-a", 1]])
    );
    assert.equal(order.length, 5);
    assert.equal(order.filter((s) => s === "rss-a").length, 1);
    assert.equal(order.filter((s) => s === "rss-b").length, 4);
  });

  it("balances the extra posts across candidates over a whole week", () => {
    // RSS A is dry from the start; B and C both have plenty, so they finish
    // level rather than B absorbing all of A's quota.
    const order = drainWithStock(
      [handsOff("rss-a", 2), keeps("rss-b", 2), keeps("rss-c", 2)],
      new Map([["rss-a", 0]])
    );
    assert.equal(order.length, 6);
    assert.equal(order.filter((s) => s === "rss-b").length, 3);
    assert.equal(order.filter((s) => s === "rss-c").length, 3);
  });

  it("stops at the shortfall the remaining sources can absorb", () => {
    // A is dry and B has only 3 articles for its now-4 quota: 4 posts is all the
    // week can honestly produce, and the loop must terminate rather than spin.
    const order = drainWithStock(
      [handsOff("rss-a", 3), keeps("rss-b", 2)],
      new Map([
        ["rss-a", 1],
        ["rss-b", 3],
      ])
    );
    assert.equal(order.length, 4);
  });

  it("under 'skip' the same week falls short, unchanged", () => {
    // The contrast that shows the policy is doing the work: identical stock,
    // identical quotas, only the policy differs.
    const order = drainWithStock([keeps("rss-a", 3), keeps("rss-b", 2)], new Map([["rss-a", 1]]));
    assert.equal(order.length, 3);
    assert.equal(order.filter((s) => s === "rss-b").length, 2);
  });

  it("resumes mid-week from posts an earlier run already wrote", () => {
    // The cron budget is 3 LLM calls/run, so the transfer must be re-derived on
    // the next run from stored posts alone — it is never persisted.
    const due = nextDueQuota({
      quotas: [handsOff("rss-a", 3), keeps("rss-b", 2)],
      generatedBySource: counts([
        ["rss-a", 1],
        ["rss-b", 2],
      ]),
      exhausted: new Set(["rss-a"]),
    });
    assert.equal(due?.sourceId, "rss-b", "rss-b is at its own target but owes the transfer");
  });
});

// ─── remainingByQuota ─────────────────────────────────────────────────────────

// ─── projectMixSources / findUnknownSourceId ──────────────────────────────────

describe("projectMixSources", () => {
  it("applies submitted quotas", () => {
    const projected = projectMixSources(
      BRIEF_SOURCES,
      new Map([
        ["rss-a", { postsPerWeek: 4 }],
        ["rss-b", { postsPerWeek: 0 }],
      ])
    );
    assert.equal(projected.find((s) => s.id === "rss-a")?.postsPerWeek, 4);
    assert.equal(projected.find((s) => s.id === "rss-b")?.postsPerWeek, 0);
  });

  it("leaves omitted sources on their stored quota", () => {
    // A client with a stale source list must not wipe a quota it never showed.
    const projected = projectMixSources(BRIEF_SOURCES, new Map([["rss-a", { postsPerWeek: 4 }]]));
    assert.equal(projected.find((s) => s.id === "rss-b")?.postsPerWeek, 1);
  });

  it("clears a quota when null is submitted", () => {
    const projected = projectMixSources(
      BRIEF_SOURCES,
      new Map([["rss-a", { postsPerWeek: null }]])
    );
    assert.equal(projected.find((s) => s.id === "rss-a")?.postsPerWeek, null);
  });

  it("does not mutate the input", () => {
    projectMixSources(BRIEF_SOURCES, new Map([["rss-a", { postsPerWeek: 4 }]]));
    assert.equal(BRIEF_SOURCES.find((s) => s.id === "rss-a")?.postsPerWeek, 3);
  });

  it("applies a submitted fallback policy", () => {
    const projected = projectMixSources(
      BRIEF_SOURCES,
      new Map([["rss-a", { postsPerWeek: 3, fallbackPolicy: "use_another_source" }]])
    );
    assert.equal(projected.find((s) => s.id === "rss-a")?.fallbackPolicy, "use_another_source");
  });

  it("keeps the stored policy when a submitted source omits one", () => {
    // A client that predates the policy selector submits quotas only. It must
    // not reset every source to the default just by saving.
    const stored = [source({ id: "rss-a", postsPerWeek: 3, fallbackPolicy: "use_another_source" })];
    const projected = projectMixSources(stored, new Map([["rss-a", { postsPerWeek: 5 }]]));
    assert.equal(projected[0].postsPerWeek, 5, "the quota still changes");
    assert.equal(projected[0].fallbackPolicy, "use_another_source", "the policy survives");
  });

  it("keeps the stored policy for a source the request omits entirely", () => {
    const stored = [
      source({ id: "rss-a", postsPerWeek: 3 }),
      source({ id: "rss-b", postsPerWeek: 1, fallbackPolicy: "use_another_source" }),
    ];
    const projected = projectMixSources(stored, new Map([["rss-a", { postsPerWeek: 4 }]]));
    assert.equal(projected.find((s) => s.id === "rss-b")?.fallbackPolicy, "use_another_source");
  });
});

describe("findUnknownSourceId", () => {
  it("returns null when every id is known", () => {
    assert.equal(findUnknownSourceId(BRIEF_SOURCES, ["rss-a", "rss-b"]), null);
  });

  it("reports an id that is not one of the company's sources", () => {
    assert.equal(findUnknownSourceId(BRIEF_SOURCES, ["rss-a", "someone-elses"]), "someone-elses");
  });
});

describe("remainingByQuota", () => {
  it("reports each quota's outstanding posts", () => {
    const remaining = remainingByQuota({
      quotas: BRIEF_QUOTAS,
      generatedBySource: counts([["rss-a", 1]]),
      exhausted: new Set(),
    });
    assert.deepEqual(remaining, [
      { sourceId: "rss-a", remaining: 2 },
      { sourceId: "rss-b", remaining: 1 },
      { sourceId: COMPANY_CONTENT_SOURCE_ID, remaining: 1 },
    ]);
  });

  it("clamps at zero when a quota was over-filled", () => {
    const remaining = remainingByQuota({
      quotas: BRIEF_QUOTAS,
      generatedBySource: counts([["rss-b", 4]]),
      exhausted: new Set(),
    });
    assert.equal(remaining.find((r) => r.sourceId === "rss-b")?.remaining, 0);
  });
});
