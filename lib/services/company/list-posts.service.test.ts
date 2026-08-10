import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSourceImageUrl } from "./list-posts.service";

/**
 * Which posts are allowed to offer "Use source image".
 *
 * This is the gate the card reads: a null here means the action is never
 * rendered, so everything that must not offer it has to resolve to null.
 */

const IMAGE = "https://publisher.example/img/lead.jpg";

function feedItem(type: string, sourceImageUrl: string | null) {
  return { sourceImageUrl, source: { type } };
}

describe("resolveSourceImageUrl — which posts offer the source image", () => {
  it("offers it for an RSS article that has one", () => {
    assert.equal(resolveSourceImageUrl(feedItem("rss", IMAGE)), IMAGE);
  });

  it("offers nothing for a brand-setup post — there is no article", () => {
    assert.equal(resolveSourceImageUrl(null), null);
  });

  it("offers nothing for an RSS article ingested before the column existed", () => {
    // Backward compatibility: an old feed item simply has no image to offer, and
    // everything else about the post is unaffected.
    assert.equal(resolveSourceImageUrl(feedItem("rss", null)), null);
  });

  const nonArticleSources = ["prompt", "calendar_event", "product_page"];
  for (const type of nonArticleSources) {
    it(`offers nothing for a ${type} source`, () => {
      // None of these is an "original article". Even if a row somehow carried a
      // value, the type check keeps the action off these posts.
      assert.equal(resolveSourceImageUrl(feedItem(type, IMAGE)), null);
    });
  }

  it("offers nothing for an unrecognised source type", () => {
    assert.equal(resolveSourceImageUrl(feedItem("something_new", IMAGE)), null);
  });
});
