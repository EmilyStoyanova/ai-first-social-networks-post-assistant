import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolvePrimarySelection, previewPrimaryItem } from "./primary-feed-item";
import { resolvePostSourceLink } from "./source-link";
import { buildPrompts } from "./prompt-builder";
import { buildPrimaryFingerprint } from "./aspect-extractor";
import type { FeedItemContext, GenerationContext } from "./types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeItem(overrides: Partial<FeedItemContext> & { id: string }): FeedItemContext {
  return {
    id: overrides.id,
    title: overrides.title ?? `Title ${overrides.id}`,
    content: overrides.content ?? `Content for ${overrides.id}`,
    url: overrides.url ?? `https://news.example.com/${overrides.id}`,
    publishedAt: overrides.publishedAt ?? null,
    sourceLinkPreference: overrides.sourceLinkPreference,
    consumable: overrides.consumable,
    // Left absent unless a case sets it, so the article fixtures keep exercising
    // the pre-existing "derive the link from `url`" behaviour.
    ...("publicUrl" in overrides ? { publicUrl: overrides.publicUrl } : {}),
  };
}

function makeCtx(feedItems: FeedItemContext[]): GenerationContext {
  return {
    company: { name: "Acme", website: null, automationMode: "semi_automated", defaultLang: "en" },
    brand: null,
    channel: {
      channel: "facebook",
      postingLanguage: "en",
      imageRequired: false,
      automationModeOverride: null,
      maxTextLength: null,
      includeSourceLink: true,
      autoGenerateImage: false,
    },
    feedItems,
    hasArticleSources: feedItems.length > 0,
  };
}

// The production bug: a post about a university closure carrying the URL of an
// unrelated article from the same feed.
const CLOSURE = makeItem({
  id: "closure",
  title: "University closes campus after funding cut",
  content: "Students were told the campus will shut at the end of term.",
  url: "https://news.example.com/university-closure",
});
const WEATHER = makeItem({
  id: "weather",
  title: "Storm warning issued for the coast",
  content: "Forecasters expect high winds through the weekend.",
  url: "https://news.example.com/storm-warning",
});
const EVERGREEN = makeItem({
  id: "prompt-1",
  title: "Brand prompt",
  content: "Talk about our craftsmanship.",
  url: "prompt:prompt-1",
  consumable: false,
});

// A product page's stored extraction. Consumable by TYPE (it is an article
// source), but read directly when the user picks it — the "direct" plan. Its URL
// is a real page, unlike the synthetic one an evergreen item carries.
const PRODUCT_PAGE = makeItem({
  id: "pp-1",
  title: "Pro Plan",
  content: '{"title":"Pro Plan","description":"Everything in Starter, plus SSO."}',
  url: "https://shop.example.com/pro-plan",
});

// ─── resolvePrimarySelection ──────────────────────────────────────────────────

