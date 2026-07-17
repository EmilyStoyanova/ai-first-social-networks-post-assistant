import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planSourceWrites } from "./update-content-mix.service";
import type { MixSourceInput } from "@/lib/scheduling/content-mix";
import type { ContentMixInput } from "@/lib/validators/content-mix.schema";

// planSourceWrites is the whole of "what does a save persist", with none of the
// Prisma surface: the transaction below it is a direct map over its output.

function stored(overrides: Partial<MixSourceInput> & { id: string }): MixSourceInput {
  return { name: overrides.id, enabled: true, postsPerWeek: null, ...overrides };
}

function request(sources: ContentMixInput["sources"]): ContentMixInput {
  return { sources, companyContentPostsPerWeek: 0 };
}

const STORED = [stored({ id: "rss-a", postsPerWeek: 3 }), stored({ id: "rss-b", postsPerWeek: 2 })];

describe("planSourceWrites", () => {
  it("persists the submitted quotas", () => {
    const writes = planSourceWrites(
      STORED,
      request([
        { sourceId: "rss-a", postsPerWeek: 1 },
        { sourceId: "rss-b", postsPerWeek: 4 },
      ])
    );
    assert.deepEqual(writes, [
      { id: "rss-a", postsPerWeek: 1 },
      { id: "rss-b", postsPerWeek: 4 },
    ]);
  });

  it("never writes a fallback policy", () => {
    // The column is legacy: transfer is unconditional, so a save must leave
    // whatever is stored in it alone rather than rewriting it.
    const writes = planSourceWrites(STORED, request([{ sourceId: "rss-a", postsPerWeek: 1 }]));
    assert.deepEqual(Object.keys(writes[0]).sort(), ["id", "postsPerWeek"]);
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

  it("writes a cleared quota as null", () => {
    const writes = planSourceWrites(STORED, request([{ sourceId: "rss-b", postsPerWeek: null }]));
    assert.deepEqual(writes, [{ id: "rss-b", postsPerWeek: null }]);
  });

  it("writes nothing when no source was submitted", () => {
    // Clearing the mix down to company content only — the company row still
    // changes, but no source row does.
    assert.deepEqual(planSourceWrites(STORED, request([])), []);
  });

  it("never writes a disabled source the request omits", () => {
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
