import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadContentMixCore, type LoadContentMixDb } from "./get-content-mix.service";

interface FakeSource {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  postsPerWeek: number | null;
  fallbackPolicy: string;
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
  return {
    name: overrides.id,
    type: "rss",
    enabled: true,
    postsPerWeek: null,
    fallbackPolicy: "skip",
    ...overrides,
  };
}

describe("loadContentMixCore — fallbackPolicy", () => {
  it("returns each source's stored policy so the editor opens on it", async () => {
    const dto = await loadContentMixCore(
      makeDb([
        source({ id: "rss-a", postsPerWeek: 3, fallbackPolicy: "use_another_source" }),
        source({ id: "rss-b", postsPerWeek: 2 }),
      ]),
      "company-1"
    );
    assert.equal(dto.sources.find((s) => s.id === "rss-a")?.fallbackPolicy, "use_another_source");
    assert.equal(dto.sources.find((s) => s.id === "rss-b")?.fallbackPolicy, "skip");
  });

  it("returns the policy for disabled sources too", async () => {
    // The UI hides them from the mix rows, but the value must survive a
    // round-trip so re-enabling a source does not silently reset it.
    const dto = await loadContentMixCore(
      makeDb([
        source({
          id: "rss-a",
          postsPerWeek: 3,
          fallbackPolicy: "use_another_source",
          enabled: false,
        }),
      ]),
      "company-1"
    );
    assert.equal(dto.sources[0].fallbackPolicy, "use_another_source");
  });

  it("still reports the mix as valid when a source transfers its quota", async () => {
    // use_another_source is implemented, so it must not trip the
    // MIX_UNSUPPORTED_FALLBACK guard the way the unbuilt policies do.
    const dto = await loadContentMixCore(
      makeDb([
        source({ id: "rss-a", postsPerWeek: 3, fallbackPolicy: "use_another_source" }),
        source({ id: "rss-b", postsPerWeek: 2 }),
      ]),
      "company-1"
    );
    assert.equal(dto.validationError, null);
    assert.equal(dto.total, 5);
    assert.equal(dto.configured, true);
  });

  it("surfaces a stored policy that has no implementation as a validation error", async () => {
    const dto = await loadContentMixCore(
      makeDb([source({ id: "rss-a", postsPerWeek: 5, fallbackPolicy: "allow_reuse" })]),
      "company-1"
    );
    assert.equal(dto.validationError?.code, "MIX_UNSUPPORTED_FALLBACK");
  });
});
