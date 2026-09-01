/**
 * 2026-09 content-acquisition fix — the ingestion-side half.
 *
 * See `ingest-competitor-source.service.ts`'s module comment for the incident.
 * These cover the two pure decisions that fix it, extracted from the ingestion
 * loop specifically so they are testable without a database:
 *
 *   • `shouldOverwriteFeedItemContent` — a re-ingest must never downgrade a
 *     better answer already on file (the "don't overwrite a full article with
 *     a weaker summary" rule).
 *   • `feedItemContentChanged` — the signal that reopens a settled
 *     `CompetitorIntelligence` row when content goes missing → usable, so a
 *     `missing_content` failure recovers with no manual DB editing.
 *
 * The end-to-end fallback hierarchy itself lives in
 * `lib/integrations/rss/article-extractor.test.ts`; the parser-level cause
 * (`<content:encoded>`) in `lib/integrations/rss/parser.test.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  shouldOverwriteFeedItemContent,
  feedItemContentChanged,
} from "./ingest-competitor-source.service";
import { resolveArticleContent } from "@/lib/integrations/rss/article-extractor";
import type { ExtractionMethod } from "@/lib/integrations/rss/article-strategies";

function stored(method: ExtractionMethod | null, complete: boolean | null) {
  return { contentExtraction: method, contentComplete: complete };
}

function incoming(method: ExtractionMethod | null, complete: boolean) {
  return { method, complete };
}

describe("shouldOverwriteFeedItemContent — a re-ingest never downgrades", () => {
  it("refuses to replace a full article with a feed summary", () => {
    // The site started blocking reads between two ingests. The article we
    // already have is still the best answer available — keep it.
    assert.equal(
      shouldOverwriteFeedItemContent(stored("readability", true), incoming("rss_summary", false)),
      false
    );
  });

  it("refuses to replace a full article with the feed's full body", () => {
    assert.equal(
      shouldOverwriteFeedItemContent(stored("json_ld", true), incoming("rss_full_content", false)),
      false
    );
  });

  it("refuses to replace the feed's full body with its summary", () => {
    assert.equal(
      shouldOverwriteFeedItemContent(
        stored("rss_full_content", false),
        incoming("rss_summary", false)
      ),
      false
    );
  });

  it("refuses to replace anything with nothing at all", () => {
    assert.equal(
      shouldOverwriteFeedItemContent(stored("rss_summary", false), incoming(null, false)),
      false
    );
  });

  it("ACCEPTS an upgrade from a summary to a real article", () => {
    // The exact recovery path: the page became readable.
    assert.equal(
      shouldOverwriteFeedItemContent(stored("rss_summary", false), incoming("readability", true)),
      true
    );
  });

  it("ACCEPTS an upgrade from a summary to the feed's full body", () => {
    assert.equal(
      shouldOverwriteFeedItemContent(
        stored("rss_summary", false),
        incoming("rss_full_content", false)
      ),
      true
    );
  });

  it("ACCEPTS the real incident's fix path: nothing stored → feed full body", () => {
    // The 10 affected rows: content null, no provenance, and the feed body
    // now parseable. This must write.
    assert.equal(
      shouldOverwriteFeedItemContent(stored(null, null), incoming("rss_full_content", false)),
      true
    );
  });

  it("ACCEPTS a same-tier re-read — only a genuine downgrade is refused", () => {
    // The article was edited; still a readability read. That is a legitimate
    // update, not a downgrade.
    assert.equal(
      shouldOverwriteFeedItemContent(stored("readability", true), incoming("readability", true)),
      true
    );
    assert.equal(
      shouldOverwriteFeedItemContent(stored("rss_summary", false), incoming("rss_summary", false)),
      true
    );
  });

  it("treats a null contentComplete (pre-provenance legacy row) as not complete", () => {
    // Rows written before provenance columns existed carry nulls. They must
    // not be mistaken for verified article reads and thereby become
    // un-upgradeable.
    assert.equal(
      shouldOverwriteFeedItemContent(stored(null, null), incoming("readability", true)),
      true
    );
  });
});

describe("feedItemContentChanged — the missing_content recovery signal", () => {
  it("fires when content goes from missing to usable", () => {
    // The whole point: a row that failed `missing_content` becomes eligible
    // again the moment ingestion finally obtains real text.
    assert.equal(feedItemContentChanged(null, "The article body, finally readable."), true);
  });

  it("does NOT fire when content is still missing", () => {
    // A no-op re-ingest of a page that is still blocked must not reset the
    // row's attempt budget — that is how the original livelock happened.
    assert.equal(feedItemContentChanged(null, null), false);
  });

  it("does NOT fire when the same content is re-ingested unchanged", () => {
    const body = "Identical article text on both runs.";
    assert.equal(feedItemContentChanged(body, body), false);
  });

  it("does NOT fire when a downgrade would have produced null", () => {
    // Paired with shouldOverwriteFeedItemContent: a run that resolves nothing
    // neither overwrites nor reopens.
    assert.equal(feedItemContentChanged("A good article already on file.", null), false);
  });

  it("fires when the article text genuinely changed", () => {
    assert.equal(feedItemContentChanged("Old body.", "Revised body."), true);
  });
});

describe("2026-09 incident — end to end through the real resolver", () => {
  const BLOCKED_PAGE = {
    text: null,
    method: null,
    error: "http_403",
    metaImageUrl: null,
    contentImageUrl: null,
  };
  const FEED_BODY = "The full article body the publisher shipped inside content:encoded. ".repeat(
    5
  );

  it("the exact affected shape now yields storable content AND reopens the row", () => {
    // Medium: page 403s, feed ships the body in <content:encoded> only.
    const article = resolveArticleContent(BLOCKED_PAGE, null, FEED_BODY);

    assert.notEqual(article.content, null, "this used to be null — the whole bug");
    assert.equal(article.method, "rss_full_content");

    // Against the affected rows' real stored state (content null, no
    // provenance): both decisions must say "yes".
    assert.equal(
      shouldOverwriteFeedItemContent(stored(null, null), {
        method: article.method,
        complete: article.complete,
      }),
      true
    );
    assert.equal(feedItemContentChanged(null, article.content), true);
  });

  it("a second identical ingest is a no-op — it does not re-reset the row", () => {
    const article = resolveArticleContent(BLOCKED_PAGE, null, FEED_BODY);
    // Now that the first ingest stored it, the same feed on the next run:
    assert.equal(feedItemContentChanged(article.content, article.content), false);
  });

  it("a later run that recovers the real article page upgrades cleanly", () => {
    const first = resolveArticleContent(BLOCKED_PAGE, null, FEED_BODY);
    const readable = {
      text: "A genuinely extracted article body, read from the page itself.".repeat(6),
      method: "readability" as const,
      error: null,
      metaImageUrl: null,
      contentImageUrl: null,
    };
    const second = resolveArticleContent(readable, null, FEED_BODY);

    assert.equal(second.method, "readability");
    assert.equal(second.complete, true);
    assert.equal(
      shouldOverwriteFeedItemContent(stored(first.method, first.complete), {
        method: second.method,
        complete: second.complete,
      }),
      true
    );
    assert.equal(feedItemContentChanged(first.content, second.content), true);
  });

  it("and the reverse — page blocked again — keeps the good article", () => {
    const good = {
      text: "A genuinely extracted article body, read from the page itself.".repeat(6),
      method: "readability" as const,
      error: null,
      metaImageUrl: null,
      contentImageUrl: null,
    };
    const stored1 = resolveArticleContent(good, null, FEED_BODY);
    const later = resolveArticleContent(BLOCKED_PAGE, null, FEED_BODY);

    assert.equal(
      shouldOverwriteFeedItemContent(stored(stored1.method, stored1.complete), {
        method: later.method,
        complete: later.complete,
      }),
      false,
      "the full article must survive a subsequent blocked read"
    );
  });
});