describe("resolvePrimarySelection", () => {
  it("selects the CLAIMED article, not the first one in the array", () => {
    // The heart of the bug class: the reservation may win any candidate, because
    // a concurrent run can take the first. Selecting positionally would disagree
    // with the row we actually hold the claim on.
    const selection = resolvePrimarySelection([WEATHER, CLOSURE], {
      action: "generate",
      feedItemId: "closure",
    });
    assert.equal(selection.item?.id, "closure");
    assert.equal(selection.claimedFeedItemId, "closure");
    assert.equal(selection.sourceUrl, CLOSURE.url);
  });

  it("keeps sourceUrl and claimedFeedItemId tied to the same item", () => {
    for (const id of ["closure", "weather"]) {
      const selection = resolvePrimarySelection([WEATHER, CLOSURE], {
        action: "generate",
        feedItemId: id,
      });
      assert.equal(selection.sourceUrl, selection.item!.url, `${id}: url matches the item`);
      assert.equal(selection.claimedFeedItemId, selection.item!.id, `${id}: id matches the item`);
    }
  });

  it("throws rather than guess when the claimed item is not in context", () => {
    // Impossible by construction; if it ever happened, writing a post from some
    // other article would be far worse than failing loudly.
    assert.throws(
      () => resolvePrimarySelection([WEATHER], { action: "generate", feedItemId: "closure" }),
      /not present in the generation context/
    );
  });

  it("picks an evergreen item with no claim and no URL", () => {
    const selection = resolvePrimarySelection([EVERGREEN], { action: "evergreen" });
    assert.equal(selection.item?.id, "prompt-1");
    assert.equal(selection.claimedFeedItemId, null, "evergreen items are never consumed");
    assert.equal(selection.sourceUrl, null, "prompt: urls must never reach a reader");
  });

  it("never picks an article for the evergreen path", () => {
    // An article that raced away between context build and claim must not become
    // the subject of a post that does not reserve it.
    const selection = resolvePrimarySelection([CLOSURE, EVERGREEN], { action: "evergreen" });
    assert.equal(selection.item?.id, "prompt-1");
  });

  it("has no primary for a mission post", () => {
    const selection = resolvePrimarySelection([], { action: "mission" });
    assert.deepEqual(selection, { item: null, claimedFeedItemId: null, sourceUrl: null });
  });

  it("reads a direct content source's latest item, claiming nothing", () => {
    // A manually picked product page. The window is already scoped to that one
    // source and ordered newest-first, so the first item IS its latest
    // extraction — and nothing is reserved, so primaryFeedItemId stays null.
    const selection = resolvePrimarySelection([PRODUCT_PAGE], { action: "direct" });
    assert.equal(selection.item?.id, "pp-1");
    assert.equal(selection.claimedFeedItemId, null, "a direct source is never consumed");
    assert.equal(selection.sourceUrl, PRODUCT_PAGE.url, "the product page URL is linkable");
  });

  it("keeps the real page URL on a direct product-page post", () => {
    // Unlike the evergreen path, which suppresses the URL because prompt:/event:
    // urls are synthetic, a product page has an actual page a reader can open.
    const selection = resolvePrimarySelection([PRODUCT_PAGE], { action: "direct" });
    assert.equal(selection.sourceUrl, "https://shop.example.com/pro-plan");
  });

  it("suppresses the synthetic URL of a directly-picked prompt source", () => {
    // Picking a prompt source directly is allowed; linking `prompt:<id>` is not.
    const selection = resolvePrimarySelection([EVERGREEN], { action: "direct" });
    assert.equal(selection.item?.id, "prompt-1");
    assert.equal(selection.sourceUrl, null);
  });

  it("has no primary when a direct source has nothing stored", () => {
    const selection = resolvePrimarySelection([], { action: "direct" });
    assert.deepEqual(selection, { item: null, claimedFeedItemId: null, sourceUrl: null });
  });
});

// ─── Calendar events and their optional Event URL ─────────────────────────────
//
// A calendar item's `url` is always the internal `event:<sourceId>` key. Its
// public address, when it has one, is resolved by the context builder onto
// `publicUrl` — so linkability is a property of the item, not of its storage key.

