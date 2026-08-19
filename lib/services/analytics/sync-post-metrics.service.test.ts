import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { syncPostMetrics } from "./sync-post-metrics.service";
import { observationColumns, type MetricsSyncStore, type SelectPostsInput, type RecordOutcomeInput, type SyncablePost } from "./_metrics-sync-store"; // prettier-ignore
import type { BufferAnalyticsClient } from "@/lib/buffer/buffer-analytics-client";
import { AnalyticsRateLimitError } from "@/lib/buffer/buffer-analytics-errors";
import type { NormalizedMetrics } from "@/lib/buffer/metric-normalizer";

/**
 * Two things are pinned here, both of which used to be wrong:
 *
 *  1. COVERAGE. A run reads the stalest posts, never the newest ones again, so
 *     repeated runs eventually reach every eligible post. The old ordering
 *     (publishedAt desc) meant a company with more posts than one batch had its
 *     older posts refreshed exactly never — and with the manual refresh button
 *     gone there was nothing an owner could do about it.
 *
 *  2. DATA SAFETY. A failed read records the failure without erasing the figures
 *     a previous read stored.
 *
 * The batching strategy is exercised through an in-memory store implementing the
 * same contract as the Prisma one, because the property that matters — "run it
 * often enough and everything gets read" — is a property of the loop across runs,
 * not of any single query.
 */

// ─── In-memory store ──────────────────────────────────────────────────────────

interface FakePost {
  id: string;
  bufferUpdateId: string;
  /** Newest first when this is higher — stands in for publishedAt. */
  published: number;
  /** null = never read. Mirrors post_metrics.collected_at. */
  collectedAt: Date | null;
}

/**
 * Implements MetricsSyncStore over plain arrays, with the same semantics as the
 * Prisma queries in _metrics-sync-store.ts: never-read posts first, then the
 * least-recently-read, and anything already read today excluded.
 */
class FakeStore implements MetricsSyncStore {
  readonly posts: FakePost[];
  readonly reads: string[] = [];
  /** Every outcome as recorded, so a test can assert what would be persisted. */
  readonly outcomes: RecordOutcomeInput[] = [];
  keyValidAt: Date | null = null;

  constructor(posts: FakePost[]) {
    this.posts = posts;
  }

  async selectPosts({ companyId, limit, before }: SelectPostsInput): Promise<SyncablePost[]> {
    void companyId;
    if (limit <= 0) return [];

    if (before === null) {
      return [...this.posts]
        .sort((a, b) => b.published - a.published)
        .slice(0, limit)
        .map(toSyncable);
    }

    const never = [...this.posts]
      .filter((p) => p.collectedAt === null)
      .sort((a, b) => b.published - a.published);
    if (never.length >= limit) return never.slice(0, limit).map(toSyncable);

    const stale = this.posts
      .filter((p) => p.collectedAt !== null && p.collectedAt.getTime() < before.getTime())
      .sort((a, b) => a.collectedAt!.getTime() - b.collectedAt!.getTime());

    return [...never, ...stale.slice(0, limit - never.length)].map(toSyncable);
  }

  async recordOutcome(input: RecordOutcomeInput): Promise<void> {
    this.reads.push(input.postId);
    this.outcomes.push(input);
    const post = this.posts.find((p) => p.id === input.postId);
    // Every outcome stamps collectedAt — including failures. That is what stops a
    // post that always errors from being handed to every run forever.
    if (post) post.collectedAt = input.collectedAt;
  }

  async stampKeyValid(_companyId: string, at: Date): Promise<void> {
    this.keyValidAt = at;
  }

  async countRemaining(_companyId: string, before: Date): Promise<number> {
    return this.posts.filter(
      (p) => p.collectedAt === null || p.collectedAt.getTime() < before.getTime()
    ).length;
  }

  async countReadToday(_companyId: string, before: Date): Promise<number> {
    return this.posts.filter(
      (p) => p.collectedAt !== null && p.collectedAt.getTime() >= before.getTime()
    ).length;
  }
}

function toSyncable(p: FakePost): SyncablePost {
  return { id: p.id, bufferUpdateId: p.bufferUpdateId };
}

