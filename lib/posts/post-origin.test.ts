import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  brandSetupOrigin,
  buildOriginSnapshot,
  resolvePostOrigin,
  type PostOriginSnapshot,
  type PrimaryFeedItemRow,
} from "./post-origin";

/** The frozen columns as a source post carries them. */
function sourceSnapshot(overrides: Partial<PostOriginSnapshot> = {}): PostOriginSnapshot {
  return {
    originType: "content_source",
    originSourceName: "TechCrunch",
    originSourceTitle: "Apple ships M5",
    originSourceUrl: "https://example.com/m5",
    ...overrides,
  };
}

/** A post generated before the snapshot columns existed. */
const LEGACY: PostOriginSnapshot = {
  originType: null,
  originSourceName: null,
  originSourceTitle: null,
  originSourceUrl: null,
};

const LIVE_ARTICLE: PrimaryFeedItemRow = {
  title: "Apple ships M5",
  url: "https://example.com/m5",
  source: { name: "TechCrunch" },
};

describe("resolvePostOrigin — Brand Setup post", () => {
  it("reports brand_setup from the snapshot", () => {
    const origin = resolvePostOrigin(
      {
        originType: "brand_setup",
        originSourceName: null,
        originSourceTitle: null,
        originSourceUrl: null,
      },
      null
    );

    assert.deepEqual(origin, {
      kind: "brand_setup",
      sourceName: null,
      articleTitle: null,
      articleUrl: null,
    });
  });

  it("stays brand_setup even if an article is somehow still joined", () => {
    // The snapshot is the account of what happened; a stray FK cannot overrule
    // it into naming a source the post was never written from.
    const origin = resolvePostOrigin(
      {
        originType: "brand_setup",
        originSourceName: null,
        originSourceTitle: null,
        originSourceUrl: null,
      },
      LIVE_ARTICLE
    );

    assert.equal(origin.kind, "brand_setup");
    assert.equal(origin.sourceName, null);
  });
});

describe("resolvePostOrigin — source-generated post", () => {
  it("reports the frozen source name, article title and URL", () => {
    const origin = resolvePostOrigin(sourceSnapshot(), LIVE_ARTICLE);

    assert.deepEqual(origin, {
      kind: "source",
      sourceName: "TechCrunch",
      articleTitle: "Apple ships M5",
      articleUrl: "https://example.com/m5",
    });
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
    assert.equal(origin.sourceName, null);
  });
});

describe("resolvePostOrigin — deleted source or feed item", () => {
  it("survives the article being gone entirely", () => {
    // Deleting a ContentSource cascades to its FeedItems, which nulls
    // Post.primaryFeedItemId. Before the snapshot this silently turned every
    // post from that feed into a Brand Setup post.
    const origin = resolvePostOrigin(sourceSnapshot(), null);

    assert.equal(origin.kind, "source");
    assert.equal(origin.sourceName, "TechCrunch");
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
      source: { name: "TechCrunch Europe" },
    };

    const origin = resolvePostOrigin(sourceSnapshot(), renamed);

    assert.equal(origin.sourceName, "TechCrunch", "a rename must not rewrite history");
  });

  it("keeps the article headline the post was written from", () => {
    const edited: PrimaryFeedItemRow = { ...LIVE_ARTICLE, title: "Apple ships M5 Pro (updated)" };

    const origin = resolvePostOrigin(sourceSnapshot(), edited);

    assert.equal(origin.articleTitle, "Apple ships M5");
  });
});

describe("resolvePostOrigin — legacy post without a snapshot", () => {
  it("falls back to the live article", () => {
    const origin = resolvePostOrigin(LEGACY, LIVE_ARTICLE);

    assert.deepEqual(origin, {
      kind: "source",
      sourceName: "TechCrunch",
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

  it("is the only path a rename can still move", () => {
    const renamed: PrimaryFeedItemRow = { ...LIVE_ARTICLE, source: { name: "TechCrunch Europe" } };

    // Documented, accepted limitation: pre-migration posts with no snapshot
    // keep reading the live relation, exactly as the app did before.
    assert.equal(resolvePostOrigin(LEGACY, renamed).sourceName, "TechCrunch Europe");
  });
});

describe("buildOriginSnapshot", () => {
  it("stamps content_source from the article the post was built on", () => {
    const snapshot = buildOriginSnapshot({
      title: "Apple ships M5",
      url: "https://example.com/m5",
      sourceName: "TechCrunch",
    });

    assert.deepEqual(snapshot, {
      originType: "content_source",
      originSourceName: "TechCrunch",
      originSourceTitle: "Apple ships M5",
      originSourceUrl: "https://example.com/m5",
    });
  });

  it("stamps brand_setup with null source fields when there was no article", () => {
    assert.deepEqual(buildOriginSnapshot(null), {
      originType: "brand_setup",
      originSourceName: null,
      originSourceTitle: null,
      originSourceUrl: null,
    });
  });

  it("normalises an absent source name to null rather than dropping the origin", () => {
    const snapshot = buildOriginSnapshot({ title: null, url: "https://example.com/x" });

    assert.equal(snapshot.originType, "content_source");
    assert.equal(snapshot.originSourceName, null);
    assert.equal(snapshot.originSourceUrl, "https://example.com/x");
  });

  it("round-trips through resolvePostOrigin", () => {
    const snapshot = buildOriginSnapshot({
      title: "Apple ships M5",
      url: "https://example.com/m5",
      sourceName: "TechCrunch",
    });

    // What generation writes is what the card reads, with no article joined.
    assert.deepEqual(resolvePostOrigin(snapshot, null), {
      kind: "source",
      sourceName: "TechCrunch",
      articleTitle: "Apple ships M5",
      articleUrl: "https://example.com/m5",
    });
  });
});

describe("brandSetupOrigin", () => {
  it("matches what a brand_setup snapshot resolves to", () => {
    assert.deepEqual(brandSetupOrigin(), resolvePostOrigin(buildOriginSnapshot(null), null));
  });
});