describe("resolvePrimarySelection — calendar events", () => {
  const EVENT_URL = "https://www.events.dev.bg/allinone/2026";

  function calendarItem(publicUrl: string | null): FeedItemContext {
    return makeItem({
      id: "cal-1",
      title: "DEV.BG All in One 2026",
      content: '{"title":"DEV.BG All in One 2026","date":"2026-08-29","description":null}',
      url: "event:src-cal",
      consumable: false,
      publicUrl,
    });
  }

  it("links a directly-picked event that has an Event URL", () => {
    const selection = resolvePrimarySelection([calendarItem(EVENT_URL)], { action: "direct" });

    assert.equal(selection.item?.id, "cal-1");
    assert.equal(selection.claimedFeedItemId, null, "an event is never consumed");
    assert.equal(selection.sourceUrl, EVENT_URL);
  });

  it("links an event picked through the evergreen (cron) path too", () => {
    // Same rule wherever the event is reached from — scheduled generation must
    // not silently drop a link the manual path would attach.
    const selection = resolvePrimarySelection([calendarItem(EVENT_URL)], { action: "evergreen" });

    assert.equal(selection.item?.id, "cal-1");
    assert.equal(selection.sourceUrl, EVENT_URL);
  });

  it("has no link for an event whose Event URL was left blank", () => {
    // Every calendar source created before the field existed.
    for (const action of ["direct", "evergreen"] as const) {
      const selection = resolvePrimarySelection([calendarItem(null)], { action });
      assert.equal(selection.item?.id, "cal-1", `${action}: still generates from the event`);
      assert.equal(selection.sourceUrl, null, `${action}: nothing to link`);
    }
  });

  it("never leaks the event: key, whether or not an Event URL is set", () => {
    for (const publicUrl of [EVENT_URL, null]) {
      for (const action of ["direct", "evergreen"] as const) {
        const selection = resolvePrimarySelection([calendarItem(publicUrl)], { action });
        assert.ok(
          !selection.sourceUrl?.startsWith("event:"),
          `${action}/${publicUrl}: the storage key must never be the link`
        );
      }
    }
  });

  it("appends the Event URL to the post text through the source-link resolver", () => {
    const primary = resolvePrimarySelection([calendarItem(EVENT_URL)], { action: "direct" });
    const link = resolvePostSourceLink({
      primary,
      text: "Ще се видим на конференцията.",
      manualOverride: undefined,
      channelDefault: true,
      maxTextLength: null,
    });

    assert.ok(link.ok);
    if (!link.ok) return;
    assert.ok(link.data.finalContent.includes(EVENT_URL));
    assert.equal(link.data.sourceUrl, EVENT_URL);
    assert.equal(link.data.primaryFeedItemId, null, "still nothing reserved");
  });

  it("appends nothing for an event with no Event URL", () => {
    const primary = resolvePrimarySelection([calendarItem(null)], { action: "direct" });
    const link = resolvePostSourceLink({
      primary,
      text: "Ще се видим на конференцията.",
      manualOverride: undefined,
      channelDefault: true,
      maxTextLength: null,
    });

    assert.ok(link.ok);
    if (!link.ok) return;
    assert.equal(link.data.finalContent, "Ще се видим на конференцията.");
    assert.equal(link.data.sourceUrl, null);
  });
});

// ─── the whole pipeline agrees on one article ─────────────────────────────────

