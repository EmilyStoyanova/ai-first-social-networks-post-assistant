import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ContentSourceType } from "@prisma/client";
import {
  listGenerationSourcesCore,
  type GenerationSourcesDb,
} from "./list-generation-sources.service";

// ─── Fake DB ───────────────────────────────────────────────────────────────────
// contentSource.findMany honours the enabled/type filters, and feedItem.findMany
// honours enabled/usedInPost + the sourceId window, so the tests prove the real
// query's filters rather than a hand-rolled answer.

interface SourceSeed {
  id: string;
  name: string;
  type: ContentSourceType;
  enabled: boolean;
}

interface ItemSeed {
  sourceId: string;
  enabled: boolean;
  usedInPost: boolean;
}

function makeDb(sources: SourceSeed[], items: ItemSeed[] = []): GenerationSourcesDb {
  return {
    company: { findUnique: async () => ({ id: "co-1" }) },
    companyMember: { findFirst: async () => ({ companyId: "co-1" }) },
    contentSource: {
      findMany: async ({ where }) =>
        sources
          .filter((s) => s.enabled === where.enabled && s.type === where.type)
          .map((s) => ({ id: s.id, name: s.name })),
    },
    feedItem: {
      findMany: async ({ where }) => {
        const matching = items.filter(
          (i) =>
            where.sourceId.in.includes(i.sourceId) &&
            i.enabled === where.enabled &&
            i.usedInPost === where.usedInPost
        );
        // distinct: ["sourceId"]
        return [...new Set(matching.map((i) => i.sourceId))].map((sourceId) => ({ sourceId }));
      },
    },
  };
}

const rss = (id: string, name: string, enabled = true): SourceSeed => ({
  id,
  name,
  type: "rss",
  enabled,
});

const unusedArticle = (sourceId: string): ItemSeed => ({
  sourceId,
  enabled: true,
  usedInPost: false,
});

describe("listGenerationSourcesCore", () => {
  it("lists enabled RSS sources with articles as selectable", async () => {
    const db = makeDb([rss("src-1", "Tech Weekly")], [unusedArticle("src-1")]);

    const result = await listGenerationSourcesCore("acme", "u-1", false, db);

    assert.ok(result.success);
    assert.deepEqual(result.sources, [
      { id: "src-1", name: "Tech Weekly", hasAvailableArticles: true },
    ]);
  });

  it("still lists a source whose articles are all used, but marks it unselectable", async () => {
    // The requirement: a dry feed stays visible so the owner can see it exists
    // and is merely out of articles — the form renders it disabled.
    const db = makeDb(
      [rss("src-1", "Tech Weekly"), rss("src-2", "Design Notes")],
      [unusedArticle("src-1"), { sourceId: "src-2", enabled: true, usedInPost: true }]
    );

    const result = await listGenerationSourcesCore("acme", "u-1", false, db);

    assert.ok(result.success);
    const dry = result.sources.find((s) => s.id === "src-2");
    assert.ok(dry, "a source with no unused articles is still displayed");
    assert.equal(dry.hasAvailableArticles, false, "but it cannot be selected");
  });

  it("treats a source whose only articles are disabled as having none", async () => {
    // A disabled article is excluded from the generation window too, so offering
    // the source would promise an article generation would then refuse to use.
    const db = makeDb(
      [rss("src-1", "Tech Weekly")],
      [{ sourceId: "src-1", enabled: false, usedInPost: false }]
    );

    const result = await listGenerationSourcesCore("acme", "u-1", false, db);

    assert.ok(result.success);
    assert.equal(result.sources[0].hasAvailableArticles, false);
  });

  it("omits disabled sources entirely", async () => {
    // Switched off is not the same as dry: it is not offered at all.
    const db = makeDb(
      [rss("src-1", "Tech Weekly"), rss("src-2", "Retired Feed", false)],
      [unusedArticle("src-1"), unusedArticle("src-2")]
    );

    const result = await listGenerationSourcesCore("acme", "u-1", false, db);

    assert.ok(result.success);
    assert.deepEqual(
      result.sources.map((s) => s.id),
      ["src-1"]
    );
  });

  it("omits non-RSS sources", async () => {
    const db = makeDb(
      [rss("src-1", "Tech Weekly"), { id: "src-2", name: "Ideas", type: "prompt", enabled: true }],
      [unusedArticle("src-1")]
    );

    const result = await listGenerationSourcesCore("acme", "u-1", false, db);

    assert.ok(result.success);
    assert.deepEqual(
      result.sources.map((s) => s.id),
      ["src-1"]
    );
  });

  it("returns an empty list when the company has no RSS sources", async () => {
    // The dropdown then shows only its two non-RSS choices.
    let feedItemQueried = false;
    const db = makeDb([]);
    db.feedItem.findMany = async () => {
      feedItemQueried = true;
      return [];
    };

    const result = await listGenerationSourcesCore("acme", "u-1", false, db);

    assert.ok(result.success);
    assert.deepEqual(result.sources, []);
    assert.equal(feedItemQueried, false, "no article lookup without sources to look up");
  });

  it("returns NOT_FOUND when a non-member requests the list", async () => {
    const db: GenerationSourcesDb = {
      company: { findUnique: async () => null },
      companyMember: { findFirst: async () => null },
      contentSource: { findMany: async () => [] },
      feedItem: { findMany: async () => [] },
    };

    const result = await listGenerationSourcesCore("acme", "u-1", false, db);

    assert.ok(!result.success);
    assert.equal(result.code, "NOT_FOUND");
  });
});
