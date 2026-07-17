import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateWeeklySchedule,
  nextWeekStart,
  type GenerateWeeklyScheduleDb,
  type GenerateWeeklyScheduleDeps,
} from "./generate-weekly-schedule.service";
import type { GenerationContext } from "@/lib/ai/types";
import type { GenerateDraftPostResult } from "@/lib/services/ai/generate-draft-post.service";
import type { SourceScope } from "@/lib/services/ai/build-generation-context.service";

// ─── In-memory doubles ────────────────────────────────────────────────────────
//
// The fakes model the two behaviours the scheduler actually depends on:
//   • an article pool per source that empties as posts are generated, so
//     "exhausted" is reached the same way it is in production;
//   • posts accumulating on the schedule, so a second run resumes from real
//     persisted state rather than a hand-written count.
//
// Generation itself is stubbed — the LLM, reservation, and duplicate guards are
// covered by their own tests. What is under test here is the distribution.

const COMPANY_ID = "company-1";
const SCHEDULE_ID = "schedule-1";

interface FakeSource {
  id: string;
  name: string;
  enabled: boolean;
  postsPerWeek: number | null;
  /** Unused articles left in this source. Evergreen sources use Infinity. */
  articles: number;
}

interface FakeChannel {
  channel: string;
  postsPerWeek: number;
}

interface RecordedPost {
  channel: string;
  contentSourceId: string | null;
  scheduledFor: Date | undefined;
}

class Harness {
  posts: RecordedPost[] = [];
  scheduleStatus = "generating";
  generatedAt: Date | null = null;
  /** Every scope the scheduler asked a context for, in order. */
  scopes: Array<SourceScope | undefined> = [];
  /** Forces generation to fail with this code once, then clears. */
  failNextWith: GenerateDraftPostResult | null = null;

  constructor(
    readonly sources: FakeSource[],
    private companyContentPostsPerWeek: number | null,
    private channels: FakeChannel[] = [{ channel: "facebook", postsPerWeek: 5 }]
  ) {}

  private source(id: string): FakeSource | undefined {
    return this.sources.find((s) => s.id === id);
  }

  db: GenerateWeeklyScheduleDb = {
    channelConfig: {
      findMany: async () =>
        this.channels.map((c) => ({
          channel: c.channel,
          postsPerWeek: c.postsPerWeek,
          postingLanguage: "en",
          postingWindows: null,
        })),
    },
    weeklySchedule: {
      upsert: async () => ({ id: SCHEDULE_ID, status: this.scheduleStatus }),
      update: async (args) => {
        this.scheduleStatus = args.data.status;
        this.generatedAt = args.data.generatedAt;
        return {};
      },
    },
    company: {
      findUnique: async () => ({ companyContentPostsPerWeek: this.companyContentPostsPerWeek }),
    },
    contentSource: {
      findMany: async () =>
        this.sources.map((s) => ({
          id: s.id,
          name: s.name,
          enabled: s.enabled,
          postsPerWeek: s.postsPerWeek,
        })),
    },
    post: {
      findMany: async () =>
        this.posts.map((p) => ({ channel: p.channel, contentSourceId: p.contentSourceId })),
    },
  };

  /** Mirrors the real builder's scoping: which articles can this scope see? */
  buildContext = async (companyId: string, channel: string, scope?: SourceScope) => {
    this.scopes.push(scope);

    let available = 0;
    if (scope?.kind === "source") {
      available = this.source(scope.sourceId)?.articles ?? 0;
    } else if (scope?.kind === "company_content") {
      available = 0; // a mission slot draws from no source
    } else {
      available = this.sources
        .filter((s) => s.enabled)
        .reduce((sum, s) => sum + Math.min(s.articles, 5), 0);
    }

    const feedItems = Array.from({ length: Math.min(available, 5) }, (_, i) => ({
      id: `${scope?.kind === "source" ? scope.sourceId : "pooled"}-item-${i}`,
      title: "Article",
      content: "Body",
      url: "https://example.com/a",
      publishedAt: null,
      consumable: true,
    }));

    const context: GenerationContext = {
      company: {
        name: "Acme",
        website: null,
        automationMode: "semi_automated",
        defaultLang: "en",
      },
      brand: null,
      channel: {
        channel,
        postingLanguage: "en",
        imageRequired: false,
        automationModeOverride: null,
        maxTextLength: null,
        includeSourceLink: false,
        autoGenerateImage: false,
      },
      feedItems,
      hasArticleSources: feedItems.length > 0,
    };

    return { success: true as const, context, companyId };
  };

