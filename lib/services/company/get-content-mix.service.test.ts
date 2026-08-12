import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadContentMixCore, type LoadContentMixDb } from "./get-content-mix.service";

interface FakeSource {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  postsPerWeek: number | null;
}

function makeDb(
  sources: FakeSource[],
  companyContentPostsPerWeek: number | null = 0
): LoadContentMixDb {
  return {
    company: { findUnique: async () => ({ companyContentPostsPerWeek }) },
    contentSource: { findMany: async () => sources },
  };
}

function source(overrides: Partial<FakeSource> & { id: string }): FakeSource {
  return { name: overrides.id, type: "rss", enabled: true, postsPerWeek: null, ...overrides };
}

describe("loadContentMixCore", () => {
  it("returns the stored distribution and the parts it adds up to", async () => {
    const dto = await loadContentMixCore(
      makeDb([source({ id: "rss-a", postsPerWeek: 3 }), source({ id: "rss-b", postsPerWeek: 2 })]),
      "company-1"
    );

    assert.equal(dto.total, 5);
    assert.equal(dto.configured, true);
    assert.equal(dto.validationError, null);
  });

  it("does not read channel budgets — the mix is only a split", async () => {
    // The DTO once carried a weekly target from the enabled channels and the gap
    // to it. Nothing generates against that number: each channel generates its
    // own postsPerWeek and resizes the mix to fit, so a mix of 2 is valid
    // whatever any channel is set to.
    const dto = await loadContentMixCore(
      makeDb([source({ id: "rss-a", postsPerWeek: 2 })]),
      "company-1"
    );
    assert.equal(dto.total, 2);
    assert.equal(dto.validationError, null);
    assert.ok(!("weeklyTarget" in dto), "no target survives on the DTO");
    assert.ok(!("remaining" in dto), "and so no gap to it either");
  });

  it("exposes no fallback policy — transfer is not configurable", async () => {
    // The column still exists for backwards compatibility. It must not reach the
    // client, or a UI could imply a choice the scheduler no longer honours.
    const dto = await loadContentMixCore(
      makeDb([source({ id: "rss-a", postsPerWeek: 5 })]),
      "company-1"
    );
    assert.deepEqual(Object.keys(dto.sources[0]).sort(), [
      "enabled",
      "id",
      "name",
      "postsPerWeek",
      "type",
    ]);
  });

  it("reports an unconfigured mix as legacy pooling", async () => {
    const dto = await loadContentMixCore(makeDb([source({ id: "rss-a" })], null), "company-1");
    assert.equal(dto.configured, false);
    assert.equal(dto.total, 0);
  });

  it("surfaces a stored mix that is no longer valid", async () => {
    // A source can be added after the mix was saved, so the read model has to be
    // able to say the stored distribution is now incomplete.
    const dto = await loadContentMixCore(
      makeDb([source({ id: "rss-a", postsPerWeek: 2 }), source({ id: "rss-new" })]),
      "company-1"
    );
    assert.equal(dto.validationError?.code, "MIX_SOURCE_UNASSIGNED");
  });

  it("keeps disabled sources in the list but out of the total", async () => {
    const dto = await loadContentMixCore(
      makeDb([
        source({ id: "rss-a", postsPerWeek: 5 }),
        source({ id: "rss-b", postsPerWeek: 9, enabled: false }),
      ]),
      "company-1"
    );
    assert.equal(dto.sources.length, 2, "the UI still lists them");
    assert.equal(dto.total, 5, "a disabled source's stale quota never counts");
  });
});
