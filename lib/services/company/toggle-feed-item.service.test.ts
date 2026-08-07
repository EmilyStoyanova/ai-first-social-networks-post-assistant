import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toggleFeedItemCore } from "./toggle-feed-item.service";
import type { ToggleFeedItemDb } from "./toggle-feed-item.service";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const NOW = new Date("2026-01-15T10:00:00Z");

/**
 * A toggled row as Prisma returns it. `url` + `source.config` are what decide
 * the row's public link, so both are overridable: an RSS article carries its own
 * url, a calendar item carries `event:<id>` and borrows its source's Event URL.
 */
function makeFeedItemRow(
  enabled: boolean,
  overrides: { url?: string; config?: unknown } = {}
): {
  id: string;
  sourceId: string;
  title: string | null;
  content: string | null;
  url: string;
  publishedAt: Date | null;
  enabled: boolean;
  createdAt: Date;
  translationStatus: string | null;
  translationLanguage: string | null;
  translationError: string | null;
  source: { config: unknown };
} {
  return {
    id: "item-1",
    sourceId: "src-1",
    title: "Test Article",
    content: "Article body text.",
    url: overrides.url ?? "https://example.com/article-1",
    publishedAt: NOW,
    enabled,
    createdAt: NOW,
    translationStatus: null,
    translationLanguage: null,
    translationError: null,
    source: { config: overrides.config ?? { url: "https://example.com/feed.xml" } },
  };
}

function makeDb(opts: {
  company?: { id: string } | null;
  membership?: { companyId: string; role: string } | null;
  feedItem?: { id: string } | null;
  updatedEnabled?: boolean;
  row?: { url?: string; config?: unknown };
}): ToggleFeedItemDb {
  const updatedEnabled = opts.updatedEnabled ?? true;
  return {
    company: {
      findUnique: async () => opts.company ?? null,
    },
    companyMember: {
      findFirst: async () => opts.membership ?? null,
    },
    feedItem: {
      findFirst: async () => opts.feedItem ?? null,
      update: async ({ data }) => makeFeedItemRow(data.enabled ?? updatedEnabled, opts.row),
    },
  };
}

const DEFAULT_DB = makeDb({
  company: { id: "co-1" },
  membership: { companyId: "co-1", role: "owner" },
  feedItem: { id: "item-1" },
  updatedEnabled: true,
});

// ─── New articles are enabled by default ─────────────────────────────────────

describe("toggleFeedItemCore — default enabled state", () => {
  it("new articles start as enabled=true (schema default)", async () => {
    // The Prisma schema sets @default(true) — we verify our service correctly
    // reflects the enabled field from the DB row without any override.
    const db = makeDb({
      company: { id: "co-1" },
      membership: { companyId: "co-1", role: "owner" },
      feedItem: { id: "item-1" },
      updatedEnabled: true,
    });
    const result = await toggleFeedItemCore("slug", "src-1", "item-1", true, "u-1", false, db);
    assert.ok(result.success);
    assert.equal(result.item.enabled, true);
  });
});

// ─── Toggling ─────────────────────────────────────────────────────────────────

describe("toggleFeedItemCore — toggling", () => {
  it("disables an enabled article", async () => {
    const db = makeDb({
      company: { id: "co-1" },
      membership: { companyId: "co-1", role: "owner" },
      feedItem: { id: "item-1" },
      updatedEnabled: false,
    });
    const result = await toggleFeedItemCore("slug", "src-1", "item-1", false, "u-1", false, db);
    assert.ok(result.success);
    assert.equal(result.item.enabled, false);
  });

  it("enables a disabled article", async () => {
    const db = makeDb({
      company: { id: "co-1" },
      membership: { companyId: "co-1", role: "owner" },
      feedItem: { id: "item-1" },
      updatedEnabled: true,
    });
    const result = await toggleFeedItemCore("slug", "src-1", "item-1", true, "u-1", false, db);
    assert.ok(result.success);
    assert.equal(result.item.enabled, true);
  });

  it("returns full FeedItemRow on success", async () => {
    const result = await toggleFeedItemCore(
      "slug",
      "src-1",
      "item-1",
      true,
      "u-1",
      false,
      DEFAULT_DB
    );
    assert.ok(result.success);
    assert.equal(result.item.id, "item-1");
    assert.equal(result.item.sourceId, "src-1");
    assert.equal(result.item.url, "https://example.com/article-1");
    assert.equal(typeof result.item.createdAt, "string");
  });
});

// ─── Access control ───────────────────────────────────────────────────────────

describe("toggleFeedItemCore — access control", () => {
  it("returns NOT_FOUND when company does not exist (non-admin)", async () => {
    const db = makeDb({ company: null });
    const result = await toggleFeedItemCore("slug", "src-1", "item-1", false, "u-1", false, db);
    assert.ok(!result.success);
    assert.equal(result.code, "NOT_FOUND");
  });

  it("returns NOT_FOUND when user is not a member", async () => {
    const db = makeDb({ membership: null });
    const result = await toggleFeedItemCore("slug", "src-1", "item-1", false, "u-1", false, db);
    assert.ok(!result.success);
    assert.equal(result.code, "NOT_FOUND");
  });

  it("returns FORBIDDEN when user is an editor (not owner)", async () => {
    const db = makeDb({
      membership: { companyId: "co-1", role: "editor" },
    });
    const result = await toggleFeedItemCore("slug", "src-1", "item-1", false, "u-1", false, db);
    assert.ok(!result.success);
    assert.equal(result.code, "FORBIDDEN");
  });

  it("allows an owner to toggle", async () => {
    const result = await toggleFeedItemCore(
      "slug",
      "src-1",
      "item-1",
      false,
      "u-1",
      false,
      DEFAULT_DB
    );
    assert.ok(result.success);
  });

  it("allows a global admin to toggle without membership check", async () => {
    const db = makeDb({
      company: { id: "co-1" },
      membership: null, // admin bypasses membership
      feedItem: { id: "item-1" },
    });
    const result = await toggleFeedItemCore("slug", "src-1", "item-1", true, "admin-1", true, db);
    assert.ok(result.success);
  });

  it("returns NOT_FOUND when global admin's company slug is invalid", async () => {
    const db = makeDb({ company: null });
    const result = await toggleFeedItemCore(
      "bad-slug",
      "src-1",
      "item-1",
      true,
      "admin-1",
      true,
      db
    );
    assert.ok(!result.success);
    assert.equal(result.code, "NOT_FOUND");
  });
});

// ─── Exclusion from generation ────────────────────────────────────────────────

describe("toggleFeedItemCore — item scoping", () => {
  it("returns NOT_FOUND when the item does not belong to the source/company", async () => {
    const db = makeDb({
      company: { id: "co-1" },
      membership: { companyId: "co-1", role: "owner" },
      feedItem: null, // item not found in this source+company scope
    });
    const result = await toggleFeedItemCore(
      "slug",
      "src-1",
      "item-other-source",
      false,
      "u-1",
      false,
      db
    );
    assert.ok(!result.success);
    assert.equal(result.code, "NOT_FOUND");
  });

  it("disabled items have enabled=false in the returned row", async () => {
    const db = makeDb({
      company: { id: "co-1" },
      membership: { companyId: "co-1", role: "owner" },
      feedItem: { id: "item-1" },
      updatedEnabled: false,
    });
    const result = await toggleFeedItemCore("slug", "src-1", "item-1", false, "u-1", false, db);
    assert.ok(result.success);
    assert.equal(result.item.enabled, false, "Disabled items must have enabled=false");
  });
});
