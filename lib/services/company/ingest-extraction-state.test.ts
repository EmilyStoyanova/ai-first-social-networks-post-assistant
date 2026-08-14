import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractionFieldsFor,
  requiresExtractionWork,
  type ExistingExtraction,
} from "./ingest-content-source.service";
import { enqueueExtractionAfterIngest } from "./enqueue-extraction-after-ingest";
import { PRODUCT_PAGE_EXTRACTION_JOB_TYPE } from "@/lib/queue/job-types";

const HASH = "hash-of-page-and-instruction";

function existing(overrides: Partial<ExistingExtraction> = {}): ExistingExtraction {
  return { extractionHash: HASH, extractionStatus: "completed", ...overrides };
}

describe("ingestion — what a product page without instructions does", () => {
  it("writes no extraction state at all, exactly as before the feature existed", () => {
    assert.deepEqual(extractionFieldsFor(null, undefined), {});
  });

  it("creates no extraction work, so no model call and no job", () => {
    assert.equal(requiresExtractionWork(null, undefined), false);
    assert.equal(requiresExtractionWork(null, existing()), false);
  });

  it("clears a stale result when the instruction is REMOVED from the source", () => {
    // Otherwise a page whose owner deleted the instruction would keep generating
    // from facts nobody asked for any more.
    const fields = extractionFieldsFor(null, existing());

    assert.equal(fields.extractionStatus, null);
    assert.equal(fields.extractedContent, null);
    assert.equal(fields.extractionHash, null);
  });
});

describe("ingestion — what a product page WITH instructions does", () => {
  it("queues extraction for a brand-new item", () => {
    const fields = extractionFieldsFor(HASH, undefined);

    assert.equal(fields.extractionStatus, "pending");
    assert.equal(fields.extractionHash, HASH);
    assert.equal(fields.extractionAttemptCount, 0);
    assert.equal(requiresExtractionWork(HASH, undefined), true);
  });

  it("spends nothing when the page and instruction are unchanged", () => {
    // A cron tick that re-scrapes an identical page must not pay for a model call.
    assert.deepEqual(extractionFieldsFor(HASH, existing()), {});
    assert.equal(requiresExtractionWork(HASH, existing()), false);
  });

  it("re-queues when the page changed under an unchanged instruction", () => {
    const fields = extractionFieldsFor("a-different-hash", existing());

    assert.equal(fields.extractionStatus, "pending");
    assert.equal(requiresExtractionWork("a-different-hash", existing()), true);
  });

  it("leaves a settled not-found answer alone while its input is unchanged", () => {
    // "This page does not list next week" does not become true on a re-scrape of
    // the same page, and re-asking only invites an invented answer.
    const settled = existing({ extractionStatus: "not_found" });

    assert.deepEqual(extractionFieldsFor(HASH, settled), {});
    assert.equal(requiresExtractionWork(HASH, settled), false);
  });

  it("retries an item left pending or failed by an earlier run", () => {
    for (const status of ["pending", "failed", "extracting", null]) {
      const stuck = existing({ extractionStatus: status });
      assert.equal(requiresExtractionWork(HASH, stuck), true, `status=${status}`);
    }
  });

  it("gives a changed page a fresh attempt budget", () => {
    const spent = existing({ extractionStatus: "failed", extractionHash: "old" });

    assert.equal(extractionFieldsFor(HASH, spent).extractionAttemptCount, 0);
  });
});

describe("ingestion — the extraction follow-up enqueue", () => {
  it("enqueues the drain when the ingest left real work", async () => {
    const calls: number[] = [];
    await enqueueExtractionAfterIngest(2, { slug: "acme", sourceId: "s1" }, async () => {
      calls.push(1);
      return { enqueued: true, deduplicated: false, jobId: "job-1" };
    });

    assert.equal(calls.length, 1);
  });

  it("enqueues nothing when the ingest changed no extraction input", async () => {
    let called = false;
    await enqueueExtractionAfterIngest(0, { slug: "acme", sourceId: "s1" }, async () => {
      called = true;
      return { enqueued: true, deduplicated: false, jobId: "job-1" };
    });

    assert.equal(called, false);
  });

  it("never turns a successful fetch into an error", async () => {
    // Best-effort: the drain is also reachable from the next ingest.
    await enqueueExtractionAfterIngest(1, { slug: "acme", sourceId: "s1" }, async () => {
      throw new Error("queue unavailable");
    });
  });

  it("uses the extraction job type", () => {
    assert.equal(PRODUCT_PAGE_EXTRACTION_JOB_TYPE, "product-page-extraction");
  });
});