  generate = async (
    _context: GenerationContext,
    _companyId: string,
    options: { contentSourceId?: string | null; channel?: string; scheduledFor?: Date } = {}
  ): Promise<GenerateDraftPostResult> => {
    if (this.failNextWith) {
      const failure = this.failNextWith;
      this.failNextWith = null;
      return failure;
    }

    const sourceId = options.contentSourceId ?? null;
    if (sourceId !== null) {
      const source = this.source(sourceId);
      // The real service returns this when every article is already claimed.
      if (!source || source.articles <= 0) {
        return { success: false, code: "NO_FEED_ITEMS_AVAILABLE" };
      }
      source.articles--;
    }

    this.posts.push({
      channel: _context.channel.channel,
      contentSourceId: sourceId,
      scheduledFor: options.scheduledFor,
    });

    return {
      success: true,
      post: {
        id: `post-${this.posts.length}`,
        companyId: COMPANY_ID,
        channel: _context.channel.channel,
        status: "PENDING_APPROVAL",
        text: "Generated",
        hashtags: [],
        imagePrompt: null,
        notes: null,
        llmProvider: "mock",
        llmModel: "mock",
        mediaUrl: null,
        createdAt: new Date(),
      },
      warnings: {
        duplicate: { flagged: false, similarityScore: null, matchedPostId: null },
        safety: { flagged: false, matchedTerms: [] },
        semanticDuplicate: {
          decision: "accept",
          topSimilarity: null,
          matchedPostId: null,
          exhausted: false,
          skipped: true,
        },
      },
    };
  };

  deps(): GenerateWeeklyScheduleDeps {
    return {
      db: this.db,
      buildContext: this.buildContext as GenerateWeeklyScheduleDeps["buildContext"],
      generate: this.generate as GenerateWeeklyScheduleDeps["generate"],
      now: () => new Date("2026-07-16T12:00:00.000Z"),
    };
  }

  /** Posts generated for a given quota. sourceId null = company content. */
  countFor(sourceId: string | null): number {
    return this.posts.filter((p) => p.contentSourceId === sourceId).length;
  }
}

/** The brief's example: 5 posts/week = RSS A 3 + RSS B 1 + company content 1. */
function briefHarness(overrides: Partial<Record<"aArticles" | "bArticles", number>> = {}) {
  return new Harness(
    [
      {
        id: "rss-a",
        name: "RSS A",
        enabled: true,
        postsPerWeek: 3,
        articles: overrides.aArticles ?? 10,
      },
      {
        id: "rss-b",
        name: "RSS B",
        enabled: true,
        postsPerWeek: 1,
        articles: overrides.bArticles ?? 10,
      },
    ],
    1
  );
}

/** Runs the scheduler until it stops making progress (budget is 3 posts/run). */
async function runUntilSettled(harness: Harness, maxRuns = 6) {
  let last = await generateWeeklySchedule(COMPANY_ID, harness.deps());
  for (let i = 1; i < maxRuns; i++) {
    const before = harness.posts.length;
    const summary = await generateWeeklySchedule(COMPANY_ID, harness.deps());
    last = summary;
    if (harness.posts.length === before) break;
  }
  return last;
}

// ─── Scheduler respects quotas ────────────────────────────────────────────────

