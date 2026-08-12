import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  transferExhaustedQuotas,
  COMPANY_CONTENT_SOURCE_ID,
  contentMixTotal,
  findUnknownSourceId,
  MAX_POSTS_PER_CHANNEL_PER_WEEK,
  mixForChannel,
  nextDueQuota,
  projectMixSources,
  remainingByQuota,
  resolveContentMix,
  scaleMixToTotal,
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
    assert.deepEqual(mix, [{ sourceId: COMPANY_CONTENT_SOURCE_ID, postsPerWeek: 5 }]);
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
      { sourceId: "rss-a", postsPerWeek: 3 },
      { sourceId: "rss-b", postsPerWeek: 1 },
      { sourceId: COMPANY_CONTENT_SOURCE_ID, postsPerWeek: 1 },
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
});

// ─── validateContentMix — valid distributions ─────────────────────────────────

describe("validateContentMix — valid", () => {
  it("accepts the brief's distribution", () => {
    const result = validateContentMix({
      sources: BRIEF_SOURCES,
      companyContentPostsPerWeek: BRIEF_COMPANY_QUOTA,
    });
    assert.deepEqual(result, { valid: true });
  });

  it("accepts an unconfigured mix", () => {
    // Backward compatibility: legacy companies must never be blocked by a
    // validation rule for a feature they have not opted into.
    const result = validateContentMix({
      sources: [source({ id: "rss-a" }), source({ id: "rss-b" })],
      companyContentPostsPerWeek: null,
    });
    assert.deepEqual(result, { valid: true });
  });

  it("accepts any total a channel's weekly budget disagrees with", () => {
    // The mix is a ratio, so there is nothing for it to agree with: each channel
    // resizes it to its own posts-per-week (see mixForChannel). A company running
    // Facebook at 3 and Instagram at 5 can still write its recipe as a 4.
    for (const companyQuota of [0, 2, 3]) {
      const result = validateContentMix({
        sources: BRIEF_SOURCES,
        companyContentPostsPerWeek: companyQuota,
      });
      assert.deepEqual(result, { valid: true }, `company quota ${companyQuota}`);
    }
  });

  it("accepts a mix that is entirely company content", () => {
    const result = validateContentMix({ sources: [], companyContentPostsPerWeek: 5 });
    assert.deepEqual(result, { valid: true });
  });

  it("accepts a zero quota inside an otherwise valid mix", () => {
    const result = validateContentMix({
      sources: [source({ id: "rss-a", postsPerWeek: 5 }), source({ id: "rss-b", postsPerWeek: 0 })],
      companyContentPostsPerWeek: 0,
    });
    assert.deepEqual(result, { valid: true });
  });
});

// ─── validateContentMix — rejections ──────────────────────────────────────────

describe("validateContentMix — rejections", () => {
  it("rejects a mix above the per-channel weekly ceiling", () => {
    // The ceiling cannot be applied by truncation — dropping posts would mean
    // choosing whose quota to cut — so it is a rejection. The scheduler enforces
    // the same number with a hard stop, so a mix above it would under-generate.
    const result = validateContentMix({
      sources: [source({ id: "rss-a", postsPerWeek: 8 })],
      companyContentPostsPerWeek: 0,
    });
    assert.equal(result.valid, false);
    assert.equal(result.valid === false && result.error.code, "MIX_EXCEEDS_MAX");
  });

  it("accepts a mix exactly at the ceiling", () => {
    const result = validateContentMix({
      sources: [source({ id: "rss-a", postsPerWeek: 7 })],
      companyContentPostsPerWeek: 0,
    });
    assert.deepEqual(result, { valid: true });
  });

  it("rejects a mix of nothing but zeros", () => {
    // Saveable it would generate no posts at all, while looking in settings like
    // a decision someone made. Clearing the mix is how you ask for pooling.
    const result = validateContentMix({
      sources: [source({ id: "rss-a", postsPerWeek: 0 })],
      companyContentPostsPerWeek: 0,
    });
    assert.equal(result.valid, false);
    assert.equal(result.valid === false && result.error.code, "MIX_EMPTY");
  });

  it("rejects an enabled source left without a quota", () => {
    const result = validateContentMix({
      sources: [...BRIEF_SOURCES, source({ id: "rss-c", name: "RSS C", postsPerWeek: null })],
      companyContentPostsPerWeek: 1,
    });
    assert.equal(result.valid, false);
    assert.equal(result.valid === false && result.error.code, "MIX_SOURCE_UNASSIGNED");
    assert.match(result.valid === false ? result.error.message : "", /RSS C/);
  });

  it("rejects a negative quota", () => {
    const result = validateContentMix({
      sources: [
        source({ id: "rss-a", postsPerWeek: -1 }),
        source({ id: "rss-b", postsPerWeek: 6 }),
      ],
      companyContentPostsPerWeek: 0,
    });
    assert.equal(result.valid, false);
    assert.equal(result.valid === false && result.error.code, "MIX_INVALID_VALUE");
  });

  it("rejects a fractional quota", () => {
    const result = validateContentMix({
      sources: [source({ id: "rss-a", postsPerWeek: 2.5 })],
      companyContentPostsPerWeek: 2.5,
    });
    assert.equal(result.valid, false);
    assert.equal(result.valid === false && result.error.code, "MIX_INVALID_VALUE");
  });
});