/** `count` posts, newest first, all previously read at `collectedAt`. */
function posts(count: number, collectedAt: Date | null): FakePost[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `post-${i + 1}`,
    bufferUpdateId: `buffer-${i + 1}`,
    published: count - i,
    collectedAt,
  }));
}

// ─── Fake Buffer ──────────────────────────────────────────────────────────────

/** Always answers with real figures. */
function okClient(): BufferAnalyticsClient {
  return {
    getPostMetrics: async (bufferPostId: string) => ({
      status: "ok" as const,
      bufferPostId,
      channelService: "facebook",
      metrics: [{ type: "reactions", name: "Reactions", value: 5, unit: "count" }],
      metricsUpdatedAt: null,
    }),
  } as unknown as BufferAnalyticsClient;
}

function throwingClient(err: Error): BufferAnalyticsClient {
  return {
    getPostMetrics: async () => {
      throw err;
    },
  } as unknown as BufferAnalyticsClient;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const COMPANY = "company-1";

/** Runs one cron-style sync on the given day. */
async function run(
  store: FakeStore,
  day: Date,
  limit: number,
  over: Partial<Parameters<typeof syncPostMetrics>[0]> = {}
) {
  return syncPostMetrics({
    companyId: COMPANY,
    limit,
    store,
    client: okClient(),
    now: day,
    ...over,
  });
}

let store: FakeStore;

describe("syncPostMetrics — coverage across repeated runs", () => {
  const yesterday = new Date("2026-08-05T09:00:00");
  const today = new Date("2026-08-06T09:00:00");

  beforeEach(() => {
    store = new FakeStore(posts(50, yesterday));
  });

  it("eventually reads every eligible post, however small the batch", async () => {
    // 50 posts, 15 per run — the exact shape that used to leave posts 16-50
    // permanently unread, because every run re-read the same newest 15.
    let guard = 0;
    let remaining = Infinity;
    while (remaining > 0 && guard++ < 20) {
      remaining = (await run(store, today, 15)).remaining;
    }

    assert.equal(remaining, 0);
    assert.equal(new Set(store.reads).size, 50, "every post read at least once");
  });

  it("never spends two requests on the same post in one day", async () => {
    for (let i = 0; i < 5; i++) await run(store, today, 15);

    // 50 posts, 5 runs of 15 = 75 slots. Everything is read exactly once and the
    // spare slots cost nothing, which is what makes extra runs per day safe.
    assert.equal(store.reads.length, 50);
    assert.equal(new Set(store.reads).size, 50);
  });

  it("takes the stalest posts first, not the newest", async () => {
    // post-1 is the newest and was read today; the rest are a week stale.
    store = new FakeStore([
      { id: "post-1", bufferUpdateId: "b1", published: 3, collectedAt: today },
      { id: "post-2", bufferUpdateId: "b2", published: 2, collectedAt: new Date(today.getTime() - 7 * DAY_MS) }, // prettier-ignore
      { id: "post-3", bufferUpdateId: "b3", published: 1, collectedAt: new Date(today.getTime() - 3 * DAY_MS) }, // prettier-ignore
    ]);

    await run(store, today, 1);
    assert.deepEqual(store.reads, ["post-2"]);
  });

  it("puts never-read posts ahead of merely stale ones", async () => {
    store = new FakeStore([
      { id: "stale", bufferUpdateId: "b1", published: 2, collectedAt: new Date(today.getTime() - 30 * DAY_MS) }, // prettier-ignore
      { id: "fresh-never-read", bufferUpdateId: "b2", published: 1, collectedAt: null },
    ]);

    await run(store, today, 1);
    // A post showing an owner nothing at all outranks one showing month-old figures.
    assert.deepEqual(store.reads, ["fresh-never-read"]);
  });

  it("resumes where the previous run stopped rather than starting over", async () => {
    await run(store, today, 10);
    const firstPass = [...store.reads];

    await run(store, today, 10);
    const secondPass = store.reads.slice(10);

    assert.equal(firstPass.length, 10);
    assert.equal(secondPass.length, 10);
    // No overlap: the second run continued into the backlog.
    assert.equal(firstPass.filter((id) => secondPass.includes(id)).length, 0);
  });

  it("carries the backlog into the next day instead of losing it", async () => {
    // One run per day, 20 of 50 posts each — the honest "a big backlog rotates"
    // case the settings card now describes.
    const day1 = await run(store, today, 20);
    assert.equal(day1.remaining, 30);

    const day2 = await run(store, new Date(today.getTime() + DAY_MS), 20);
    assert.equal(day2.examined, 20);
    assert.equal(new Set(store.reads).size, 40, "day two read 20 posts nobody had touched");
  });

  it("does not let a permanently failing post block the rest of the backlog", async () => {
    let call = 0;
    const flaky = {
      getPostMetrics: async (bufferPostId: string) => {
        // The first post of every run fails; the rest answer normally.
        if (++call % 15 === 1) throw new Error("Buffer unreachable");
        return {
          status: "ok" as const,
          bufferPostId,
          channelService: "facebook",
          metrics: [],
          metricsUpdatedAt: null,
        };
      },
    } as unknown as BufferAnalyticsClient;

    let guard = 0;
    let remaining = Infinity;
    while (remaining > 0 && guard++ < 20) {
      remaining = (await run(store, today, 15, { client: flaky })).remaining;
    }

    // A failed read still advances the cursor, so the failure costs that post its
    // figures for the day — not the whole company its coverage.
    assert.equal(remaining, 0);
    assert.equal(new Set(store.reads).size, 50);
  });
});

describe("syncPostMetrics — stopping early", () => {
  const today = new Date("2026-08-06T09:00:00");

  beforeEach(() => {
    store = new FakeStore(posts(20, new Date("2026-08-05T09:00:00")));
  });

  it("stops between posts and reports it, leaving the rest pending", async () => {
    let reads = 0;
    const result = await run(store, today, 20, {
      shouldStop: () => reads >= 5,
      client: {
        getPostMetrics: async (bufferPostId: string) => {
          reads++;
          return {
            status: "ok" as const,
            bufferPostId,
            channelService: null,
            metrics: [],
            metricsUpdatedAt: null,
          };
        },
      } as unknown as BufferAnalyticsClient,
    });

    assert.equal(result.stoppedEarly, true);
    assert.equal(result.examined, 5);
    // The abandoned posts keep their old collectedAt, so they are first in line
    // next run rather than being skipped for the day.
    assert.equal(result.remaining, 15);
  });

  it("backs off for the rest of the run when Buffer rate limits", async () => {
    const result = await run(store, today, 20, {
      client: throwingClient(new AnalyticsRateLimitError()),
    });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, "RATE_LIMITED");
    // One request spent learning that, not twenty — the remaining daily allowance
    // stays available for publishing.
    assert.equal(store.reads.length, 0);
    assert.equal(result.remaining, 20);
  });
});

