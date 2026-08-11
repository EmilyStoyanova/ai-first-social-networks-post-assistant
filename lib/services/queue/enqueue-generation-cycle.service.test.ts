import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { enqueueGenerationCycle } from "./enqueue-generation-cycle.service";
import type { EnqueueJobInput, EnqueueJobResult } from "./enqueue-job.service";
import {
  POST_GENERATION_JOB_TYPE,
  POST_GENERATION_DEDUPE_KEY,
  ANALYTICS_SYNC_JOB_TYPE,
  ANALYTICS_SYNC_DEDUPE_KEY,
  PUBLISH_SWEEP_JOB_TYPE,
  PUBLISH_SWEEP_DEDUPE_KEY,
} from "@/lib/queue/job-types";

/**
 * The consolidated schedule: one cron tick, three independent jobs.
 *
 * Vercel Hobby allows very few scheduled crons, so analytics and the publishing
 * sweep have no entry of their own in vercel.json and are enqueued here instead.
 * What these tests protect is that "consolidated scheduling" did not quietly become
 * "merged execution": the three jobs keep separate types and dedupe keys, and the
 * generation job must survive anything that goes wrong with either sibling.
 *
 * The publish enqueue carries an extra requirement the others do not. It is the
 * DAILY FLOOR for publishing — the external 30-minute scheduler is the real trigger
 * — and it must use the SAME dedupe key that scheduler's calls use, so the two
 * triggers can never produce two concurrent sweeps delivering the same post twice.
 */

let enqueued: EnqueueJobInput[];

function ok(jobId: string): EnqueueJobResult {
  return { enqueued: true, deduplicated: false, jobId };
}

async function fakeEnqueue(input: EnqueueJobInput): Promise<EnqueueJobResult> {
  enqueued.push(input);
  return ok(`job-${enqueued.length}`);
}

beforeEach(() => {
  enqueued = [];
});

describe("enqueueGenerationCycle", () => {
  it("enqueues generation first, then the publish sweep, then analytics", async () => {
    await enqueueGenerationCycle({ enqueue: fakeEnqueue });

    // Generation before publishing is what preserves the old ordering on a
    // single-slot worker: generate and auto-approve, then send. Nothing depends on
    // it — a sweep that runs first finds the new posts on the next tick — but the
    // day's posts should not have to wait for one.
    assert.deepEqual(
      enqueued.map((j) => j.type),
      [POST_GENERATION_JOB_TYPE, PUBLISH_SWEEP_JOB_TYPE, ANALYTICS_SYNC_JOB_TYPE]
    );
  });

  it("keeps them as three separate jobs with their own dedupe keys", async () => {
    await enqueueGenerationCycle({ enqueue: fakeEnqueue });

    // Distinct keys are what let one run while another is still queued, and what
    // stops a manual analytics trigger from being swallowed by a generation job.
    assert.equal(enqueued[0].dedupeKey, POST_GENERATION_DEDUPE_KEY);
    assert.equal(enqueued[1].dedupeKey, PUBLISH_SWEEP_DEDUPE_KEY);
    assert.equal(enqueued[2].dedupeKey, ANALYTICS_SYNC_DEDUPE_KEY);
    assert.equal(new Set(enqueued.map((j) => j.dedupeKey)).size, 3);
  });

  it("uses the very key the external scheduler's endpoint uses for publishing", async () => {
    // The single most important assertion in this file. The daily floor and the
    // 30-minute external trigger MUST collide on the same key — if they drift
    // apart, both sweeps run, both read the same due posts, and Buffer receives
    // every post twice.
    await enqueueGenerationCycle({ enqueue: fakeEnqueue });

    const publish = enqueued.find((j) => j.type === PUBLISH_SWEEP_JOB_TYPE);
    assert.equal(publish?.dedupeKey, PUBLISH_SWEEP_DEDUPE_KEY);
  });

  it("reports all three results", async () => {
    const cycle = await enqueueGenerationCycle({ enqueue: fakeEnqueue });

    assert.equal(cycle.generation.jobId, "job-1");
    assert.equal(cycle.publish?.jobId, "job-2");
    assert.equal(cycle.analytics?.jobId, "job-3");
    assert.equal(cycle.publishError, undefined);
    assert.equal(cycle.analyticsError, undefined);
  });

  it("passes a deduplicated analytics job through without inventing a failure", async () => {
    const cycle = await enqueueGenerationCycle({
      enqueue: async (input) => {
        enqueued.push(input);
        if (input.type === ANALYTICS_SYNC_JOB_TYPE) {
          return { enqueued: false, deduplicated: true, jobId: null };
        }
        return ok("job-1");
      },
    });

    // An analytics run already in flight is a success, not an error: the work is
    // happening, and a second run would re-read the same stalest posts.
    assert.equal(cycle.analytics?.deduplicated, true);
    assert.equal(cycle.analyticsError, undefined);
  });

  it("treats a deduplicated publish sweep as the success it is", async () => {
    // This is the EXPECTED outcome once the external scheduler is running: the
    // daily tick finds a sweep already queued or in flight. Reporting it as a
    // failure would train whoever reads these logs to ignore them.
    const cycle = await enqueueGenerationCycle({
      enqueue: async (input) => {
        enqueued.push(input);
        if (input.type === PUBLISH_SWEEP_JOB_TYPE) {
          return { enqueued: false, deduplicated: true, jobId: null };
        }
        return ok("job-1");
      },
    });

    assert.equal(cycle.publish?.deduplicated, true);
    assert.equal(cycle.publish?.enqueued, false);
    assert.equal(cycle.publishError, undefined);
  });
});

