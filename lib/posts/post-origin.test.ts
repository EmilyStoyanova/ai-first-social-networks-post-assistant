import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  brandSetupOrigin,
  buildOriginSnapshot,
  resolvePostOrigin,
  toOriginSourceType,
  type PostOriginSnapshot,
  type PrimaryFeedItemRow,
} from "./post-origin";

/** The frozen columns as a source post carries them. */
function sourceSnapshot(overrides: Partial<PostOriginSnapshot> = {}): PostOriginSnapshot {
  return {
    originType: "content_source",
    originSourceType: "rss",
    originSourceName: "TechPowerUp",
    originSourceTitle: "Apple ships M5",
    originSourceUrl: "https://example.com/m5",
    ...overrides,
  };
}

const BRAND_SETUP_SNAPSHOT: PostOriginSnapshot = {
  originType: "brand_setup",
  originSourceType: null,
  originSourceName: null,
  originSourceTitle: null,
  originSourceUrl: null,
};

/** A post generated before the snapshot columns existed. */
const LEGACY: PostOriginSnapshot = {
  originType: null,
  originSourceType: null,
  originSourceName: null,
  originSourceTitle: null,
  originSourceUrl: null,
};

const LIVE_ARTICLE: PrimaryFeedItemRow = {
  title: "Apple ships M5",
  url: "https://example.com/m5",
  source: { name: "TechPowerUp", type: "rss" },
};

describe("resolvePostOrigin — Brand Setup post", () => {
  it("reports brand_setup from the snapshot", () => {
    const origin = resolvePostOrigin(BRAND_SETUP_SNAPSHOT, null);

    assert.deepEqual(origin, {
      kind: "brand_setup",
      sourceType: null,
      sourceName: null,
      articleTitle: null,
      articleUrl: null,
    });
  });

  it("stays brand_setup even if an article is somehow still joined", () => {
    // The snapshot is the account of what happened; a stray FK cannot overrule
    // it into naming a source the post was never written from.
    const origin = resolvePostOrigin(BRAND_SETUP_SNAPSHOT, LIVE_ARTICLE);

    assert.equal(origin.kind, "brand_setup");
    assert.equal(origin.sourceType, null);
    assert.equal(origin.sourceName, null);
  });
});

describe("resolvePostOrigin — source-generated post", () => {
  it("reports the frozen source type, name, article title and URL", () => {
    const origin = resolvePostOrigin(sourceSnapshot(), LIVE_ARTICLE);

    assert.deepEqual(origin, {
      kind: "source",
      sourceType: "rss",
      sourceName: "TechPowerUp",
      articleTitle: "Apple ships M5",
      articleUrl: "https://example.com/m5",
    });
  });

  it("carries every source type through unchanged", () => {
    for (const type of ["rss", "prompt", "product_page", "calendar_event"] as const) {
      const origin = resolvePostOrigin(sourceSnapshot({ originSourceType: type }), null);
      assert.equal(origin.sourceType, type);
    }
  });

  it("keeps the URL when the feed shipped no headline", () => {
    const origin = resolvePostOrigin(sourceSnapshot({ originSourceTitle: null }), null);

    assert.equal(origin.kind, "source");
    assert.equal(origin.articleTitle, null);
    assert.equal(origin.articleUrl, "https://example.com/m5");
  });

  it("still reports a source post when the name was never captured", () => {
    const origin = resolvePostOrigin(sourceSnapshot({ originSourceName: null }), null);

    assert.equal(origin.kind, "source");
    assert.equal(origin.sourceType, "rss");
    assert.equal(origin.sourceName, null);
  });

  it("still reports a source post when the type was never captured", () => {
    // Posts frozen by the first origin migration whose article was already gone
    // when the type column arrived: name and URL survive, type does not.
    const origin = resolvePostOrigin(sourceSnapshot({ originSourceType: null }), null);

    assert.equal(origin.kind, "source");
    assert.equal(origin.sourceType, null);
    assert.equal(origin.sourceName, "TechPowerUp");
  });

  it("drops an unrecognised stored type rather than passing it to the UI", () => {
    const origin = resolvePostOrigin(
      // Cast: only a hand-edited row or a future enum value produces this.
      sourceSnapshot({ originSourceType: "newsletter" as never }),
      null
    );

    assert.equal(origin.sourceType, null, "an unknown type must not become a missing i18n key");
    assert.equal(origin.sourceName, "TechPowerUp");
  });
});

describe("resolvePostOrigin — deleted source or feed item", () => {
  it("survives the article being gone entirely", () => {
    // Deleting a ContentSource cascades to its FeedItems, which nulls
    // Post.primaryFeedItemId. Before the snapshot this silently turned every
    // post from that feed into a Brand Setup post.
    const origin = resolvePostOrigin(sourceSnapshot(), null);

    assert.equal(origin.kind, "source");
    assert.equal(origin.sourceType, "rss");
    assert.equal(origin.sourceName, "TechPowerUp");
    assert.equal(origin.articleTitle, "Apple ships M5");
    assert.equal(origin.articleUrl, "https://example.com/m5");
  });

  it("reports the same origin before and after the delete", () => {
    const before = resolvePostOrigin(sourceSnapshot(), LIVE_ARTICLE);
    const after = resolvePostOrigin(sourceSnapshot(), null);

    assert.deepEqual(after, before, "deleting the source must not change the display");
  });
});