// ─── nextDueQuota ─────────────────────────────────────────────────────────────

const BRIEF_QUOTAS: MixQuota[] = [
  { sourceId: "rss-a", postsPerWeek: 3 },
  { sourceId: "rss-b", postsPerWeek: 1 },
  { sourceId: COMPANY_CONTENT_SOURCE_ID, postsPerWeek: 1 },
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
      { sourceId: "rss-a", postsPerWeek: 5 },
      { sourceId: "rss-b", postsPerWeek: 0 },
    ];
    assert.equal(drain(quotas).includes("rss-b"), false);
  });
});

// ─── nextDueQuota — exhausted sources ─────────────────────────────────────────

describe("nextDueQuota — exhausted sources", () => {
  it("never picks an exhausted source, and still fills the week", () => {
    // RSS A runs dry, so RSS B writes A's 3 posts on top of its own 1. The week
    // still produces 5 — the whole point of transferring unconditionally.
    const order = drain(BRIEF_QUOTAS, new Set(["rss-a"]));
    assert.equal(order.length, 5);
    assert.equal(order.includes("rss-a"), false, "a dry source is never asked again");
  });

  it("hands the dry source's quota to the other RSS source, never to company content", () => {
    const order = drain(BRIEF_QUOTAS, new Set(["rss-a"]));
    assert.equal(order.filter((s) => s === "rss-b").length, 4, "rss-b takes its own 1 plus A's 3");
    assert.equal(
      order.filter((s) => s === COMPANY_CONTENT_SOURCE_ID).length,
      1,
      "company content keeps exactly its own quota of 1"
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

// ─── transferExhaustedQuotas ──────────────────────────────────────────────────

/** Shorthand for an RSS quota. Every source hands its shortfall on when dry. */
function quota(sourceId: string, postsPerWeek: number): MixQuota {
  return { sourceId, postsPerWeek };
}

function quotaFor(quotas: readonly MixQuota[], sourceId: string | null): number {
  return quotas.find((q) => q.sourceId === sourceId)?.postsPerWeek ?? -1;
}

describe("transferExhaustedQuotas", () => {
  it("changes nothing while every source still has articles", () => {
    const quotas = [quota("rss-a", 3), quota("rss-b", 2)];
    assert.deepEqual(
      transferExhaustedQuotas({ quotas, generatedBySource: counts(), exhausted: new Set() }),
      quotas
    );
  });

  it("hands an exhausted source's shortfall to the one source that can write it", () => {
    // The brief's example: RSS A=3 and RSS B=2, but A has only 1 article, so the
    // week must still produce 5 posts — as A=1, B=4.
    const effective = transferExhaustedQuotas({
      quotas: [quota("rss-a", 3), quota("rss-b", 2)],
      generatedBySource: counts([["rss-a", 1]]),
      exhausted: new Set(["rss-a"]),
    });
    assert.equal(quotaFor(effective, "rss-a"), 1);
    assert.equal(quotaFor(effective, "rss-b"), 4);
  });

  it("transfers unconditionally — there is no per-source opt-out", () => {
    // The product decision: a company that configured 5 posts a week wants 5
    // posts a week, whichever feed happened to have articles left.
    const effective = transferExhaustedQuotas({
      quotas: [quota("rss-a", 2), quota("rss-b", 1)],
      generatedBySource: counts(),
      exhausted: new Set(["rss-a"]),
    });
    assert.equal(quotaFor(effective, "rss-b"), 3);
  });

  it("preserves the weekly total", () => {
    // The whole point of the feature, and the one property that must hold for
    // every arrangement of donors and recipients.
    const quotas = [quota("rss-a", 3), quota("rss-b", 2), quota("rss-c", 2)];
    const generated = counts([["rss-a", 1]]);
    for (const exhausted of [
      new Set<string | null>(),
      new Set<string | null>(["rss-a"]),
      new Set<string | null>(["rss-a", "rss-b"]),
    ]) {
      const effective = transferExhaustedQuotas({
        quotas,
        generatedBySource: generated,
        exhausted,
      });
      assert.equal(
        contentMixTotal(effective),
        contentMixTotal(quotas),
        `total changed for exhausted={${[...exhausted].join(",")}}`
      );
    }
  });

  it("leaves a donor owing nothing — it keeps only what it wrote", () => {
    const effective = transferExhaustedQuotas({
      quotas: [quota("rss-a", 3), quota("rss-b", 2)],
      generatedBySource: counts([["rss-a", 2]]),
      exhausted: new Set(["rss-a"]),
    });
    assert.equal(quotaFor(effective, "rss-a"), 2);
    assert.equal(quotaFor(effective, "rss-b"), 3);
  });

  it("splits the shortfall evenly between candidates instead of picking the first", () => {
    // RSS A runs dry; B and C both have articles, so they take one extra each —
    // not two for B and none for C.
    const effective = transferExhaustedQuotas({
      quotas: [quota("rss-a", 2), quota("rss-b", 2), quota("rss-c", 2)],
      generatedBySource: counts(),
      exhausted: new Set(["rss-a"]),
    });
    assert.equal(quotaFor(effective, "rss-b"), 3);
    assert.equal(quotaFor(effective, "rss-c"), 3);
  });

  it("gives an indivisible remainder to the earliest candidates", () => {
    // 3 posts across 2 candidates cannot be even; 2/1 is as close as it gets,
    // and list order decides who takes the odd one so runs stay reproducible.
    const effective = transferExhaustedQuotas({
      quotas: [quota("rss-a", 3), quota("rss-b", 1), quota("rss-c", 1)],
      generatedBySource: counts(),
      exhausted: new Set(["rss-a"]),
    });
    assert.equal(quotaFor(effective, "rss-b"), 3);
    assert.equal(quotaFor(effective, "rss-c"), 2);
  });

  it("pools the shortfall of several donors before splitting it", () => {
    const effective = transferExhaustedQuotas({
      quotas: [quota("rss-a", 2), quota("rss-b", 2), quota("rss-c", 1), quota("rss-d", 1)],
      generatedBySource: counts(),
      exhausted: new Set(["rss-a", "rss-b"]),
    });
    assert.equal(quotaFor(effective, "rss-c"), 3);
    assert.equal(quotaFor(effective, "rss-d"), 3);
  });

  it("never hands posts to a source that is itself out of articles", () => {
    const effective = transferExhaustedQuotas({
      quotas: [quota("rss-a", 2), quota("rss-b", 2), quota("rss-c", 2)],
      generatedBySource: counts(),
      exhausted: new Set(["rss-a", "rss-b"]),
    });
    // rss-b is dry, so it is a donor rather than a recipient: it gives up its
    // own 2 as well, and rss-c — the only source left with articles — takes all 6.
    assert.equal(quotaFor(effective, "rss-b"), 0, "a dry source is never topped up");
    assert.equal(quotaFor(effective, "rss-c"), 6);
    assert.equal(contentMixTotal(effective), 6, "the week's total is still 6");
  });

  it("never hands posts to a source configured to write none", () => {
    // A quota of 0 means "not this feed". Treating it as spare capacity would
    // publish from a source the owner switched off in all but name.
    const effective = transferExhaustedQuotas({
      quotas: [quota("rss-a", 2), quota("rss-b", 0), quota("rss-c", 2)],
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
        source({ id: "rss-a", postsPerWeek: 3 }),
        source({ id: "rss-b", postsPerWeek: 2, enabled: false }),
      ],
      companyContentPostsPerWeek: null,
    });
    assert.equal(
      quotas?.some((q) => q.sourceId === "rss-b"),
      false
    );
    const effective = transferExhaustedQuotas({
      quotas: quotas ?? [],
      generatedBySource: counts(),
      exhausted: new Set(["rss-a"]),
    });
    assert.deepEqual(effective, quotas, "no candidate exists, so nothing moved");
  });

  it("never takes from or gives to company content", () => {
    // Mission posts do not run out, and a feed's shortfall must not silently
    // become more brand copy than the owner asked for.
    const effective = transferExhaustedQuotas({
      quotas: [
        quota("rss-a", 2),
        quota("rss-b", 2),
        { sourceId: COMPANY_CONTENT_SOURCE_ID, postsPerWeek: 1 },
      ],
      generatedBySource: counts(),
      exhausted: new Set(["rss-a", COMPANY_CONTENT_SOURCE_ID]),
    });
    assert.equal(quotaFor(effective, COMPANY_CONTENT_SOURCE_ID), 1, "company quota is untouched");
    assert.equal(quotaFor(effective, "rss-b"), 4, "the RSS shortfall went to the RSS source");
  });

  it("leaves the shortfall unfilled when no candidate remains — the skip outcome", () => {
    const quotas = [quota("rss-a", 3), quota("rss-b", 2)];
    const effective = transferExhaustedQuotas({
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
      quotas: [quota("rss-a", 3), quota("rss-b", 2)],
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
    const quotas = [quota("rss-a", 3), quota("rss-b", 2)];
    transferExhaustedQuotas({
      quotas,
      generatedBySource: counts([["rss-a", 1]]),
      exhausted: new Set(["rss-a"]),
    });
    assert.equal(quotaFor(quotas, "rss-a"), 3);
    assert.equal(quotaFor(quotas, "rss-b"), 2);
  });

  it("is deterministic — the same inputs always yield the same transfer", () => {
    const input = {
      quotas: [quota("rss-a", 3), quota("rss-b", 1), quota("rss-c", 1)],
      generatedBySource: counts(),
      exhausted: new Set(["rss-a"]),
    };
    assert.deepEqual(transferExhaustedQuotas(input), transferExhaustedQuotas(input));
  });
});

// ─── nextDueQuota — transferred quotas ────────────────────────────────────────

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

describe("nextDueQuota — transferred quotas", () => {
  it("still hits the weekly post count when a source runs dry", () => {
    // RSS A=3 + RSS B=2 with only 1 article in A: the week owes 5 posts and
    // must deliver 5, as A=1 and B=4.
    const order = drainWithStock([quota("rss-a", 3), quota("rss-b", 2)], new Map([["rss-a", 1]]));
    assert.equal(order.length, 5);
    assert.equal(order.filter((s) => s === "rss-a").length, 1);
    assert.equal(order.filter((s) => s === "rss-b").length, 4);
  });

  it("balances the extra posts across candidates over a whole week", () => {
    // RSS A is dry from the start; B and C both have plenty, so they finish
    // level rather than B absorbing all of A's quota.
    const order = drainWithStock(
      [quota("rss-a", 2), quota("rss-b", 2), quota("rss-c", 2)],
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
      [quota("rss-a", 3), quota("rss-b", 2)],
      new Map([
        ["rss-a", 1],
        ["rss-b", 3],
      ])
    );
    assert.equal(order.length, 4);
  });

  it("resumes mid-week from posts an earlier run already wrote", () => {
    // The cron budget is 3 LLM calls/run, so the transfer must be re-derived on
    // the next run from stored posts alone — it is never persisted.
    const due = nextDueQuota({
      quotas: [quota("rss-a", 3), quota("rss-b", 2)],
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
        ["rss-a", 4],
        ["rss-b", 0],
      ])
    );
    assert.equal(projected.find((s) => s.id === "rss-a")?.postsPerWeek, 4);
    assert.equal(projected.find((s) => s.id === "rss-b")?.postsPerWeek, 0);
  });

  it("leaves omitted sources on their stored quota", () => {
    // A client with a stale source list must not wipe a quota it never showed.
    const projected = projectMixSources(BRIEF_SOURCES, new Map([["rss-a", 4]]));
    assert.equal(projected.find((s) => s.id === "rss-b")?.postsPerWeek, 1);
  });

  it("clears a quota when null is submitted", () => {
    const projected = projectMixSources(BRIEF_SOURCES, new Map([["rss-a", null]]));
    assert.equal(projected.find((s) => s.id === "rss-a")?.postsPerWeek, null);
  });

  it("does not mutate the input", () => {
    projectMixSources(BRIEF_SOURCES, new Map([["rss-a", 4]]));
    assert.equal(BRIEF_SOURCES.find((s) => s.id === "rss-a")?.postsPerWeek, 3);
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

// ─── scaleMixToTotal ──────────────────────────────────────────────────────────

describe("scaleMixToTotal", () => {
  it("leaves a mix that already matches the total alone", () => {
    assert.deepEqual(scaleMixToTotal(BRIEF_QUOTAS, 5), BRIEF_QUOTAS);
  });

  it("keeps the proportions when scaling up", () => {
    // 3/1/1 doubled is 6/2/2 exactly — no remainder to hand out.
    assert.deepEqual(
      scaleMixToTotal(BRIEF_QUOTAS, 10).map((q) => q.postsPerWeek),
      [6, 2, 2]
    );
  });

  it("hands the indivisible remainder to the largest fractions, in list order", () => {
    // 3/1/1 over 4 is 2.4/0.8/0.8: floors give 2/0/0 and two posts are left, so
    // the two 0.8s take one each. The earlier quota wins the tie, which is what
    // makes the same mix scale the same way every time.
    assert.deepEqual(
      scaleMixToTotal(BRIEF_QUOTAS, 4).map((q) => q.postsPerWeek),
      [2, 1, 1]
    );
  });

  it("can scale a quota down to nothing rather than rounding it up", () => {
    // 3/1/1 over 3 is 1.8/0.6/0.6 — the two posts left go to the largest
    // fractions, and company content writes nothing in a batch this small.
    // Rounding it up to 1 would take that post off the source weighted highest.
    assert.deepEqual(
      scaleMixToTotal(BRIEF_QUOTAS, 3).map((q) => q.postsPerWeek),
      [2, 1, 0]
    );
  });

  it("always adds up to the requested total", () => {
    for (let total = 1; total <= 10; total++) {
      const scaled = scaleMixToTotal(BRIEF_QUOTAS, total);
      assert.equal(contentMixTotal(scaled), total, `scaling to ${total}`);
    }
  });

  it("never gives posts to a quota of zero", () => {
    const quotas: MixQuota[] = [
      { sourceId: "rss-a", postsPerWeek: 3 },
      { sourceId: "rss-b", postsPerWeek: 0 },
    ];
    // Zero is a deliberate "not this source" — scaling must not smuggle it back
    // into the run.
    for (let total = 1; total <= 10; total++) {
      assert.equal(scaleMixToTotal(quotas, total)[1].postsPerWeek, 0, `scaling to ${total}`);
    }
  });

  it("scales an empty recipe to zeros rather than inventing an even split", () => {
    const quotas: MixQuota[] = [
      { sourceId: "rss-a", postsPerWeek: 0 },
      { sourceId: COMPANY_CONTENT_SOURCE_ID, postsPerWeek: 0 },
    ];
    assert.deepEqual(
      scaleMixToTotal(quotas, 4).map((q) => q.postsPerWeek),
      [0, 0]
    );
  });

  it("treats an unusable total as nothing to distribute", () => {
    // A half-typed number in a form is a mix that does not add up yet, not a throw.
    for (const total of [0, -3, 2.5, Number.NaN]) {
      assert.deepEqual(
        scaleMixToTotal(BRIEF_QUOTAS, total).map((q) => q.postsPerWeek),
        [0, 0, 0],
        `total ${total}`
      );
    }
  });

  it("does not mutate the quotas it was given", () => {
    scaleMixToTotal(BRIEF_QUOTAS, 9);
    assert.deepEqual(
      BRIEF_QUOTAS.map((q) => q.postsPerWeek),
      [3, 1, 1]
    );
  });
});

// ─── mixForChannel — the recipe as one channel's week ─────────────────────────

describe("mixForChannel", () => {
  it("gives a channel exactly its own postsPerWeek", () => {
    // The rule the whole feature hangs on: the recipe decides the split, the
    // channel decides the size. A mix totalling 5 does not hold a 7-post channel
    // to 5, and never replaces the channel's target.
    for (const target of [1, 3, 5, 7]) {
      assert.equal(
        contentMixTotal(mixForChannel(BRIEF_QUOTAS, target)),
        target,
        `channel target ${target}`
      );
    }
  });

  it("splits Facebook=5 and Instagram=7 along the same proportions", () => {
    // The two-channel example end to end. One recipe, two cadences, nothing to
    // reconcile: 3/1/1 at 5 posts is itself; at 7 posts it is 4/2/1.
    assert.deepEqual(
      mixForChannel(BRIEF_QUOTAS, 5).map((q) => q.postsPerWeek),
      [3, 1, 1]
    );
    assert.deepEqual(
      mixForChannel(BRIEF_QUOTAS, 7).map((q) => q.postsPerWeek),
      [4, 2, 1]
    );
  });

  it("keeps every quota on its own source", () => {
    assert.deepEqual(
      mixForChannel(BRIEF_QUOTAS, 7).map((q) => q.sourceId),
      ["rss-a", "rss-b", COMPANY_CONTENT_SOURCE_ID]
    );
  });

  it("caps a channel asking for more than a week may hold", () => {
    assert.equal(contentMixTotal(mixForChannel(BRIEF_QUOTAS, 100)), MAX_POSTS_PER_CHANNEL_PER_WEEK);
  });

  it("is deterministic, so a run resuming mid-week re-derives the same split", () => {
    // Nothing about the scaling is stored — every cron run recomputes it from
    // the recipe and the channel's target alone.
    assert.deepEqual(mixForChannel(BRIEF_QUOTAS, 7), mixForChannel(BRIEF_QUOTAS, 7));
  });

  it("gives a channel of zero an empty week", () => {
    assert.equal(contentMixTotal(mixForChannel(BRIEF_QUOTAS, 0)), 0);
  });

  it("gives an all-zero recipe an empty week rather than an invented split", () => {
    const empty: MixQuota[] = [
      { sourceId: "rss-a", postsPerWeek: 0 },
      { sourceId: "rss-b", postsPerWeek: 0 },
    ];
    assert.deepEqual(
      mixForChannel(empty, 5).map((q) => q.postsPerWeek),
      [0, 0]
    );
  });

  it("never resurrects a source the owner set to zero", () => {
    const quotas: MixQuota[] = [
      { sourceId: "rss-a", postsPerWeek: 3 },
      { sourceId: "rss-b", postsPerWeek: 0 },
    ];
    for (let target = 1; target <= MAX_POSTS_PER_CHANNEL_PER_WEEK; target++) {
      assert.equal(mixForChannel(quotas, target)[1].postsPerWeek, 0, `target ${target}`);
    }
  });

  it("does not mutate the stored recipe", () => {
    mixForChannel(BRIEF_QUOTAS, 7);
    assert.deepEqual(
      BRIEF_QUOTAS.map((q) => q.postsPerWeek),
      [3, 1, 1]
    );
  });
});
