import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectPrimaryFeedItem } from "./primary-feed-item";
import { resolvePostSourceLink } from "./source-link";
import { buildPrompts } from "./prompt-builder";
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
    },
    feedItems,
    llm: { provider: "groq", model: "llama-3.3-70b-versatile" },
  };
}

// The bug scenario: a seaside-holiday article and a Kristian-Kostov article.
const SEASIDE = makeItem({
  id: "seaside",
  title: "Seaside holiday deals",
  content: "Everything about a relaxing seaside holiday this summer.",
  url: "https://news.example.com/seaside-holiday",
});
const KOSTOV = makeItem({
  id: "kostov",
  title: "Kristian Kostov at Eurovision",
  content: "A retrospective on Kristian Kostov's Eurovision performance.",
  url: "https://news.example.com/kristian-kostov-eurovision",
});

// ─── selectPrimaryFeedItem ────────────────────────────────────────────────────

describe("selectPrimaryFeedItem", () => {
  it("returns the first item when several feed items are present", () => {
    const primary = selectPrimaryFeedItem([KOSTOV, SEASIDE]);
    assert.equal(primary?.id, "kostov");
  });

  it("is positional, not date-based — primary need not be the newest item", () => {
    // The first item is the OLDER one; selection must still return it.
    const older = makeItem({ id: "older", publishedAt: new Date("2020-01-01T00:00:00Z") });
    const newer = makeItem({ id: "newer", publishedAt: new Date("2026-01-01T00:00:00Z") });
    const primary = selectPrimaryFeedItem([older, newer]);
    assert.equal(primary?.id, "older");
  });

  it("returns null when no feed item is available", () => {
    assert.equal(selectPrimaryFeedItem([]), null);
  });
});

// ─── prompt is built around the primary item ──────────────────────────────────

describe("prompt-builder — primary feed item designation", () => {
  it("marks exactly one primary article and separates the others as background", () => {
    const { userPrompt } = buildPrompts(makeCtx([SEASIDE, KOSTOV]), "en");
    assert.ok(
      userPrompt.includes("PRIMARY SOURCE ARTICLE"),
      "prompt must designate a primary source article"
    );
    assert.ok(
      userPrompt.includes("the post MUST be based on THIS article"),
      "prompt must instruct the model to base the post on the primary article"
    );
    // Primary content present, and the secondary is clearly demoted.
    assert.ok(userPrompt.includes("Seaside holiday deals"), "primary title must appear");
    assert.ok(
      userPrompt.includes("Additional background context"),
      "secondary items must be separated as background"
    );
    assert.ok(
      userPrompt.includes("Do NOT write the post about any of these"),
      "secondary items must carry an explicit do-not-write instruction"
    );
  });

  it("builds the prompt around the same item selectPrimaryFeedItem returns", () => {
    const feedItems = [SEASIDE, KOSTOV];
    const primary = selectPrimaryFeedItem(feedItems);
    const { userPrompt } = buildPrompts(makeCtx(feedItems), "en");

    // The primary block comes before the background block, and the primary's
    // title sits inside the PRIMARY section (not the background section).
    const primaryIdx = userPrompt.indexOf("PRIMARY SOURCE ARTICLE");
    const backgroundIdx = userPrompt.indexOf("Additional background context");
    const primaryTitleIdx = userPrompt.indexOf(primary!.title!);
    assert.ok(primaryIdx < backgroundIdx, "primary section must precede background");
    assert.ok(
      primaryTitleIdx > primaryIdx && primaryTitleIdx < backgroundIdx,
      "the primary item's title must sit in the primary section"
    );
  });

  it("falls back to an original-post intro when no feed item is available", () => {
    const { userPrompt } = buildPrompts(makeCtx([]), "en");
    assert.ok(
      userPrompt.includes("Create an original"),
      "no-feed prompt must ask for original post"
    );
    assert.ok(
      !userPrompt.includes("PRIMARY SOURCE ARTICLE"),
      "no primary section without feed items"
    );
  });
});

// ─── text and appended URL come from the same primary item ────────────────────

describe("resolvePostSourceLink — post text and source URL share one primary", () => {
  it("appends the URL of the SAME item the prompt is built around", () => {
    const feedItems = [SEASIDE, KOSTOV];
    const primary = selectPrimaryFeedItem(feedItems);

    // The model wrote about the primary article (seaside).
    const text = "Dreaming of a seaside getaway this summer? Here is what to know.";
    const result = resolvePostSourceLink({
      feedItems,
      text,
      manualOverride: undefined,
      channelDefault: true,
      maxTextLength: null,
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      // URL, id and title all come from the primary item — never a different article.
      assert.equal(result.data.sourceUrl, primary!.url);
      assert.equal(result.data.primaryFeedItemId, "seaside");
      assert.equal(result.data.sourceTitle, "Seaside holiday deals");
      assert.ok(result.data.finalContent.endsWith(primary!.url));
      // Regression: the Kostov URL must NOT be appended to seaside content.
      assert.ok(!result.data.finalContent.includes(KOSTOV.url));
    }
  });

  it("stores primaryFeedItemId for the promptSnapshot", () => {
    const result = resolvePostSourceLink({
      feedItems: [KOSTOV, SEASIDE],
      text: "Post text",
      manualOverride: undefined,
      channelDefault: true,
      maxTextLength: null,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.primaryFeedItemId, "kostov");
      assert.equal(result.data.includeSourceLinkLevel, "channel");
    }
  });

  it("honours source-link precedence: source preference overrides channel default", () => {
    const primaryWithPref = makeItem({ id: "p", sourceLinkPreference: false });
    const result = resolvePostSourceLink({
      feedItems: [primaryWithPref, SEASIDE],
      text: "Post text",
      manualOverride: undefined,
      channelDefault: true,
      maxTextLength: null,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.includeSourceLink, false);
      assert.equal(result.data.includeSourceLinkLevel, "source");
      assert.ok(!result.data.finalContent.includes(primaryWithPref.url));
    }
  });

  it("does not append the URL when the source link is disabled", () => {
    const result = resolvePostSourceLink({
      feedItems: [SEASIDE, KOSTOV],
      text: `A seaside post already linking ${SEASIDE.url} inline.`,
      manualOverride: false,
      channelDefault: true,
      maxTextLength: null,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.includeSourceLink, false);
      assert.equal(result.data.includeSourceLinkLevel, "manual");
      assert.ok(!result.data.finalContent.includes(SEASIDE.url), "disabled link must be removed");
    }
  });

  it("returns nulls and leaves content unchanged when no feed item is available", () => {
    const text = "A standalone post with no source.";
    const result = resolvePostSourceLink({
      feedItems: [],
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
    const result = resolvePostSourceLink({
      feedItems: [SEASIDE],
      text: "x".repeat(100),
      manualOverride: true,
      channelDefault: false,
      maxTextLength: 110,
    });
    assert.deepEqual(result, { ok: false, reason: "POST_TOO_LONG_WITH_URL" });
  });
});