describe("syncPostMetrics — the forced setup sync", () => {
  it("reads the newest posts regardless of when they were last read", async () => {
    const today = new Date("2026-08-06T09:00:00");
    store = new FakeStore(posts(5, today));

    const result = await run(store, today, 5, { force: true });

    // Everything was already read today, so an unforced run would do nothing —
    // which is exactly what would greet an owner who added a key this evening.
    assert.equal(result.examined, 5);
  });
});

// ─── Data safety ──────────────────────────────────────────────────────────────

function metrics(over: Partial<NormalizedMetrics> = {}): NormalizedMetrics {
  return {
    reactions: 12,
    comments: 3,
    shares: 1,
    impressions: 400,
    clicks: 7,
    reach: null,
    views: null,
    saves: null,
    follows: null,
    engagementRate: 4.5,
    engagementRateDenominator: "impressions",
    ...over,
  };
}

describe("observationColumns — a successful read", () => {
  it("writes the figures Buffer reported", () => {
    const columns = observationColumns({
      syncStatus: "ok",
      channelService: "facebook",
      metricsUpdatedAt: new Date("2026-08-06T00:00:00Z"),
      metrics: metrics(),
      raw: [{ type: "reactions", value: 12 }],
    });

    assert.equal(columns.reactions, 12);
    assert.equal(columns.comments, 3);
    assert.equal(columns.engagementRate, 4.5);
    assert.equal(columns.engagementRateDenominator, "impressions");
    assert.equal(columns.channelService, "facebook");
    assert.ok(columns.raw);
  });

  it("keeps an unreported metric null rather than zero", () => {
    // Buffer omits metrics a network does not measure; a 0 would read as a real
    // result. See lib/buffer/metric-normalizer.ts.
    const columns = observationColumns({ syncStatus: "ok", metrics: metrics({ reach: null }) });
    assert.equal(columns.reach, null);
  });
});