describe("generateWeeklySchedule — respects the configured distribution", () => {
  it("generates exactly the configured mix over the week", async () => {
    const harness = briefHarness();
    await runUntilSettled(harness);

    assert.equal(harness.posts.length, 5);
    assert.equal(harness.countFor("rss-a"), 3);
    assert.equal(harness.countFor("rss-b"), 1);
    assert.equal(harness.countFor(null), 1, "company content");
  });

  it("reports the mix as configured", async () => {
    const harness = briefHarness();
    const summary = await generateWeeklySchedule(COMPANY_ID, harness.deps());
    assert.equal(summary.mixConfigured, true);
  });

  it("scopes each generation to the source whose quota is due", async () => {
    const harness = briefHarness();
    await runUntilSettled(harness);

    // Every context request is scoped — never pooled — once a mix exists.
    assert.equal(
      harness.scopes.every((s) => s?.kind === "source" || s?.kind === "company_content"),
      true
    );
    assert.equal(
      harness.scopes.filter((s) => s?.kind === "source" && s.sourceId === "rss-a").length,
      3
    );
    assert.equal(
      harness.scopes.filter((s) => s?.kind === "source" && s.sourceId === "rss-b").length,
      1
    );
    assert.equal(harness.scopes.filter((s) => s?.kind === "company_content").length, 1);
  });

  it("marks the schedule ready once every quota is filled", async () => {
    const harness = briefHarness();
    const summary = await runUntilSettled(harness);
    assert.equal(summary.postsRemaining, 0);
    assert.equal(summary.scheduleStatus, "ready");
  });

  it("respects the per-run LLM budget and resumes on the next run", async () => {
    const harness = briefHarness();

    const first = await generateWeeklySchedule(COMPANY_ID, harness.deps());
    assert.equal(first.postsGenerated, 3, "budget is 3 generations per run");
    assert.equal(first.postsRemaining, 2);
    assert.equal(first.scheduleStatus, "generating");

    const second = await generateWeeklySchedule(COMPANY_ID, harness.deps());
    assert.equal(second.postsGenerated, 2);
    assert.equal(harness.posts.length, 5);
    assert.equal(harness.countFor("rss-a"), 3);
  });

  it("does not re-generate a quota already filled in an earlier run", async () => {
    const harness = briefHarness();
    await runUntilSettled(harness);
    const settled = harness.posts.length;

    await generateWeeklySchedule(COMPANY_ID, harness.deps());
    assert.equal(harness.posts.length, settled, "a settled week generates nothing further");
  });

  it("applies the same recipe to every enabled channel", async () => {
    const harness = new Harness(
      [
        {
          id: "rss-a",
          name: "RSS A",
          enabled: true,
          postsPerWeek: 2,
          articles: 20,
        },
      ],
      1,
      [
        { channel: "facebook", postsPerWeek: 3 },
        { channel: "linkedin", postsPerWeek: 3 },
      ]
    );
    await runUntilSettled(harness, 10);

    for (const channel of ["facebook", "linkedin"]) {
      const forChannel = harness.posts.filter((p) => p.channel === channel);
      assert.equal(forChannel.length, 3, `${channel} fills its target`);
      assert.equal(forChannel.filter((p) => p.contentSourceId === "rss-a").length, 2);
      assert.equal(forChannel.filter((p) => p.contentSourceId === null).length, 1);
    }
  });
});

// ─── Exhausted RSS source ─────────────────────────────────────────────────────

describe("generateWeeklySchedule — exhausted RSS source", () => {
  it("hands a dry source's quota to the other RSS source and still hits the target", async () => {
    // RSS A=3 is dry, so RSS B writes A's 3 on top of its own 1. The week still
    // produces 5 posts; company content is untouched at its own 1.
    const harness = briefHarness({ aArticles: 0 });
    await runUntilSettled(harness);

    assert.equal(harness.countFor("rss-a"), 0, "a dry source generates nothing");
    assert.equal(harness.countFor("rss-b"), 4, "rss-b takes its own 1 plus A's 3");
    assert.equal(harness.countFor(null), 1, "company content keeps exactly its own quota");
    assert.equal(harness.posts.length, 5);
  });

  it("partially fills a source that runs dry mid-week and moves the rest", async () => {
    const harness = briefHarness({ aArticles: 1 });
    await runUntilSettled(harness);

    assert.equal(harness.countFor("rss-a"), 1, "generates the one article it had");
    assert.equal(harness.countFor("rss-b"), 3, "its own 1 plus A's 2 leftovers");
    assert.equal(harness.countFor(null), 1);
    assert.equal(harness.posts.length, 5);
  });

  it("reports the exhausted quota without failing the run", async () => {
    const harness = briefHarness({ aArticles: 0 });
    const first = await generateWeeklySchedule(COMPANY_ID, harness.deps());

    assert.deepEqual(first.failures, [], "exhaustion is not a failure");
    assert.equal(
      first.exhaustedQuotas.some((q) => q.sourceId === "rss-a"),
      true
    );
  });

  it("keeps the schedule generating so a later run can retry after ingestion", async () => {
    // Both feeds dry: only company content can be written, so 4 posts stay
    // outstanding. Articles may still arrive later in the week.
    const harness = briefHarness({ aArticles: 0, bArticles: 0 });
    const summary = await runUntilSettled(harness);

    assert.equal(harness.posts.length, 1, "company content only");
    assert.equal(summary.postsRemaining, 4);
    assert.equal(summary.scheduleStatus, "generating");
  });

  it("picks the sources back up once ingestion delivers new articles", async () => {
    const harness = briefHarness({ aArticles: 0, bArticles: 0 });
    await runUntilSettled(harness);
    assert.equal(harness.countFor("rss-a"), 0);

    // Simulate the ingest step fetching new articles mid-week.
    harness.sources.find((s) => s.id === "rss-a")!.articles = 5;

    const summary = await runUntilSettled(harness);
    assert.equal(harness.countFor("rss-a"), 4, "its own 3 plus B's 1, which is still dry");
    assert.equal(summary.scheduleStatus, "ready");
  });

  it("does not spend LLM budget discovering an exhausted source", async () => {
    // rss-a is dry. Finding that out costs no LLM call, so the run still spends
    // its whole 3-generation budget on posts that can actually be written.
    const harness = briefHarness({ aArticles: 0 });
    const summary = await generateWeeklySchedule(COMPANY_ID, harness.deps());
    assert.equal(summary.postsGenerated, 3);
  });
});

