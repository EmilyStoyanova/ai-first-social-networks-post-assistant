import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ContentSourceType } from "@prisma/client";
import {
  listGenerationSourcesCore,
  type GenerationSourcesDb,
} from "./list-generation-sources.service";

// ─── Fake DB ───────────────────────────────────────────────────────────────────
// contentSource.findMany honours the enabled filter, and feedItem.findMany
// honours enabled + the optional usedInPost filter and the sourceId window, so
// the tests prove the real queries' filters rather than a hand-rolled answer.
// The optional usedInPost is the crux: the RSS window sets it, the non-RSS
// window deliberately omits it.

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
  /** Absent = never classified, which is a tier generation draws from. */
  classification?: string | null;
}

function makeDb(sources: SourceSeed[], items: ItemSeed[] = []): GenerationSourcesDb {
  return {
    company: { findUnique: async () => ({ id: "co-1" }) },
    companyMember: { findFirst: async () => ({ companyId: "co-1" }) },
    contentSource: {
      findMany: async ({ where }) =>
        sources
          .filter((s) => s.enabled === where.enabled)
          .map((s) => ({ id: s.id, name: s.name, type: s.type })),
    },
    feedItem: {
      findMany: async ({ where }) => {
        const matching = items.filter(
          (i) =>
            where.sourceId.in.includes(i.sourceId) &&
            i.enabled === where.enabled &&
            (where.usedInPost === undefined || i.usedInPost === where.usedInPost) &&
            // The classification gate, interpreted as Prisma would: an OR of
            // plain equalities, with `null` matching an unclassified row.
            (where.OR === undefined ||
              where.OR.some((branch) => branch.classification === (i.classification ?? null)))
        );
        // distinct: ["sourceId"]
        return [...new Set(matching.map((i) => i.sourceId))].map((sourceId) => ({ sourceId }));
      },
    },
  };
}

const source = (id: string, name: string, type: ContentSourceType, enabled = true): SourceSeed => ({
  id,
  name,
  type,
  enabled,
});

const rss = (id: string, name: string, enabled = true) => source(id, name, "rss", enabled);
const productPage = (id: string, name: string, enabled = true) =>
  source(id, name, "product_page", enabled);

const unusedArticle = (sourceId: string): ItemSeed => ({
  sourceId,
  enabled: true,
  usedInPost: false,
});

const usedItem = (sourceId: string): ItemSeed => ({ sourceId, enabled: true, usedInPost: true });

