import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { attributeSource, type AttributableSourcePost } from "./analytics-source";

function post(overrides: Partial<AttributableSourcePost> = {}): AttributableSourcePost {
  return {
    contentSourceId: null,
    contentSource: null,
    originType: null,
    originSourceType: null,
    originSourceName: null,
    originSourceTitle: null,
    originSourceUrl: null,
    primaryFeedItem: null,
    ...overrides,
  };
}

describe("attributeSource — the live relation first", () => {
  it("credits the source the post still points at", () => {
    const result = attributeSource(
      post({ contentSourceId: "src-1", contentSource: { name: "TechPowerUp" } })
    );

    assert.deepEqual(result, { key: "id:src-1", name: "TechPowerUp" });
  });

  it("prefers the live name over the frozen one, so a rename follows history", () => {
    // The snapshot holds the name the source had at generation time. The
    // relation holds what it is called now, and a renamed source should not
    // split into two rows.
    const result = attributeSource(
      post({
        contentSourceId: "src-1",
        contentSource: { name: "TechPowerUp News" },
        originType: "content_source",
        originSourceName: "TechPowerUp",
      })
    );

    assert.equal(result.name, "TechPowerUp News");
    assert.equal(result.key, "id:src-1");
  });
});

describe("attributeSource — the frozen snapshot for historical posts", () => {
  it("keeps a deleted source's own posts under its own name", () => {
    // Deleting a ContentSource SetNulls `contentSourceId`. Without the snapshot,
    // a year of history would collapse into "Company content" the moment someone
    // tidied up their RSS list.
    const result = attributeSource(
      post({
        contentSourceId: null,
        contentSource: null,
        originType: "content_source",
        originSourceType: "rss",
        originSourceName: "TechPowerUp",
        originSourceTitle: "A headline",
        originSourceUrl: "https://example.test/a",
      })
    );

    assert.deepEqual(result, { key: "name:techpowerup", name: "TechPowerUp" });
  });

  it("groups orphaned posts of the same source into ONE row", () => {
    const a = attributeSource(
      post({ originType: "content_source", originSourceName: "TechPowerUp" })
    );
    const b = attributeSource(
      post({ originType: "content_source", originSourceName: "techpowerup" })
    );

    assert.equal(a.key, b.key);
  });

  it("falls back to the live feed item for posts predating the snapshot columns", () => {
    // originType IS NULL — generated before the columns existed and not reached
    // by the migration's backfill. `resolvePostOrigin` already owns this rule.
    const result = attributeSource(
      post({
        originType: null,
        primaryFeedItem: {
          title: "A headline",
          url: "https://example.test/a",
          source: { name: "Family Handyman", type: "rss" },
        },
      })
    );

    assert.deepEqual(result, { key: "name:family handyman", name: "Family Handyman" });
  });
});

describe("attributeSource — company content", () => {
  it("files a brand/mission post under the company, with no source name", () => {
    const result = attributeSource(post({ originType: "brand_setup" }));

    assert.deepEqual(result, { key: "company", name: null });
  });

  it("files a legacy post with no source at all under the company", () => {
    assert.deepEqual(attributeSource(post()), { key: "company", name: null });
  });

  it("files a source post whose name was never captured under the company", () => {
    // Better an honest "Company content" row than a row labelled with nothing.
    const result = attributeSource(post({ originType: "content_source", originSourceName: null }));

    assert.deepEqual(result, { key: "company", name: null });
  });

  it("does not credit a live id when the source row is gone from the result", () => {
    // Defensive: an id with no joined row cannot name a source, so it must not
    // produce a keyed group with a null label.
    assert.deepEqual(attributeSource(post({ contentSourceId: "src-1", contentSource: null })), {
      key: "company",
      name: null,
    });
  });
});
