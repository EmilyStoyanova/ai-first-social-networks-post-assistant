import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  tallyClassificationCounts,
  type ClassificationCountGroup,
} from "./list-feed-items.service";

/**
 * The pill counts.
 *
 * Only the arithmetic is tested here — the grouping itself is one Prisma
 * `groupBy` — because the arithmetic is where the old bug lived: a single
 * `unclassified` total that added four unrelated situations together and so
 * answered no question a user could act on.
 */

function group(
  classification: string | null,
  classificationStatus: string | null,
  usedInPost: boolean,
  count: number
): ClassificationCountGroup {
  return { classification, classificationStatus, usedInPost, count };
}

describe("tallyClassificationCounts", () => {
  it("counts nothing as zeros rather than as absent keys", () => {
    // The panel renders `counts[key]` for every pill, so a missing key would
    // print "undefined" instead of "0".
    assert.deepEqual(tallyClassificationCounts([]), {
      all: 0,
      high: 0,
      medium: 0,
      rejected: 0,
      pending: 0,
      failed: 0,
      unclassified: 0,
    });
  });

  it("files each verdict under its own pill", () => {
    const counts = tallyClassificationCounts([
      group("HIGH", "completed", false, 3),
      group("MEDIUM", "completed", false, 3),
      group("REJECTED", "completed", false, 20),
    ]);
    assert.equal(counts.high, 3);
    assert.equal(counts.medium, 3);
    assert.equal(counts.rejected, 20);
    assert.equal(counts.all, 26);
    assert.equal(counts.unclassified, 0);
  });

  it("splits what used to be one `unclassified` number", () => {
    // The production shape this change was made for: 21 articles with no verdict
    // that a single count claimed were all the same thing.
    const counts = tallyClassificationCounts([
      group(null, null, false, 15), // never asked — ingested before the feature
      group(null, "failed", false, 1), // the classifier could not be trusted
      group(null, "pending", true, 5), // consumed; nothing will ever classify it
    ]);

    assert.equal(counts.all, 21);
    assert.equal(counts.pending, 0, "a consumed article is not pending");
    assert.equal(counts.failed, 1);
    assert.equal(counts.unclassified, 20);
  });

  it("keeps a genuinely queued article separate from a consumed one", () => {
    const counts = tallyClassificationCounts([
      group(null, "pending", false, 4),
      group(null, "classifying", false, 2),
      group(null, "pending", true, 7),
    ]);
    assert.equal(counts.pending, 6, "queued and in-flight, and only those");
    assert.equal(counts.unclassified, 7);
  });

  it("counts a consumed article under its verdict when it has one", () => {
    // Being used explains a MISSING verdict; it does not erase one that exists.
    const counts = tallyClassificationCounts([group("HIGH", "completed", true, 9)]);
    assert.equal(counts.high, 9);
    assert.equal(counts.unclassified, 0);
  });

  it("never counts a failure as a rejection", () => {
    const counts = tallyClassificationCounts([group(null, "failed", false, 12)]);
    assert.equal(counts.failed, 12);
    assert.equal(counts.rejected, 0);
  });

  it("adds up: every bucket sums to `all`", () => {
    const counts = tallyClassificationCounts([
      group("HIGH", "completed", false, 3),
      group("MEDIUM", "completed", true, 4),
      group("REJECTED", "completed", false, 20),
      group(null, "pending", false, 6),
      group(null, "classifying", false, 1),
      group(null, "failed", false, 2),
      group(null, "failed", true, 1),
      group(null, "skipped", false, 8),
      group(null, "completed", false, 5),
      group(null, null, false, 15),
      group(null, "pending", true, 5),
    ]);

    const sum =
      counts.high +
      counts.medium +
      counts.rejected +
      counts.pending +
      counts.failed +
      counts.unclassified;
    assert.equal(sum, counts.all);
    assert.equal(counts.all, 70);
  });
});