describe("primary selection — every consumer agrees on one article", () => {
  it("prompt, URL, id and aspect pool all follow the claimed article", () => {
    // The full invariant, asserted end to end on the exact production scenario:
    // two articles in one feed window, and the SECOND one is claimed.
    const feedItems = [WEATHER, CLOSURE];
    const primary = resolvePrimarySelection(feedItems, {
      action: "generate",
      feedItemId: "closure",
    });

    const { userPrompt } = buildPrompts(makeCtx(feedItems), primary.item, "en");
    const link = resolvePostSourceLink({
      primary,
      text: "Students face disruption as the campus closes.",
      manualOverride: undefined,
      channelDefault: true,
      maxTextLength: null,
    });

    assert.equal(link.ok, true);
    if (!link.ok) return;

    // 1. The prompt is built around the claimed article.
    const primaryIdx = userPrompt.indexOf("PRIMARY SOURCE ARTICLE");
    const backgroundIdx = userPrompt.indexOf("Additional background context");
    const closureIdx = userPrompt.indexOf(CLOSURE.title!);
    assert.ok(primaryIdx < backgroundIdx, "primary section precedes background");
    assert.ok(
      closureIdx > primaryIdx && closureIdx < backgroundIdx,
      "the claimed article sits in the PRIMARY section"
    );
    assert.ok(
      userPrompt.indexOf(WEATHER.title!) > backgroundIdx,
      "the unclaimed article is background only"
    );

    // 2–5. Everything the post records points at the same article.
    assert.equal(link.data.sourceUrl, CLOSURE.url);
    assert.equal(link.data.primaryFeedItemId, "closure");
    assert.equal(link.data.sourceTitle, CLOSURE.title);
    assert.ok(link.data.finalContent.endsWith(CLOSURE.url));
    assert.equal(primary.claimedFeedItemId, "closure", "the reserved item is the same one");

    // 6. The aspect pool is keyed to it, so no other article's aspect can steer it.
    assert.equal(buildPrimaryFingerprint(primary.item), buildPrimaryFingerprint(CLOSURE));
  });

  it("a background article can never supply the appended URL", () => {
    // The reported symptom, stated directly.
    const feedItems = [WEATHER, CLOSURE];
    const primary = resolvePrimarySelection(feedItems, {
      action: "generate",
      feedItemId: "closure",
    });
    const link = resolvePostSourceLink({
      primary,
      text: "Students face disruption as the campus closes.",
      manualOverride: undefined,
      channelDefault: true,
      maxTextLength: null,
    });
    assert.equal(link.ok, true);
    if (link.ok) {
      assert.ok(
        !link.data.finalContent.includes(WEATHER.url),
        "a background article's URL must never be appended"
      );
      assert.notEqual(link.data.primaryFeedItemId, "weather");
    }
  });

  it("holds for whichever article is claimed", () => {
    // Not a fluke of ordering: every claim produces a self-consistent post.
    for (const claimed of [WEATHER, CLOSURE]) {
      const primary = resolvePrimarySelection([WEATHER, CLOSURE], {
        action: "generate",
        feedItemId: claimed.id,
      });
      const link = resolvePostSourceLink({
        primary,
        text: "Post text",
        manualOverride: undefined,
        channelDefault: true,
        maxTextLength: null,
      });
      assert.equal(link.ok, true);
      if (!link.ok) continue;
      assert.equal(link.data.sourceUrl, claimed.url);
      assert.equal(link.data.primaryFeedItemId, claimed.id);
      assert.ok(link.data.finalContent.endsWith(claimed.url));
    }
  });
});

// ─── prompt is built around the primary item ──────────────────────────────────

describe("prompt-builder — primary feed item designation", () => {
  it("marks exactly one primary article and separates the others as background", () => {
    const { userPrompt } = buildPrompts(makeCtx([CLOSURE, WEATHER]), CLOSURE, "en");
    assert.ok(
      userPrompt.includes("PRIMARY SOURCE ARTICLE"),
      "prompt must designate a primary source article"
    );
    assert.ok(
      userPrompt.includes("the post MUST be based on THIS article"),
      "prompt must instruct the model to base the post on the primary article"
    );
    assert.ok(userPrompt.includes(CLOSURE.title!), "primary title must appear");
    assert.ok(
      userPrompt.includes("Additional background context"),
      "secondary items must be separated as background"
    );
    assert.ok(
      userPrompt.includes("Do NOT write the post about any of these"),
      "secondary items must carry an explicit do-not-write instruction"
    );
  });

  it("never renders the primary twice when it is also in feedItems", () => {
    const { userPrompt } = buildPrompts(makeCtx([CLOSURE, WEATHER]), CLOSURE, "en");
    const occurrences = userPrompt.split(CLOSURE.title!).length - 1;
    assert.equal(occurrences, 1, "the primary article appears once, in the primary section");
  });

  it("falls back to an original-post intro when there is no primary", () => {
    const { userPrompt } = buildPrompts(makeCtx([]), null, "en");
    assert.ok(
      userPrompt.includes("Create an original"),
      "no-primary prompt must ask for an original post"
    );
    assert.ok(
      !userPrompt.includes("PRIMARY SOURCE ARTICLE"),
      "no primary section without a primary"
    );
  });
});

// ─── source-link precedence, driven by the selection ──────────────────────────

