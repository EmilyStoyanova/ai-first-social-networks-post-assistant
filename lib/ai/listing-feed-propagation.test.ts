/**
 * Every place a ContentSourceType decision is taken, checked for `listing_feed`
 * AND re-checked for the four types that existed before it.
 *
 * This file exists because of a specific past failure: `ContentSourceType` was
 * widened and the hand-mirrored `OriginSourceType` was not, so posts from the new
 * type silently rendered with no source badge. Nothing about that was caught by
 * the type checker, because the two are related only by a comment.
 *
 * So the rule here is that the Prisma enum is the source of truth and is
 * ENUMERATED, not sampled: `ContentSourceType` is imported and every one of its
 * members is asserted against every derived predicate. A member added to the enum
 * without a decision recorded here fails this suite rather than reaching a user.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ContentSourceType } from "@prisma/client";
import { isConsumableSourceType, isPerItemSourceType, providesSourceImage } from "./source-types";
import { isClassifiableSourceType } from "./feed-item-classification";
import { isTranslatableSourceType } from "./feed-item-translation";
import { toOriginSourceType, buildOriginSnapshot } from "@/lib/posts/post-origin";
import { resolveManualContentSource, toSourceScope } from "./manual-content-source";
import { contentSourceSchema } from "@/lib/validators/content-source.schema";
import {
  renderFeedItemContent,
  framePrimarySource,
  sourceExtractionInstruction,
} from "./source-content";
import type { FeedItemContext } from "./types";

/** Every member of the Prisma enum, as a runtime list. */
const ALL_TYPES = Object.values(ContentSourceType) as string[];

/** The generation-eligible types — competitor sources can never back a post. */
const POST_TYPES = ALL_TYPES.filter((t) => !t.startsWith("competitor_"));

describe("the enum is what this suite thinks it is", () => {
  it("still contains exactly the members these expectations were written for", () => {
    // A guard on the guards: if this fails, a type was added and every table
    // below needs a deliberate decision rather than a passing default.
    assert.deepEqual(ALL_TYPES.sort(), [
      "calendar_event",
      "competitor_rss",
      "competitor_website",
      "listing_feed",
      "product_page",
      "prompt",
      "rss",
    ]);
  });
});

// ─── The mirrored union that broke last time ──────────────────────────────────

describe("OriginSourceType mirrors every post-bearing ContentSourceType", () => {
  it("narrows every generation-eligible type to itself, never to null", () => {
    for (const type of POST_TYPES) {
      assert.equal(
        toOriginSourceType(type),
        type,
        `${type} degrades to null — it would render with no source badge`
      );
    }
  });

  it("still degrades a competitor type and an unknown string to null", () => {
    assert.equal(toOriginSourceType("competitor_rss"), null);
    assert.equal(toOriginSourceType("competitor_website"), null);
    assert.equal(toOriginSourceType("something_new"), null);
    assert.equal(toOriginSourceType(null), null);
  });

  it("freezes a listing post's origin with its type, name and listing URL", () => {
    const snapshot = buildOriginSnapshot({
      title: "Яхта Rinker 230",
      url: "https://qhti.bg/obiavi/obiava-476-yahta-rinker-230",
      sourceType: "listing_feed",
      sourceName: "QHTI Active Listings",
    });

    assert.equal(snapshot.originType, "content_source");
    assert.equal(snapshot.originSourceType, "listing_feed");
    assert.equal(
      snapshot.originSourceUrl,
      "https://qhti.bg/obiavi/obiava-476-yahta-rinker-230",
      "the frozen origin points at the listing, not the marketplace"
    );
  });
});

// ─── Behavioural predicates, enumerated ───────────────────────────────────────