describe("resolvePostOrigin — renamed source", () => {
  it("keeps the name the post was published under", () => {
    const renamed: PrimaryFeedItemRow = {
      ...LIVE_ARTICLE,
      source: { name: "TechPowerUp Europe", type: "rss" },
    };

    const origin = resolvePostOrigin(sourceSnapshot(), renamed);

    assert.equal(origin.sourceName, "TechPowerUp", "a rename must not rewrite history");
  });

  it("keeps the type the post was published under", () => {
    // A source retyped from RSS to product page must not relabel old posts.
    const retyped: PrimaryFeedItemRow = {
      ...LIVE_ARTICLE,
      source: { name: "TechPowerUp", type: "product_page" },
    };

    assert.equal(resolvePostOrigin(sourceSnapshot(), retyped).sourceType, "rss");
  });

  it("keeps the article headline the post was written from", () => {
    const edited: PrimaryFeedItemRow = { ...LIVE_ARTICLE, title: "Apple ships M5 Pro (updated)" };

    assert.equal(resolvePostOrigin(sourceSnapshot(), edited).articleTitle, "Apple ships M5");
  });
});

describe("resolvePostOrigin — legacy post without a snapshot", () => {
  it("falls back to the live article, type included", () => {
    const origin = resolvePostOrigin(LEGACY, LIVE_ARTICLE);

    assert.deepEqual(origin, {
      kind: "source",
      sourceType: "rss",
      sourceName: "TechPowerUp",
      articleTitle: "Apple ships M5",
      articleUrl: "https://example.com/m5",
    });
  });

  it("falls back to brand_setup when there is no article either", () => {
    assert.equal(resolvePostOrigin(LEGACY, null).kind, "brand_setup");
  });

  it("treats a missing snapshot object the same as a null originType", () => {
    // Callers that select no origin columns at all (or a row that predates
    // them) must not crash — they land on the same fallback.
    assert.deepEqual(
      resolvePostOrigin(null, LIVE_ARTICLE),
      resolvePostOrigin(LEGACY, LIVE_ARTICLE)
    );
    assert.deepEqual(resolvePostOrigin(null, null), resolvePostOrigin(LEGACY, null));
  });

  it("is the only path a rename or retype can still move", () => {
    const changed: PrimaryFeedItemRow = {
      ...LIVE_ARTICLE,
      source: { name: "TechPowerUp Europe", type: "product_page" },
    };

    // Documented, accepted limitation: pre-migration posts with no snapshot
    // keep reading the live relation, exactly as the app did before.
    const origin = resolvePostOrigin(LEGACY, changed);
    assert.equal(origin.sourceName, "TechPowerUp Europe");
    assert.equal(origin.sourceType, "product_page");
  });

  it("drops an unrecognised live type too", () => {
    const odd: PrimaryFeedItemRow = { ...LIVE_ARTICLE, source: { name: "X", type: "newsletter" } };

    assert.equal(resolvePostOrigin(LEGACY, odd).sourceType, null);
  });
});

describe("buildOriginSnapshot", () => {
  it("stamps content_source from the article the post was built on", () => {
    const snapshot = buildOriginSnapshot({
      title: "Apple ships M5",
      url: "https://example.com/m5",
      sourceType: "rss",
      sourceName: "TechPowerUp",
    });

    assert.deepEqual(snapshot, {
      originType: "content_source",
      originSourceType: "rss",
      originSourceName: "TechPowerUp",
      originSourceTitle: "Apple ships M5",
      originSourceUrl: "https://example.com/m5",
    });
  });

  it("stamps brand_setup with null source fields when there was no article", () => {
    assert.deepEqual(buildOriginSnapshot(null), {
      originType: "brand_setup",
      originSourceType: null,
      originSourceName: null,
      originSourceTitle: null,
      originSourceUrl: null,
    });
  });

  it("freezes each non-RSS source type", () => {
    for (const type of ["prompt", "product_page", "calendar_event"] as const) {
      const snapshot = buildOriginSnapshot({
        title: null,
        url: "https://example.com/x",
        sourceType: type,
        sourceName: "Some source",
      });
      assert.equal(snapshot.originSourceType, type);
    }
  });

  it("normalises absent type and name to null rather than dropping the origin", () => {
    const snapshot = buildOriginSnapshot({ title: null, url: "https://example.com/x" });

    assert.equal(snapshot.originType, "content_source");
    assert.equal(snapshot.originSourceType, null);
    assert.equal(snapshot.originSourceName, null);
    assert.equal(snapshot.originSourceUrl, "https://example.com/x");
  });

  it("refuses to freeze a type it does not recognise", () => {
    const snapshot = buildOriginSnapshot({
      title: null,
      url: "https://example.com/x",
      sourceType: "newsletter",
    });

    assert.equal(snapshot.originSourceType, null);
  });

  it("round-trips through resolvePostOrigin", () => {
    const snapshot = buildOriginSnapshot({
      title: "Apple ships M5",
      url: "https://example.com/m5",
      sourceType: "product_page",
      sourceName: "Apple",
    });

    // What generation writes is what the card reads, with no article joined.
    assert.deepEqual(resolvePostOrigin(snapshot, null), {
      kind: "source",
      sourceType: "product_page",
      sourceName: "Apple",
      articleTitle: "Apple ships M5",
      articleUrl: "https://example.com/m5",
    });
  });
});

describe("toOriginSourceType", () => {
  it("accepts every ContentSourceType value", () => {
    for (const type of ["rss", "prompt", "product_page", "calendar_event"]) {
      assert.equal(toOriginSourceType(type), type);
    }
  });

  it("rejects anything else", () => {
    for (const value of ["newsletter", "", "RSS", null, undefined]) {
      assert.equal(toOriginSourceType(value), null);
    }
  });
});

describe("brandSetupOrigin", () => {
  it("matches what a brand_setup snapshot resolves to", () => {
    assert.deepEqual(brandSetupOrigin(), resolvePostOrigin(buildOriginSnapshot(null), null));
  });
});