describe("enqueueGenerationCycle — the sibling enqueues are isolated", () => {
  it("still enqueues generation when the analytics enqueue throws", async () => {
    const cycle = await enqueueGenerationCycle({
      enqueue: async (input) => {
        enqueued.push(input);
        if (input.type === ANALYTICS_SYNC_JOB_TYPE) throw new Error("queue unavailable");
        return ok("job-1");
      },
    });

    // The whole requirement in one assertion: posts still get generated today.
    assert.equal(cycle.generation.enqueued, true);
    assert.equal(cycle.generation.jobId, "job-1");
    assert.equal(cycle.analytics, null);
    assert.equal(cycle.analyticsError, "queue unavailable");
  });

  it("still enqueues analytics when the publish enqueue throws", async () => {
    // The two siblings share a tick but not a fate. Publishing is the one whose
    // omission is visible to a reader of the feed, so it is guarded separately
    // rather than sharing analytics' try block.
    const cycle = await enqueueGenerationCycle({
      enqueue: async (input) => {
        enqueued.push(input);
        if (input.type === PUBLISH_SWEEP_JOB_TYPE) throw new Error("queue unavailable");
        return ok(`job-${enqueued.length}`);
      },
    });

    assert.equal(cycle.generation.enqueued, true);
    assert.equal(cycle.publish, null);
    assert.equal(cycle.publishError, "queue unavailable");
    assert.equal(cycle.analytics?.enqueued, true);
    assert.deepEqual(
      enqueued.map((j) => j.type),
      [POST_GENERATION_JOB_TYPE, PUBLISH_SWEEP_JOB_TYPE, ANALYTICS_SYNC_JOB_TYPE]
    );
  });

  it("does not swallow a generation enqueue failure", async () => {
    // The reverse is NOT isolated on purpose: if the queue cannot take the
    // generation job, the route must fail loudly rather than report a cycle it
    // never started.
    await assert.rejects(
      () =>
        enqueueGenerationCycle({
          enqueue: async () => {
            throw new Error("database down");
          },
        }),
      /database down/
    );
  });

  it("does not attempt analytics when generation could not be enqueued", async () => {
    await assert.rejects(() =>
      enqueueGenerationCycle({
        enqueue: async (input) => {
          enqueued.push(input);
          throw new Error("database down");
        },
      })
    );

    assert.deepEqual(
      enqueued.map((j) => j.type),
      [POST_GENERATION_JOB_TYPE]
    );
  });
});