// ─── Company-content quota ────────────────────────────────────────────────────

describe("generateWeeklySchedule — company-content quota", () => {
  it("draws company-content posts with no source attached", async () => {
    const harness = briefHarness();
    await runUntilSettled(harness);

    const missionPosts = harness.posts.filter((p) => p.contentSourceId === null);
    assert.equal(missionPosts.length, 1);
  });

  it("requests a company_content scope, never a source scope, for that quota", async () => {
    const harness = briefHarness();
    await runUntilSettled(harness);
    assert.equal(harness.scopes.filter((s) => s?.kind === "company_content").length, 1);
  });

  it("fills a mix that is entirely company content", async () => {
    const harness = new Harness([], 3);
    const summary = await runUntilSettled(harness);

    assert.equal(harness.posts.length, 3);
    assert.equal(harness.countFor(null), 3);
    assert.equal(summary.scheduleStatus, "ready");
  });

  it("never lets an RSS quota spill into company content", async () => {
    // RSS A is dry. Its 3 posts must NOT become extra mission posts.
    const harness = briefHarness({ aArticles: 0 });
    await runUntilSettled(harness);
    assert.equal(harness.countFor(null), 1, "company content keeps exactly its own quota");
  });

  it("honours a company-content quota of zero", async () => {
    const harness = new Harness(
      [
        {
          id: "rss-a",
          name: "RSS A",
          enabled: true,
          postsPerWeek: 5,
          articles: 20,
        },
      ],
      0
    );
    await runUntilSettled(harness);

    assert.equal(harness.countFor(null), 0, "zero means zero mission posts");
    assert.equal(harness.countFor("rss-a"), 5);
  });
});

// ─── Quota transfer when a source runs dry ───────────────────────────────────

