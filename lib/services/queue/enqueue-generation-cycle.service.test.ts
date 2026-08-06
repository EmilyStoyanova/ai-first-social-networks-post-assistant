import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { enqueueGenerationCycle } from "./enqueue-generation-cycle.service";
import type { EnqueueJobInput, EnqueueJobResult } from "./enqueue-job.service";
import {
  POST_GENERATION_JOB_TYPE,
  POST_GENERATION_DEDUPE_KEY,
  ANALYTICS_SYNC_JOB_TYPE,
  ANALYTICS_SYNC_DEDUPE_KEY,
} from "@/lib/queue/job-types";

/**
 * The consolidated schedule: one cron tick, two independent jobs.
 *
 * Vercel Hobby allows very few scheduled crons, so analytics lost its own entry in
 * vercel.json and is enqueued here instead. What these tests protect is that
 * "consolidated scheduling" did not quietly become "merged execution": the two
 * jobs keep separate types and dedupe keys, and the generation job must survive
 * anything that goes wrong with the analytics enqueue.
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
  it("enqueues generation first, then analytics", async () => {
    await enqueueGenerationCycle({ enqueue: fakeEnqueue });

    assert.deepEqual(
      enqueued.map((j) => j.type),
      [POST_GENERATION_JOB_TYPE, ANALYTICS_SYNC_JOB_TYPE]
    );
  });

  it("keeps them as two separate jobs with their own dedupe keys", async () => {
    await enqueueGenerationCycle({ enqueue: fakeEnqueue });

    // Distinct keys are what let one run while the other is still queued, and what
    // stops a manual analytics trigger from being swallowed by a generation job.
    assert.equal(enqueued[0].dedupeKey, POST_GENERATION_DEDUPE_KEY);
    assert.equal(enqueued[1].dedupeKey, ANALYTICS_SYNC_DEDUPE_KEY);
    assert.notEqual(enqueued[0].dedupeKey, enqueued[1].dedupeKey);
  });

  it("reports both results", async () => {
    const cycle = await enqueueGenerationCycle({ enqueue: fakeEnqueue });

    assert.equal(cycle.generation.jobId, "job-1");
    assert.equal(cycle.analytics?.jobId, "job-2");
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
});

describe("enqueueGenerationCycle — the analytics enqueue is isolated", () => {
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
