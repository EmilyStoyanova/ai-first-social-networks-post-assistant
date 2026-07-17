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
  companyContentPostsPerWeek: number | null = 0,
  channels: Array<{ channel: string; postsPerWeek: number }> = [
    { channel: "facebook", postsPerWeek: 5 },
  ]
): LoadContentMixDb {
  return {
    company: { findUnique: async () => ({ companyContentPostsPerWeek }) },
    contentSource: { findMany: async () => sources },
    channelConfig: { findMany: async () => channels },
  };
}

function source(overrides: Partial<FakeSource> & { id: string }): FakeSource {
  return { name: overrides.id, type: "rss", enabled: true, postsPerWeek: null, ...overrides };
}

describe("loadContentMixCore", () => {
  it("returns the stored distribution and the target it must hit", async () => {
    const dto = await loadContentMixCore(
      makeDb([source({ id: "rss-a", postsPerWeek: 3 }), source({ id: "rss-b", postsPerWeek: 2 })]),
      "company-1"
    );

    assert.equal(dto.total, 5);
    assert.equal(dto.weeklyTarget, 5);
    assert.equal(dto.remaining, 0);
    assert.equal(dto.configured, true);
    assert.equal(dto.validationError, null);
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

  it("surfaces a stored mix that no longer adds up", async () => {
    // A channel budget can change after the mix was saved, so the read model has
    // to be able to say the stored distribution is now invalid.
    const dto = await loadContentMixCore(
      makeDb([source({ id: "rss-a", postsPerWeek: 2 })]),
      "company-1"
    );
    assert.equal(dto.validationError?.code, "MIX_TOTAL_MISMATCH");
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