describe("generateWeeklySchedule — quota transfer", () => {
  /** RSS A=3 + RSS B=2, no mission posts. */
  function transferHarness(aArticles: number, bArticles = 10) {
    return new Harness(
      [
        {
          id: "rss-a",
          name: "RSS A",
          enabled: true,
          postsPerWeek: 3,
          articles: aArticles,
        },
        {
          id: "rss-b",
          name: "RSS B",
          enabled: true,
          postsPerWeek: 2,
          articles: bArticles,
        },
      ],
      0
    );
  }

  it("keeps the weekly post count when a source runs dry", async () => {
    // The brief's example end to end: A=3 and B=2 but only 1 article in A, so
    // the week still publishes 5 posts — 1 from A, 4 from B.
    const harness = transferHarness(1);
    const summary = await runUntilSettled(harness);

    assert.equal(harness.posts.length, 5);
    assert.equal(harness.countFor("rss-a"), 1);
    assert.equal(harness.countFor("rss-b"), 4);
    assert.equal(summary.postsRemaining, 0);
    assert.equal(summary.scheduleStatus, "ready", "a transferred week still finishes");
  });

  it("reports the dry source as exhausted even though its posts were written", async () => {
    // exhaustedQuotas reports what ran dry, not what went unwritten — the run
    // that hits the empty feed is the one that says so.
    const harness = transferHarness(1);
    const first = await generateWeeklySchedule(COMPANY_ID, harness.deps());
    assert.equal(
      first.exhaustedQuotas.some((q) => q.sourceId === "rss-a"),
      true
    );
  });

  it("still generates nothing beyond the mix total", async () => {
    const harness = transferHarness(1);
    await runUntilSettled(harness);
    await generateWeeklySchedule(COMPANY_ID, harness.deps());
    assert.equal(harness.posts.length, 5, "a settled week generates nothing further");
  });

  it("leaves the week open when no source can absorb the shortfall", async () => {
    // Both feeds are dry, so there is nowhere to transfer to: skip and retry on
    // a later run, once ingestion has fetched more.
    const harness = transferHarness(0, 0);
    const summary = await runUntilSettled(harness);

    assert.equal(harness.posts.length, 0);
    assert.equal(summary.postsRemaining, 5, "the whole week is still owed");
    assert.equal(summary.scheduleStatus, "generating");
  });

  it("says why the week came up short instead of just being short", async () => {
    const harness = transferHarness(0, 0);
    const summary = await runUntilSettled(harness);

    assert.deepEqual(summary.shortfalls, [
      { channel: "facebook", posts: 5, reason: "NO_ELIGIBLE_SOURCE" },
    ]);
  });

  it("absorbs only what the receiving source can actually write", async () => {
    // A has 1 article and B has 3 for its topped-up quota of 4: 4 posts is all
    // the week can honestly produce, and the run must not spin trying for more.
    const harness = transferHarness(1, 3);
    const summary = await runUntilSettled(harness);

    assert.equal(harness.posts.length, 4);
    assert.equal(summary.postsRemaining, 1);
    assert.equal(summary.scheduleStatus, "generating");
    assert.deepEqual(summary.shortfalls, [
      { channel: "facebook", posts: 1, reason: "NO_ELIGIBLE_SOURCE" },
    ]);
  });

  it("reports no shortfall when the transfer filled the week", async () => {
    const harness = transferHarness(1);
    const summary = await runUntilSettled(harness);

    assert.equal(harness.posts.length, 5);
    assert.deepEqual(
      summary.shortfalls,
      [],
      "running dry is not a shortfall if someone covered it"
    );
  });

  it("does not call a budget-limited run a shortfall", async () => {
    // The first run stops at 3 posts because of the LLM budget, not because
    // anything ran dry. That is "more runs to come", not a failure to fill.
    const harness = transferHarness(10);
    const first = await generateWeeklySchedule(COMPANY_ID, harness.deps());

    assert.equal(first.postsGenerated, 3);
    assert.equal(first.postsRemaining, 2);
    assert.deepEqual(first.shortfalls, []);
  });

  it("never spills a dry RSS quota into company content", async () => {
    // The mission quota is not a dumping ground for a feed's shortfall, even
    // when the feed is explicitly configured to hand its posts on.
    const harness = briefHarness({ aArticles: 0 });
    await runUntilSettled(harness);

    assert.equal(harness.countFor(null), 1, "company content keeps exactly its own quota");
    assert.equal(harness.countFor("rss-b"), 4, "RSS A's 3 posts went to the other feed");
    assert.equal(harness.posts.length, 5);
  });

  it("balances the extra posts between two candidate sources", async () => {
    const harness = new Harness(
      [
        {
          id: "rss-a",
          name: "RSS A",
          enabled: true,
          postsPerWeek: 2,
          articles: 0,
        },
        {
          id: "rss-b",
          name: "RSS B",
          enabled: true,
          postsPerWeek: 2,
          articles: 10,
        },
        {
          id: "rss-c",
          name: "RSS C",
          enabled: true,
          postsPerWeek: 2,
          articles: 10,
        },
      ],
      0,
      [{ channel: "facebook", postsPerWeek: 6 }]
    );
    await runUntilSettled(harness);

    assert.equal(harness.posts.length, 6);
    assert.equal(harness.countFor("rss-b"), 3, "B and C share A's quota evenly");
    assert.equal(harness.countFor("rss-c"), 3);
  });

  it("never transfers to a disabled source", async () => {
    // B is disabled, so it is not a candidate however many articles it holds:
    // A's shortfall simply goes unwritten.
    const harness = new Harness(
      [
        {
          id: "rss-a",
          name: "RSS A",
          enabled: true,
          postsPerWeek: 3,
          articles: 1,
        },
        {
          id: "rss-b",
          name: "RSS B",
          enabled: false,
          postsPerWeek: 2,
          articles: 50,
        },
      ],
      0
    );
    const summary = await runUntilSettled(harness);

    assert.equal(harness.countFor("rss-b"), 0, "a disabled source never publishes");
    assert.equal(harness.posts.length, 1);
    assert.equal(summary.scheduleStatus, "generating");
  });
});

// ─── Backward compatibility ───────────────────────────────────────────────────

