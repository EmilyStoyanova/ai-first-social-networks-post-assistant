import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SocialChannel } from "@prisma/client";
import { publishScheduledPosts } from "./publish-scheduled-posts.service";
import { PAST_DUE_GRACE_MS, PUBLISH_LOOKAHEAD_MS } from "@/lib/scheduling/publish-window";

/**
 * What is under test here is SELECTION — which approved posts a sweep sends,
 * which it leaves for a later sweep, and which it parks as past due. Delivery is
 * injected, so no Buffer connection or database is involved; the Buffer path
 * itself is unchanged and covered by its own tests.
 */

const NOW = new Date("2026-08-20T07:00:00.000Z");
const COMPANY = "company-1";

interface Row {
  id: string;
  channel: SocialChannel;
  content: string;
  hashtags: string[];
  mediaAssetId: string | null;
  mediaAsset: { url: string } | null;
  scheduledFor: Date | null;
  manuallyScheduled: boolean;
  lastError: string | null;
}

function row(overrides: Partial<Row> & { id: string }): Row {
  return {
    channel: "facebook" as SocialChannel,
    content: "Post text",
    hashtags: [],
    mediaAssetId: null,
    mediaAsset: null,
    scheduledFor: null,
    manuallyScheduled: false,
    lastError: null,
    ...overrides,
  };
}

function manual(id: string, scheduledFor: string): Row {
  return row({ id, manuallyScheduled: true, scheduledFor: new Date(scheduledFor) });
}

function automatic(id: string, scheduledFor: string): Row {
  return row({ id, manuallyScheduled: false, scheduledFor: new Date(scheduledFor) });
}

/** Runs one sweep over a fixed candidate set, capturing what it sent and parked. */
async function sweep(rows: Row[]) {
  const sent: string[] = [];
  const parked: Array<{ id: string; message: string }> = [];

  const summary = await publishScheduledPosts(COMPANY, {
    now: () => NOW,
    loadCandidates: async () => rows,
    parkPastDue: async (_companyId, post, message) => {
      parked.push({ id: post.id, message });
    },
    deliver: async (_companyId, posts, result) => {
      for (const post of posts) {
        sent.push(post.id);
        result.published++;
      }
    },
  });

  return { summary, sent, parked };
}

describe("publishScheduledPosts — a manual schedule is honoured, not approximated", () => {
  it("does not send a manual post before the time the user chose", async () => {
    // The point of the bulk scheduling UI: a post placed on the 25th must not go
    // out today just because it is inside the automatic look-ahead.
    const { sent, parked, summary } = await sweep([manual("future", "2026-08-21T09:00:00.000Z")]);

    assert.deepEqual(sent, []);
    assert.deepEqual(parked, []);
    assert.equal(summary.published, 0);
  });

  it("sends a manual post once its time has arrived", async () => {
    const { sent } = await sweep([manual("due", "2026-08-20T06:30:00.000Z")]);

    assert.deepEqual(sent, ["due"]);
  });

  it("still sends one the daily sweep could only reach the next morning", async () => {
    const { sent, parked } = await sweep([
      manual("last-evening", new Date(NOW.getTime() - PAST_DUE_GRACE_MS + 60_000).toISOString()),
    ]);

    assert.deepEqual(sent, ["last-evening"]);
    assert.deepEqual(parked, []);
  });

  it("parks a post whose slot is long gone instead of firing it late", async () => {
    // Approval happening days after the scheduled time must not become an
    // immediate, unannounced publish.
    const { sent, parked, summary } = await sweep([manual("stale", "2026-08-01T09:00:00.000Z")]);

    assert.deepEqual(sent, []);
    assert.equal(summary.pastDue, 1);
    assert.equal(parked.length, 1);
    assert.equal(parked[0].id, "stale");
    assert.match(parked[0].message, /2026-08-01T09:00:00\.000Z/);
  });

  it("parks stranded posts even when there is nothing to send", async () => {
    // The report must not depend on the run reaching Buffer — an outage would
    // otherwise hide a post that has quietly stopped being publishable.
    const { summary, parked } = await sweep([
      manual("stale", "2026-07-01T09:00:00.000Z"),
      manual("future", "2026-09-01T09:00:00.000Z"),
    ]);

    assert.equal(summary.pastDue, 1);
    assert.equal(parked[0].id, "stale");
  });

  it("handles several posts sharing one day, sending only the ones already due", async () => {
    const { sent } = await sweep([
      manual("morning", "2026-08-20T06:00:00.000Z"),
      manual("midday", "2026-08-20T12:00:00.000Z"),
      manual("evening", "2026-08-20T18:30:00.000Z"),
    ]);

    assert.deepEqual(sent, ["morning"]);
  });

  it("sends posts sharing the exact same instant together", async () => {
    // A custom distribution can put two posts on one day; if the channel has one
    // window they land on the same minute, and both must go.
    const { sent } = await sweep([
      manual("a", "2026-08-20T06:00:00.000Z"),
      manual("b", "2026-08-20T06:00:00.000Z"),
    ]);

    assert.deepEqual(sent, ["a", "b"]);
  });
});

describe("publishScheduledPosts — automatic posts keep their old behaviour", () => {
  it("still sends inside the 48-hour look-ahead", async () => {
    const { sent } = await sweep([
      automatic("auto", new Date(NOW.getTime() + PUBLISH_LOOKAHEAD_MS - 1).toISOString()),
    ]);

    assert.deepEqual(sent, ["auto"]);
  });

  it("never parks a cron-scheduled post, however late it is", async () => {
    // Deliberate: the past-due policy is scoped to schedules a human authored,
    // so the automated pipeline's timing is untouched.
    const { sent, parked, summary } = await sweep([automatic("old", "2026-01-01T09:00:00.000Z")]);

    assert.deepEqual(sent, ["old"]);
    assert.deepEqual(parked, []);
    assert.equal(summary.pastDue, 0);
  });

  it("mixes both kinds in one sweep without confusing them", async () => {
    const { sent, parked } = await sweep([
      automatic("auto-soon", "2026-08-21T09:00:00.000Z"),
      manual("manual-future", "2026-08-21T09:00:00.000Z"),
      manual("manual-due", "2026-08-20T06:30:00.000Z"),
      manual("manual-stale", "2026-08-05T09:00:00.000Z"),
    ]);

    assert.deepEqual(sent, ["auto-soon", "manual-due"]);
    assert.deepEqual(
      parked.map((p) => p.id),
      ["manual-stale"]
    );
  });
});

describe("publishScheduledPosts — nothing to do", () => {
  it("returns zeroes for a company with nothing scheduled", async () => {
    const { summary, sent, parked } = await sweep([]);

    assert.deepEqual(summary, { published: 0, failed: 0, skipped: 0, pastDue: 0, failures: [] });
    assert.deepEqual(sent, []);
    assert.deepEqual(parked, []);
  });

  it("ignores a post carrying no time at all", async () => {
    const { sent, parked } = await sweep([row({ id: "unscheduled", scheduledFor: null })]);

    assert.deepEqual(sent, []);
    assert.deepEqual(parked, []);
  });
});
