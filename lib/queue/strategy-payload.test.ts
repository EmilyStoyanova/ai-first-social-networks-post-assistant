import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { topicGenerationPayloadSchema } from "./topic-generation-payload";
import { bulkGenerationPayloadSchema } from "./bulk-generation-payload";
import { SINGLE_BY_DEFAULT } from "@/lib/ai/strategy/resolve-strategy";

const AB_MULTI = {
  strategy: "multi" as const,
  source: "ab_split" as const,
  experimentKey: "exp-1",
  experimentArm: "multi" as const,
  experimentUnitId: "group-1",
  experimentBucket: 1234,
  experimentAllocation: 50,
  abIneligibleReason: null,
};

describe("topic payload — resolvedStrategy survives serialization", () => {
  const base = {
    slug: "acme",
    userId: "u1",
    contentGroupId: "group-1",
    channels: ["facebook", "linkedin"],
  };

  it("round-trips a resolved strategy through JSON", () => {
    const wire = JSON.parse(JSON.stringify({ ...base, resolvedStrategy: AB_MULTI }));
    const parsed = topicGenerationPayloadSchema.parse(wire);
    assert.deepEqual(parsed.resolvedStrategy, AB_MULTI);
  });

  it("accepts a payload with NO resolvedStrategy — a job queued before the field existed", () => {
    const parsed = topicGenerationPayloadSchema.parse(base);
    assert.equal(parsed.resolvedStrategy, undefined);
  });

  it("now accepts a SINGLE channel — a one-channel multi run has to be queued", () => {
    const parsed = topicGenerationPayloadSchema.parse({
      ...base,
      channels: ["facebook"],
      resolvedStrategy: AB_MULTI,
    });
    assert.deepEqual(parsed.channels, ["facebook"]);
  });

  it("rejects an unknown extra field — the payload is strict", () => {
    assert.throws(() =>
      topicGenerationPayloadSchema.parse({ ...base, somethingNew: 1 } as unknown)
    );
  });
});

describe("bulk payload — one resolved strategy per topic", () => {
  const base = {
    slug: "acme",
    userId: "u1",
    batchId: "b1",
    contentGroupIds: ["g1", "g2", "g3"],
    channels: ["facebook"],
    numberOfPosts: 3,
    startDate: "2026-09-10",
    endDate: "2026-09-20",
  };

  it("accepts exactly one strategy per requested topic", () => {
    const parsed = bulkGenerationPayloadSchema.parse({
      ...base,
      resolvedStrategies: [AB_MULTI, SINGLE_BY_DEFAULT, AB_MULTI],
    });
    assert.equal(parsed.resolvedStrategies?.length, 3);
  });

  it("rejects a strategy list that is shorter than the topic count", () => {
    assert.throws(
      () =>
        bulkGenerationPayloadSchema.parse({
          ...base,
          resolvedStrategies: [AB_MULTI, SINGLE_BY_DEFAULT],
        }),
      /resolvedStrategies must have exactly one entry per requested topic/
    );
  });

  it("accepts a payload with NO strategies — a batch queued before the field existed", () => {
    const parsed = bulkGenerationPayloadSchema.parse(base);
    assert.equal(parsed.resolvedStrategies, undefined);
  });
});