describe("source-type predicates", () => {
  const EXPECTED: Record<string, { consumable: boolean; perItem: boolean; image: boolean }> = {
    rss: { consumable: true, perItem: true, image: true },
    listing_feed: { consumable: true, perItem: true, image: true },
    // Consumable but NOT per-item: ingestion writes one row for the whole page,
    // so it is read directly and never reserved.
    product_page: { consumable: true, perItem: false, image: false },
    prompt: { consumable: false, perItem: false, image: false },
    calendar_event: { consumable: false, perItem: false, image: false },
    competitor_rss: { consumable: false, perItem: false, image: false },
    competitor_website: { consumable: false, perItem: false, image: false },
  };

  it("classifies every enum member explicitly", () => {
    for (const type of ALL_TYPES) {
      const expected = EXPECTED[type];
      assert.ok(expected, `${type} has no recorded expectation`);
      assert.equal(isConsumableSourceType(type), expected.consumable, `consumable: ${type}`);
      assert.equal(isPerItemSourceType(type), expected.perItem, `perItem: ${type}`);
      assert.equal(providesSourceImage(type), expected.image, `sourceImage: ${type}`);
    }
  });

  it("leaves classification and translation to RSS alone", () => {
    // A listing's fields are canonical short values and its title is the
    // seller's own wording; neither is classified nor translated.
    for (const type of ALL_TYPES) {
      assert.equal(isClassifiableSourceType(type), type === "rss", `classifiable: ${type}`);
      assert.equal(isTranslatableSourceType(type), type === "rss", `translatable: ${type}`);
    }
  });
});

// ─── Manual generation routing ────────────────────────────────────────────────

describe("manual pick routing", () => {
  const pick = (sourceType: string) =>
    resolveManualContentSource({ kind: "source", sourceId: "s1" }, sourceType);

  it("sends a listing feed down the RESERVING path, like RSS", () => {
    // This is what claims one listing, marks it used, and sets
    // Post.primaryFeedItemId — which is what gives the post its listing link.
    const selection = pick("listing_feed");
    assert.equal(selection?.kind, "rss_source");
    assert.deepEqual(toSourceScope(selection!), { kind: "source", sourceId: "s1" });
  });

  it("leaves rss on the reserving path", () => {
    assert.equal(pick("rss")?.kind, "rss_source");
  });

  it("leaves product page, prompt and calendar on the DIRECT path, unchanged", () => {
    for (const type of ["product_page", "prompt", "calendar_event"]) {
      const selection = pick(type);
      assert.equal(selection?.kind, "content_source", `${type} must stay direct`);
      assert.deepEqual(toSourceScope(selection!), { kind: "content_source", sourceId: "s1" });
    }
  });
});

// ─── Validation ───────────────────────────────────────────────────────────────

describe("content source validation", () => {
  it("accepts a listing feed with a known provider", () => {
    const result = contentSourceSchema.safeParse({
      type: "listing_feed",
      name: "QHTI Active Listings",
      config: { provider: "qhti", extractionInstructions: "Model, price, location." },
    });
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  });

  it("accepts a listing feed with no instruction", () => {
    assert.ok(
      contentSourceSchema.safeParse({
        type: "listing_feed",
        name: "QHTI",
        config: { provider: "qhti" },
      }).success
    );
  });

  it("rejects an unknown provider rather than storing an unreadable source", () => {
    assert.equal(
      contentSourceSchema.safeParse({
        type: "listing_feed",
        name: "Made up",
        config: { provider: "not-a-provider" },
      }).success,
      false
    );
  });

  it("rejects an empty instruction string, which is a malformed payload", () => {
    assert.equal(
      contentSourceSchema.safeParse({
        type: "listing_feed",
        name: "QHTI",
        config: { provider: "qhti", extractionInstructions: "" },
      }).success,
      false
    );
  });

  it("still accepts the four pre-existing source types unchanged", () => {
    const cases = [
      { type: "rss", name: "Feed", config: { url: "https://example.test/feed.xml" } },
      { type: "prompt", name: "Brief", config: { promptText: "Write about us." } },
      { type: "product_page", name: "Page", config: { url: "https://example.test/p" } },
      {
        type: "calendar_event",
        name: "DEV.BG",
        config: { title: "Launch", date: "2026-10-01" },
      },
    ];
    for (const input of cases) {
      assert.ok(contentSourceSchema.safeParse(input).success, `${input.type} must still validate`);
    }
  });
});