describe("generateWeeklySchedule — backward compatibility", () => {
  /** A pre-v2-8 company: sources exist, no quota anywhere. */
  function legacyHarness(channels?: FakeChannel[]) {
    return new Harness(
      [
        {
          id: "rss-a",
          name: "RSS A",
          enabled: true,
          postsPerWeek: null,
          articles: 20,
        },
        {
          id: "rss-b",
          name: "RSS B",
          enabled: true,
          postsPerWeek: null,
          articles: 20,
        },
      ],
      null,
      channels
    );
  }

  it("uses the pooled path when no mix is configured", async () => {
    const harness = legacyHarness();
    const summary = await generateWeeklySchedule(COMPANY_ID, harness.deps());

    assert.equal(summary.mixConfigured, false);
    assert.equal(
      harness.scopes.every((s) => s === undefined),
      true,
      "pooled generation passes no scope"
    );
  });

  it("still fills the channel target from the pool", async () => {
    const harness = legacyHarness();
    await runUntilSettled(harness);

    assert.equal(harness.posts.length, 5, "channelConfig.postsPerWeek still drives the target");
    assert.equal(harness.countFor(null), 5, "pooled posts carry no source attribution");
  });

  it("leaves pooled posts untagged so they cannot be mistaken for a quota", async () => {
    const harness = legacyHarness();
    await runUntilSettled(harness);
    assert.equal(
      harness.posts.every((p) => p.contentSourceId === null),
      true
    );
  });

  it("caps the legacy target at the per-channel ceiling", async () => {
    const harness = legacyHarness([{ channel: "facebook", postsPerWeek: 100 }]);
    await runUntilSettled(harness, 10);
    assert.equal(harness.posts.length, 7, "MAX_POSTS_PER_CHANNEL_PER_WEEK");
  });

  it("skips a company with no enabled channels", async () => {
    const harness = legacyHarness([]);
    const summary = await generateWeeklySchedule(COMPANY_ID, harness.deps());

    assert.equal(summary.scheduleStatus, "skipped");
    assert.equal(summary.postsGenerated, 0);
    assert.equal(harness.posts.length, 0);
  });

  it("does nothing when the schedule is already ready", async () => {
    const harness = legacyHarness();
    harness.scheduleStatus = "ready";
    const summary = await generateWeeklySchedule(COMPANY_ID, harness.deps());

    assert.equal(summary.scheduleStatus, "ready");
    assert.equal(harness.posts.length, 0);
  });

  it("treats a disabled source's stale quota as no mix at all", async () => {
    // A quota on a disabled source must not switch the company onto the mix path.
    const harness = new Harness(
      [
        {
          id: "rss-a",
          name: "RSS A",
          enabled: false,
          postsPerWeek: 3,
          articles: 20,
        },
        {
          id: "rss-b",
          name: "RSS B",
          enabled: true,
          postsPerWeek: null,
          articles: 20,
        },
      ],
      null
    );
    const summary = await generateWeeklySchedule(COMPANY_ID, harness.deps());
    assert.equal(summary.mixConfigured, false);
  });
});

// ─── Failure handling ─────────────────────────────────────────────────────────

describe("generateWeeklySchedule — failures", () => {
  it("records a generation failure and stops burning budget", async () => {
    const harness = briefHarness();
    harness.failNextWith = {
      success: false,
      code: "LLM_PROVIDER_ERROR",
      message: "provider exploded",
    };

    const summary = await generateWeeklySchedule(COMPANY_ID, harness.deps());
    assert.equal(summary.failures.length, 1);
    assert.equal(summary.failures[0].message, "provider exploded");
    assert.equal(summary.scheduleStatus, "generating", "a failed run never marks the week ready");
  });
});

// ─── Week boundary ────────────────────────────────────────────────────────────

describe("nextWeekStart", () => {
  it("returns the Monday after the given date", () => {
    // 2026-07-16 is a Thursday → the following Monday is 2026-07-20.
    assert.equal(
      nextWeekStart(new Date("2026-07-16T12:00:00.000Z")).toISOString(),
      "2026-07-20T00:00:00.000Z"
    );
  });

  it("moves to the next Monday when given a Monday", () => {
    assert.equal(
      nextWeekStart(new Date("2026-07-20T00:00:00.000Z")).toISOString(),
      "2026-07-27T00:00:00.000Z"
    );
  });

  it("handles Sunday without slipping a week", () => {
    assert.equal(
      nextWeekStart(new Date("2026-07-19T23:59:59.000Z")).toISOString(),
      "2026-07-20T00:00:00.000Z"
    );
  });
});
