import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planSourceWrites } from "./update-content-mix.service";
import type { MixSourceInput } from "@/lib/scheduling/content-mix";
import type { ContentMixInput } from "@/lib/validators/content-mix.schema";

// planSourceWrites is the whole of "what does a save persist", with none of the
// Prisma surface: the transaction below it is a direct map over its output.

function stored(overrides: Partial<MixSourceInput> & { id: string }): MixSourceInput {
  return {
    name: overrides.id,
    enabled: true,
    postsPerWeek: null,
    fallbackPolicy: "skip",
    ...overrides,
  };
}

function request(sources: ContentMixInput["sources"]): ContentMixInput {
  return { sources, companyContentPostsPerWeek: 0 };
}

const STORED = [
  stored({ id: "rss-a", postsPerWeek: 3 }),
  stored({ id: "rss-b", postsPerWeek: 2, fallbackPolicy: "use_another_source" }),
];

describe("planSourceWrites", () => {
  it("persists a submitted fallback policy", () => {
    const writes = planSourceWrites(
      STORED,
      request([{ sourceId: "rss-a", postsPerWeek: 3, fallbackPolicy: "use_another_source" }])
    );
    assert.deepEqual(writes, [
      { id: "rss-a", postsPerWeek: 3, fallbackPolicy: "use_another_source" },
    ]);
  });

  it("persists the quota and the policy together", () => {
    const writes = planSourceWrites(
      STORED,
      request([
        { sourceId: "rss-a", postsPerWeek: 1, fallbackPolicy: "use_another_source" },
        { sourceId: "rss-b", postsPerWeek: 4, fallbackPolicy: "skip" },
      ])
    );
    assert.deepEqual(writes, [
      { id: "rss-a", postsPerWeek: 1, fallbackPolicy: "use_another_source" },
      { id: "rss-b", postsPerWeek: 4, fallbackPolicy: "skip" },
    ]);
  });

  it("keeps the stored policy when the request omits it", () => {
    // The compatibility case: a client that only knows about quotas must not
    // silently reset rss-b from use_another_source back to skip.
    const writes = planSourceWrites(
      STORED,
      request([
        { sourceId: "rss-a", postsPerWeek: 2 },
        { sourceId: "rss-b", postsPerWeek: 3 },
      ])
    );
    assert.deepEqual(writes, [
      { id: "rss-a", postsPerWeek: 2, fallbackPolicy: "skip" },
      { id: "rss-b", postsPerWeek: 3, fallbackPolicy: "use_another_source" },
    ]);
  });

  it("writes only the sources the request carried", () => {
    // rss-b was never submitted, so its row is left alone rather than rewritten
    // with the values it already has.
    const writes = planSourceWrites(STORED, request([{ sourceId: "rss-a", postsPerWeek: 5 }]));
    assert.deepEqual(
      writes.map((w) => w.id),
      ["rss-a"]
    );
  });

  it("writes a cleared quota as null while keeping the policy", () => {
    const writes = planSourceWrites(STORED, request([{ sourceId: "rss-b", postsPerWeek: null }]));
    assert.deepEqual(writes, [
      { id: "rss-b", postsPerWeek: null, fallbackPolicy: "use_another_source" },
    ]);
  });

  it("writes nothing when no source was submitted", () => {
    // Clearing the mix down to company content only — the company row still
    // changes, but no source row does.
    assert.deepEqual(planSourceWrites(STORED, request([])), []);
  });

  it("can switch a policy back to skip", () => {
    const writes = planSourceWrites(
      STORED,
      request([{ sourceId: "rss-b", postsPerWeek: 2, fallbackPolicy: "skip" }])
    );
    assert.equal(writes[0].fallbackPolicy, "skip");
  });

  it("ignores a stored source that is disabled only when it is not submitted", () => {
    // Disabled sources keep their row; the mix UI never submits them, so they
    // simply never appear in the write plan.
    const withDisabled = [...STORED, stored({ id: "rss-c", postsPerWeek: 9, enabled: false })];
    const writes = planSourceWrites(
      withDisabled,
      request([{ sourceId: "rss-a", postsPerWeek: 5 }])
    );
    assert.equal(
      writes.some((w) => w.id === "rss-c"),
      false
    );
  });
});