// ─── Prompt rendering ─────────────────────────────────────────────────────────

function listingItem(overrides: Partial<FeedItemContext> = {}): FeedItemContext {
  return {
    id: "f1",
    title: "Яхта Rinker 230",
    url: "https://qhti.bg/obiavi/obiava-476-yahta-rinker-230",
    content: JSON.stringify({
      provider: "qhti",
      externalId: "476",
      fields: [{ label: "Price", value: "74999" }],
      omitted: ["year"],
      basis: "instructed",
    }),
    sourceType: "listing_feed",
    sourceName: "QHTI",
    consumable: true,
    ...overrides,
  } as FeedItemContext;
}

describe("listing rendering in the generation prompt", () => {
  it("renders the listing's fields, not raw JSON", () => {
    const text = renderFeedItemContent(listingItem());
    assert.ok(text.includes("**Яхта Rinker 230**"), "title heading");
    assert.ok(text.includes("Price: 74999"));
    assert.ok(!text.includes('{"provider"'), "the model must never see raw JSON");
  });

  it("frames a listing as one item for sale, not as an article", () => {
    const framing = framePrimarySource(listingItem());
    assert.ok(/MARKETPLACE LISTING/.test(framing.heading));
    assert.ok(!/ARTICLE/.test(framing.heading));
    assert.ok(/link to this exact listing will be attached/i.test(framing.instruction));
  });

  it("falls back to raw text when a listing row will not parse", () => {
    const text = renderFeedItemContent(listingItem({ content: "legacy plain text" }));
    assert.ok(text.includes("legacy plain text"));
  });

  // ── Extraction is an ingestion concern, not a Writer concern ──────────────
  //
  // `sourceExtractionInstruction` is what prompt-builder renders under "Required
  // content — the source's own extraction instruction… Cover EVERY item the
  // source block provides". That is list semantics for a page of many things, and
  // applying it to a post about ONE boat is the bug this block guards.
  it("hands the Writer NO extraction instruction for a listing", () => {
    assert.equal(sourceExtractionInstruction(listingItem()), null);
  });

  it("still hands the Writer a product page's instruction, unchanged", () => {
    const productPage = listingItem({
      sourceType: "product_page",
      content: JSON.stringify({
        title: "Events",
        instructions: "Every event next week, with date and venue.",
        pageText: "…",
      }),
    });
    assert.equal(
      sourceExtractionInstruction(productPage),
      "Every event next week, with date and venue."
    );
  });

  it("leaves aspect mining enabled for listings, as for any ordinary source", () => {
    // resolve-generation-aspect stands down only when an extraction instruction
    // is present. A listing has none at generation time, so the default pipeline
    // applies — which is what "keep the Writer pipeline unchanged" means here.
    assert.equal(sourceExtractionInstruction(listingItem()), null);
    assert.equal(sourceExtractionInstruction(listingItem({ sourceType: "rss" })), null);
  });

  it("leaves the RSS framing byte-for-byte unchanged", () => {
    // Changing this wording would change generation output on the RSS and cron
    // paths, which is exactly what must not happen here.
    const framing = framePrimarySource(listingItem({ sourceType: "rss" }));
    assert.equal(
      framing.heading,
      "**PRIMARY SOURCE ARTICLE — the post MUST be based on THIS article and no other.**"
    );
  });

  it("leaves plain RSS content rendering unchanged", () => {
    const text = renderFeedItemContent(
      listingItem({ sourceType: "rss", content: "An article body.", title: "Headline" })
    );
    assert.equal(text, "**Headline**\nAn article body.");
  });
});
