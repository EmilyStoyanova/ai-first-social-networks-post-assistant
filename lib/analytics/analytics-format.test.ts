import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compactCount, formatAverage, formatRate, NO_VALUE } from "./analytics-format";

/**
 * The last mile of the NULL ≠ 0 rule.
 *
 * Everything upstream can preserve "the network did not report this" perfectly
 * and it still ends as a lie if the formatter coalesces it to 0. These are the
 * assertions that stop that.
 */
describe("NULL renders as an em dash, never as zero", () => {
  it("holds for counts, averages and rates alike", () => {
    assert.equal(compactCount(null), NO_VALUE);
    assert.equal(formatAverage(null), NO_VALUE);
    assert.equal(formatRate(null), NO_VALUE);
  });

  it("still renders a real measured zero as 0", () => {
    assert.equal(compactCount(0), "0");
    assert.equal(formatAverage(0), "0");
    assert.equal(formatRate(0), "0%");
  });
});

describe("compactCount", () => {
  it("prints small counts exactly", () => {
    assert.equal(compactCount(7), "7");
    assert.equal(compactCount(1234), "1234");
    assert.equal(compactCount(9999), "9999");
  });

  it("abbreviates from ten thousand up, where the exact figure stops fitting", () => {
    assert.equal(compactCount(10_000), "10K");
    assert.equal(compactCount(12_500), "12.5K");
    assert.equal(compactCount(999_000), "999K");
  });

  it("abbreviates millions", () => {
    assert.equal(compactCount(1_000_000), "1M");
    assert.equal(compactCount(2_400_000), "2.4M");
  });

  it("drops a trailing .0 rather than printing 12.0K", () => {
    assert.equal(compactCount(12_000), "12K");
  });
});

describe("formatAverage", () => {
  it("keeps one decimal — 3 and 3.4 are different claims", () => {
    assert.equal(formatAverage(3.44), "3.4");
    assert.equal(formatAverage(3), "3");
  });
});

describe("formatRate", () => {
  it("treats Buffer's number as a percentage already", () => {
    // 12.5 means 12.5%, not 1250%.
    assert.equal(formatRate(12.5), "12.5%");
    assert.equal(formatRate(4), "4%");
  });
});