describe("listGenerationSourcesCore", () => {
  it("lists enabled RSS sources with articles as selectable", async () => {
    const db = makeDb([rss("src-1", "Tech Weekly")], [unusedArticle("src-1")]);

    const result = await listGenerationSourcesCore("acme", "u-1", false, db);

    assert.ok(result.success);
    assert.deepEqual(result.sources, [
      { id: "src-1", name: "Tech Weekly", type: "rss", available: true, unavailableReason: null },
    ]);
  });

  it("still lists an RSS source whose articles are all used, but marks it unselectable", async () => {
    // The requirement: a dry feed stays visible so the owner can see it exists
    // and is merely out of articles — the form renders it disabled.
    const db = makeDb(
      [rss("src-1", "Tech Weekly"), rss("src-2", "Design Notes")],
      [unusedArticle("src-1"), usedItem("src-2")]
    );

    const result = await listGenerationSourcesCore("acme", "u-1", false, db);

    assert.ok(result.success);
    const dry = result.sources.find((s) => s.id === "src-2");
    assert.ok(dry, "a source with no unused articles is still displayed");
    assert.equal(dry.available, false, "but it cannot be selected");
    assert.equal(dry.unavailableReason, "no_articles");
  });

  it("treats an RSS source whose only articles are disabled as having none", async () => {
    // A disabled article is excluded from the generation window too, so offering
    // the source would promise an article generation would then refuse to use.
    const db = makeDb(
      [rss("src-1", "Tech Weekly")],
      [{ sourceId: "src-1", enabled: false, usedInPost: false }]
    );

    const result = await listGenerationSourcesCore("acme", "u-1", false, db);

    assert.ok(result.success);
    assert.equal(result.sources[0].available, false);
    assert.equal(result.sources[0].unavailableReason, "no_articles");
  });

  it("treats an RSS source whose only articles are REJECTED as having none", async () => {
    // Generation never draws a REJECTED article, so offering the source here
    // would produce a dropdown entry that looks fine and then fails with
    // SELECTED_SOURCE_UNAVAILABLE the moment it is picked.
    const db = makeDb(
      [rss("src-1", "Tech Weekly")],
      [{ sourceId: "src-1", enabled: true, usedInPost: false, classification: "REJECTED" }]
    );

    const result = await listGenerationSourcesCore("acme", "u-1", false, db);

    assert.ok(result.success);
    assert.equal(result.sources[0].available, false);
    assert.equal(result.sources[0].unavailableReason, "no_articles");
  });

  it("keeps an RSS source selectable when a REJECTED article sits beside a usable one", async () => {
    const db = makeDb(
      [rss("src-1", "Tech Weekly")],
      [
        { sourceId: "src-1", enabled: true, usedInPost: false, classification: "REJECTED" },
        { sourceId: "src-1", enabled: true, usedInPost: false, classification: "MEDIUM" },
      ]
    );

    const result = await listGenerationSourcesCore("acme", "u-1", false, db);

    assert.ok(result.success);
    assert.equal(result.sources[0].available, true);
  });

  it("counts HIGH, MEDIUM and unclassified articles alike towards availability", async () => {
    // Availability asks whether the source can back a post at all — the ORDER
    // the tiers are drawn in is the window's business, not the dropdown's. A
    // missing verdict must never read as a rejection here either.
    for (const classification of ["HIGH", "MEDIUM", null, undefined]) {
      const db = makeDb(
        [rss("src-1", "Tech Weekly")],
        [{ sourceId: "src-1", enabled: true, usedInPost: false, classification }]
      );

      const result = await listGenerationSourcesCore("acme", "u-1", false, db);

      assert.ok(result.success);
      assert.equal(
        result.sources[0].available,
        true,
        `an article classified ${String(classification)} should make its source selectable`
      );
    }
  });

  it("omits disabled sources entirely", async () => {
    // Switched off is not the same as dry: it is not offered at all.
    const db = makeDb(
      [
        rss("src-1", "Tech Weekly"),
        rss("src-2", "Retired Feed", false),
        productPage("src-3", "Old Product", false),
      ],
      [unusedArticle("src-1"), unusedArticle("src-2"), unusedArticle("src-3")]
    );

    const result = await listGenerationSourcesCore("acme", "u-1", false, db);

    assert.ok(result.success);
    assert.deepEqual(
      result.sources.map((s) => s.id),
      ["src-1"],
      "an inactive source never reaches the dropdown, whatever its type"
    );
  });

  it("lists a product page alongside RSS, carrying its type", async () => {
    // The bug this fixes: a perfectly good product page could be added and
    // extracted but never appeared in the dropdown, making it unusable.
    const db = makeDb(
      [rss("src-1", "Tech Weekly"), productPage("src-2", "Pricing Page")],
      [unusedArticle("src-1"), unusedArticle("src-2")]
    );

    const result = await listGenerationSourcesCore("acme", "u-1", false, db);

    assert.ok(result.success);
    const page = result.sources.find((s) => s.id === "src-2");
    assert.ok(page, "the product page is offered");
    assert.equal(page.type, "product_page");
  });

  it("keeps a product page selectable after a post has already used its content", async () => {
    // A product page is not a one-shot article: it is read directly and consumed
    // by nothing, so `usedInPost` must not gate it. Under the old RSS-only
    // predicate this source would have gone permanently dry after one post.
    const db = makeDb([productPage("src-1", "Pricing Page")], [usedItem("src-1")]);

    const result = await listGenerationSourcesCore("acme", "u-1", false, db);

    assert.ok(result.success);
    assert.equal(result.sources[0].available, true);
    assert.equal(result.sources[0].unavailableReason, null);
  });

  it("lists an active product page with extracted content as selectable", async () => {
    const db = makeDb([productPage("src-1", "Pricing Page")], [unusedArticle("src-1")]);

    const result = await listGenerationSourcesCore("acme", "u-1", false, db);

    assert.ok(result.success);
    assert.deepEqual(result.sources, [
      {
        id: "src-1",
        name: "Pricing Page",
        type: "product_page",
        available: true,
        unavailableReason: null,
      },
    ]);
  });

  it("disables a product page that has never been extracted", async () => {
    // Added but never fetched: visible, so the owner sees it exists and knows to
    // fetch it — and reported as missing CONTENT, not missing articles.
    const db = makeDb([productPage("src-1", "Pricing Page")], []);

    const result = await listGenerationSourcesCore("acme", "u-1", false, db);

    assert.ok(result.success);
    assert.equal(result.sources[0].available, false);
    assert.equal(result.sources[0].unavailableReason, "no_content");
  });

  it("disables a product page whose only extracted item is disabled", async () => {
    // A disabled item is out of the generation window, so the source cannot back
    // a post even though something was once extracted for it.
    const db = makeDb(
      [productPage("src-1", "Pricing Page")],
      [{ sourceId: "src-1", enabled: false, usedInPost: false }]
    );

    const result = await listGenerationSourcesCore("acme", "u-1", false, db);

    assert.ok(result.success);
    assert.equal(result.sources[0].available, false);
    assert.equal(result.sources[0].unavailableReason, "no_content");
  });

  it("lists prompt and calendar sources too", async () => {
    // Every supported type is offered — the dropdown is no longer RSS-only.
    const db = makeDb(
      [
        source("src-1", "Ideas", "prompt"),
        source("src-2", "Launch Day", "calendar_event"),
        source("src-3", "Never fetched", "prompt"),
      ],
      [unusedArticle("src-1"), unusedArticle("src-2")]
    );

    const result = await listGenerationSourcesCore("acme", "u-1", false, db);

    assert.ok(result.success);
    assert.deepEqual(
      result.sources.map((s) => [s.id, s.type, s.available]),
      [
        ["src-1", "prompt", true],
        ["src-2", "calendar_event", true],
        ["src-3", "prompt", false],
      ]
    );
  });

  it("applies each kind's own availability rule in one mixed list", async () => {
    // The whole point of the split: the same `usedInPost: true` row means "dry"
    // for RSS and "still fine" for a product page.
    const db = makeDb(
      [rss("rss-1", "Tech Weekly"), productPage("pp-1", "Pricing Page")],
      [usedItem("rss-1"), usedItem("pp-1")]
    );

    const result = await listGenerationSourcesCore("acme", "u-1", false, db);

    assert.ok(result.success);
    assert.equal(result.sources.find((s) => s.id === "rss-1")?.available, false);
    assert.equal(result.sources.find((s) => s.id === "pp-1")?.available, true);
  });

  it("returns an empty list when the company has no sources at all", async () => {
    // The dropdown then shows only its two sentinel choices.
    let feedItemQueried = false;
    const db = makeDb([]);
    db.feedItem.findMany = async () => {
      feedItemQueried = true;
      return [];
    };

    const result = await listGenerationSourcesCore("acme", "u-1", false, db);

    assert.ok(result.success);
    assert.deepEqual(result.sources, []);
    assert.equal(feedItemQueried, false, "no item lookup without sources to look up");
  });

  it("skips the RSS lookup when every source is non-RSS", async () => {
    // Each window is queried only when it has ids to ask about.
    const queried: Array<false | undefined> = [];
    const db = makeDb([productPage("src-1", "Pricing Page")], [unusedArticle("src-1")]);
    const inner = db.feedItem.findMany;
    db.feedItem.findMany = async (args) => {
      queried.push(args.where.usedInPost);
      return inner(args);
    };

    const result = await listGenerationSourcesCore("acme", "u-1", false, db);

    assert.ok(result.success);
    assert.deepEqual(queried, [undefined], "only the non-RSS window is queried");
  });

  it("scopes the source query to competitorId: null (Part 3B §3.8/§4 isolation)", async () => {
    // A real Prisma call with `competitorId: null` excludes every competitor
    // ContentSource row (competitor_rss/competitor_website) by construction —
    // this pins the query shape so that guard cannot be silently dropped in a
    // future edit. The fake DB below asserts the exact where clause rather
    // than reproducing Prisma's filtering.
    let observedWhere: unknown;
    const db: GenerationSourcesDb = {
      company: { findUnique: async () => ({ id: "co-1" }) },
      companyMember: { findFirst: async () => ({ companyId: "co-1" }) },
      contentSource: {
        findMany: async ({ where }) => {
          observedWhere = where;
          return [];
        },
      },
      feedItem: { findMany: async () => [] },
    };

    await listGenerationSourcesCore("acme", "u-1", false, db);

    assert.deepEqual(observedWhere, { companyId: "co-1", enabled: true, competitorId: null });
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