describe("resolvePostSourceLink — decisions come from the selected item", () => {
  it("honours source-link precedence: source preference overrides channel default", () => {
    const withPref = makeItem({ id: "p", sourceLinkPreference: false });
    const primary = resolvePrimarySelection([withPref, CLOSURE], {
      action: "generate",
      feedItemId: "p",
    });
    const result = resolvePostSourceLink({
      primary,
      text: "Post text",
      manualOverride: undefined,
      channelDefault: true,
      maxTextLength: null,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.includeSourceLink, false);
      assert.equal(result.data.includeSourceLinkLevel, "source");
      assert.ok(!result.data.finalContent.includes(withPref.url));
    }
  });

  it("reads the preference of the CLAIMED item, not of a background one", () => {
    // Background items must not influence the link decision either.
    const noLink = makeItem({ id: "nolink", sourceLinkPreference: false });
    const primary = resolvePrimarySelection([noLink, CLOSURE], {
      action: "generate",
      feedItemId: "closure",
    });
    const result = resolvePostSourceLink({
      primary,
      text: "Post text",
      manualOverride: undefined,
      channelDefault: true,
      maxTextLength: null,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.includeSourceLink, true, "the background opt-out is irrelevant");
      assert.equal(result.data.includeSourceLinkLevel, "channel");
      assert.ok(result.data.finalContent.endsWith(CLOSURE.url));
    }
  });

  it("does not append the URL when the source link is disabled", () => {
    const primary = resolvePrimarySelection([CLOSURE], {
      action: "generate",
      feedItemId: "closure",
    });
    const result = resolvePostSourceLink({
      primary,
      text: `A post already linking ${CLOSURE.url} inline.`,
      manualOverride: false,
      channelDefault: true,
      maxTextLength: null,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.includeSourceLink, false);
      assert.equal(result.data.includeSourceLinkLevel, "manual");
      assert.ok(!result.data.finalContent.includes(CLOSURE.url), "disabled link must be removed");
    }
  });

  it("appends nothing for an evergreen primary", () => {
    const primary = resolvePrimarySelection([EVERGREEN], { action: "evergreen" });
    const text = "A post from a brand prompt.";
    const result = resolvePostSourceLink({
      primary,
      text,
      manualOverride: true,
      channelDefault: true,
      maxTextLength: null,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.sourceUrl, null);
      assert.equal(result.data.primaryFeedItemId, null);
      assert.equal(result.data.finalContent, text, "a prompt: url must never be appended");
    }
  });

  it("returns nulls and leaves content unchanged for a mission post", () => {
    const text = "A standalone post with no source.";
    const result = resolvePostSourceLink({
      primary: resolvePrimarySelection([], { action: "mission" }),
      text,
      manualOverride: undefined,
      channelDefault: true,
      maxTextLength: null,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.sourceUrl, null);
      assert.equal(result.data.primaryFeedItemId, null);
      assert.equal(result.data.sourceTitle, null);
      assert.equal(result.data.finalContent, text);
    }
  });

  it("propagates POST_TOO_LONG_WITH_URL from the primary item's URL", () => {
    const primary = resolvePrimarySelection([CLOSURE], {
      action: "generate",
      feedItemId: "closure",
    });
    const result = resolvePostSourceLink({
      primary,
      text: "x".repeat(100),
      manualOverride: true,
      channelDefault: false,
      maxTextLength: 110,
    });
    assert.deepEqual(result, { ok: false, reason: "POST_TOO_LONG_WITH_URL" });
  });
});

// ─── previewPrimaryItem ───────────────────────────────────────────────────────

describe("previewPrimaryItem", () => {
  it("forecasts the first claimable article", () => {
    assert.equal(previewPrimaryItem([CLOSURE, WEATHER])?.id, "closure");
  });

  it("prefers an article over an evergreen item, as the claim would", () => {
    assert.equal(previewPrimaryItem([EVERGREEN, CLOSURE])?.id, "closure");
  });

  it("falls back to an evergreen item when no article is present", () => {
    assert.equal(previewPrimaryItem([EVERGREEN])?.id, "prompt-1");
  });

  it("returns null with no items", () => {
    assert.equal(previewPrimaryItem([]), null);
  });
});