describe("observationColumns — a failed read keeps the previous statistics", () => {
  it("writes no figures when the read errored", () => {
    const columns = observationColumns({ syncStatus: "error" });

    // An empty object means the upsert's `update` touches only the attempt
    // fields, so whatever the last successful sync stored stays on the row.
    assert.deepEqual(columns, {});
  });

  it("ignores figures handed in alongside a non-ok status", () => {
    // Defensive: a caller mixing a failure status with a metrics payload must not
    // be able to half-overwrite the row.
    const columns = observationColumns({ syncStatus: "error", metrics: metrics() });
    assert.deepEqual(columns, {});
  });

  for (const status of ["no_data", "forbidden", "not_found"] as const) {
    it(`writes no figures for a ${status} read`, () => {
      const columns = observationColumns({ syncStatus: status, channelService: "instagram" });

      // Same rule as an error: Buffer telling us nothing today is not evidence
      // that yesterday's numbers were wrong.
      assert.deepEqual(columns, {});
    });
  }
});

/**
 * Buffer's `channelService` is the authoritative network for a metric row, and
 * `Post.channel` is not consulted at all.
 *
 * That is now doubly true: the publish guard (lib/buffer/profile-channel.ts)
 * stops the two from diverging on NEW posts, but one already-published post
 * disagrees (care-tech, 2026-08-14) and the analytics side must keep attributing
 * it to where Buffer says it went. The store contract is the enforcement — a
 * `SyncablePost` carries only `id` and `bufferUpdateId`, so there is no channel
 * here to be tempted by. These pin that it stays that way.
 */
describe("syncPostMetrics — Buffer's channelService is authoritative", () => {
  const today = new Date("2026-08-06T09:00:00");

  function clientReporting(channelService: string): BufferAnalyticsClient {
    return {
      getPostMetrics: async (bufferPostId: string) => ({
        status: "ok" as const,
        bufferPostId,
        channelService,
        metrics: [{ type: "reactions", name: "Reactions", value: 5, unit: "count" }],
        metricsUpdatedAt: null,
      }),
    } as unknown as BufferAnalyticsClient;
  }

  it("records the network Buffer names, whatever the post is stored as", async () => {
    const store = new FakeStore(posts(1, null));

    await syncPostMetrics({
      companyId: COMPANY,
      limit: 1,
      store,
      client: clientReporting("instagram"),
      now: today,
    });

    assert.equal(store.outcomes.length, 1);
    assert.equal(store.outcomes[0].channelService, "instagram");
  });

  it("keeps Buffer's own vocabulary rather than mapping it to a SocialChannel", async () => {
    // post_metrics.channel_service is deliberately a plain string: normalising it
    // here would throw away the account type, and `normalizeChannel` in the read
    // model is where the display grouping belongs.
    const store = new FakeStore(posts(1, null));

    await syncPostMetrics({
      companyId: COMPANY,
      limit: 1,
      store,
      client: clientReporting("instagram-business"),
      now: today,
    });

    assert.equal(store.outcomes[0].channelService, "instagram-business");
  });

  it("gives the sync no access to Post.channel in the first place", () => {
    // Structural, not behavioural: SyncablePost is {id, bufferUpdateId}. If a
    // channel ever appears on it, this is the test that should have to change.
    const syncable: SyncablePost = { id: "post-1", bufferUpdateId: "buffer-1" };
    assert.deepEqual(Object.keys(syncable).sort(), ["bufferUpdateId", "id"]);
  });
});
