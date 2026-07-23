import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { enqueueTranslationAfterIngest } from "./enqueue-translation-after-ingest";
import type { EnqueueJobResult } from "@/lib/services/queue/enqueue-job.service";

const CTX = { slug: "acme", sourceId: "src-1" };

/** An enqueue spy that records call count and returns a canned result. */
function enqueueSpy(result: Partial<EnqueueJobResult> = {}) {
  let calls = 0;
  const fn = async (): Promise<EnqueueJobResult> => {
    calls++;
    return { enqueued: true, deduplicated: false, jobId: "t-job-1", ...result };
  };
  return { fn, calls: () => calls };
}

describe("enqueueTranslationAfterIngest (manual route follow-up)", () => {
  it("enqueues once when translation work was produced", async () => {
    const spy = enqueueSpy();
    await enqueueTranslationAfterIngest(3, CTX, spy.fn);
    assert.equal(spy.calls(), 1);
  });

  it("does NOT enqueue when there is no translation work", async () => {
    const spy = enqueueSpy();
    await enqueueTranslationAfterIngest(0, CTX, spy.fn);
    assert.equal(spy.calls(), 0);
  });

  it("does NOT enqueue on a negative/absent count", async () => {
    const spy = enqueueSpy();
    await enqueueTranslationAfterIngest(-1, CTX, spy.fn);
    assert.equal(spy.calls(), 0);
  });

  it("treats a deduplicated result as success (does not throw)", async () => {
    const spy = enqueueSpy({ enqueued: false, deduplicated: true, jobId: null });
    await assert.doesNotReject(() => enqueueTranslationAfterIngest(2, CTX, spy.fn));
    assert.equal(spy.calls(), 1);
  });

  it("swallows enqueue failures — never throws so the fetch stays successful", async () => {
    const failing = async (): Promise<never> => {
      throw new Error("enqueue exploded");
    };
    await assert.doesNotReject(() => enqueueTranslationAfterIngest(5, CTX, failing));
  });
});
