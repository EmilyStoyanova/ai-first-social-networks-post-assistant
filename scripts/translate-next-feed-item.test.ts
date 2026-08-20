import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  runById,
  parseArgs,
  type FeedItemForRetry,
  type RunByIdDeps,
} from "./translate-next-feed-item";
import type {
  TranslateFeedItemsSummary,
  TranslateFeedItemsOptions,
  TranslateFeedItemsDeps,
} from "@/lib/services/cron/translate-feed-items.service";

/**
 * `runById` is the `--id` retry path's orchestration: read one item, verify it against
 * the real eligibility predicate, and — only with `--translate-one` — hand it to the real
 * `translateFeedItems` service. Every DB read and the translation call are injected here,
 * so these tests exercise the eligibility DECISION without a database and without ever
 * duplicating translation logic — `deps.translate` below is a spy that records whether it
 * was called, never a reimplementation of what it does.
 */

const NOW = new Date("2026-08-20T09:00:00.000Z");

function makeItem(overrides: Partial<FeedItemForRetry> = {}): FeedItemForRetry {
  return {
    id: "825c8475-619d-47c5-9062-955fd3170268",
    companyId: "company-1",
    title: "The 15 Best Hotels in Tuscany",
    content: "…",
    url: "https://www.cntraveler.com/gallery/best-hotels-tuscany",
    createdAt: new Date("2026-08-19T12:00:00.000Z"),
    translationStatus: "failed",
    translationHash: "abc123",
    translationAttemptCount: 1,
    translationNextRetryAt: null,
    translationLeaseExpiresAt: null,
    translationProvider: "TEXT_WORKER",
    translationModel: "google/madlad400-3b-mt",
    source: {
      type: "rss",
      config: { translateEnabled: true, translateToLanguage: "bg" },
      enabled: true,
      company: { name: "TravelNest", slug: "travelnest", defaultLang: "en" },
    },
    ...overrides,
  };
}

/** Builds deps with fake reads and a translate() SPY — records calls, never executes logic. */
function makeDeps(item: FeedItemForRetry | null, selectable: boolean) {
  const logs: string[] = [];
  const errors: string[] = [];
  const translate = mock.fn(
    async (
      _options: TranslateFeedItemsOptions,
      _callDeps?: TranslateFeedItemsDeps
    ): Promise<TranslateFeedItemsSummary> => ({
      scanned: 1,
      translated: 1,
      failed: 0,
      skipped: 0,
    })
  );
  const isSelectable = mock.fn(async () => selectable);
  const loadItem = mock.fn(async () => item);

  const deps: RunByIdDeps = {
    loadItem,
    isSelectable,
    translate: translate as unknown as RunByIdDeps["translate"],
    now: () => NOW,
    log: (msg: string) => logs.push(msg),
    errorLog: (msg: string) => errors.push(msg),
  };

  return { deps, logs, errors, translate, isSelectable, loadItem };
}

// `runById` sets the real `process.exitCode` on an ineligibility abort (the same signal
// the real CLI relies on). That is global process state, not local to one test, so it is
// reset after every test here — otherwise a later test (or the runner's own end-of-file
// check) would see whatever the last ineligible case left behind.
afterEach(() => {
  process.exitCode = undefined;
});

describe("parseArgs — normal no-`--id` behavior is unchanged", () => {
  it("defaults exactly as before: limit 10, translateOne false, id null", () => {
    assert.deepEqual(parseArgs([]), { limit: 10, translateOne: false, id: null });
  });

  it("still parses --limit and --translate-one with id left null", () => {
    assert.deepEqual(parseArgs(["--limit", "25", "--translate-one"]), {
      limit: 25,
      translateOne: true,
      id: null,
    });
  });

  it("parses --id alongside the existing flags without disturbing them", () => {
    assert.deepEqual(
      parseArgs(["--id", "825c8475-619d-47c5-9062-955fd3170268", "--translate-one"]),
      { limit: 10, translateOne: true, id: "825c8475-619d-47c5-9062-955fd3170268" }
    );
  });
});

describe("runById — unknown id", () => {
  it("aborts without calling isSelectable or translate", async () => {
    const { deps, errors, isSelectable, translate } = makeDeps(null, true);
    process.exitCode = undefined;

    await runById("missing-id", true, deps);

    assert.equal(process.exitCode, 1);
    assert.ok(errors.some((e) => e.includes("No FeedItem found with id missing-id")));
    assert.equal(isSelectable.mock.callCount(), 0);
    assert.equal(translate.mock.callCount(), 0);
  });
});

describe("runById — future retry time", () => {
  it("aborts and prints the exact retry time, without translating", async () => {
    const futureRetry = new Date("2026-08-20T10:30:00.000Z");
    const item = makeItem({ translationNextRetryAt: futureRetry });
    const { deps, errors, translate } = makeDeps(item, false);
    process.exitCode = undefined;

    await runById(item.id, true, deps);

    assert.equal(process.exitCode, 1);
    assert.ok(
      errors.some((e) => e.includes("NOT ELIGIBLE YET") && e.includes(futureRetry.toISOString())),
      `expected an exact retry-time message, got: ${JSON.stringify(errors)}`
    );
    assert.equal(translate.mock.callCount(), 0, "must never translate before its retry time");
  });
});

describe("runById — exhausted attempts", () => {
  it("aborts without ever checking selectability or translating", async () => {
    const item = makeItem({ translationAttemptCount: 5 }); // MAX_TRANSLATION_ATTEMPTS
    const { deps, errors, isSelectable, translate } = makeDeps(item, true);
    process.exitCode = undefined;

    await runById(item.id, true, deps);

    assert.equal(process.exitCode, 1);
    assert.ok(errors.some((e) => e.includes("attempt count exhausted") && e.includes("5/5")));
    assert.equal(isSelectable.mock.callCount(), 0);
    assert.equal(translate.mock.callCount(), 0);
  });
});

describe("runById — disabled translation", () => {
  it("aborts when translateEnabled is off on the source", async () => {
    const item = makeItem({
      source: {
        type: "rss",
        config: { translateEnabled: false },
        enabled: true,
        company: { name: "TravelNest", slug: "travelnest", defaultLang: "en" },
      },
    });
    const { deps, errors, translate } = makeDeps(item, true);
    process.exitCode = undefined;

    await runById(item.id, true, deps);

    assert.equal(process.exitCode, 1);
    assert.ok(errors.some((e) => e.includes("translation is disabled")));
    assert.equal(translate.mock.callCount(), 0);
  });

  it("aborts when the content source itself is disabled", async () => {
    const item = makeItem({
      source: {
        type: "rss",
        config: { translateEnabled: true, translateToLanguage: "bg" },
        enabled: false,
        company: { name: "TravelNest", slug: "travelnest", defaultLang: "en" },
      },
    });
    const { deps, errors, translate } = makeDeps(item, true);
    process.exitCode = undefined;

    await runById(item.id, true, deps);

    assert.equal(process.exitCode, 1);
    assert.ok(errors.some((e) => e.includes("content source is disabled")));
    assert.equal(translate.mock.callCount(), 0);
  });

  it("aborts when the resolved target language is not Bulgarian", async () => {
    const item = makeItem({
      source: {
        type: "rss",
        config: { translateEnabled: true, translateToLanguage: "de" },
        enabled: true,
        company: { name: "TravelNest", slug: "travelnest", defaultLang: "en" },
      },
    });
    const { deps, errors, translate } = makeDeps(item, true);
    process.exitCode = undefined;

    await runById(item.id, true, deps);

    assert.equal(process.exitCode, 1);
    assert.ok(errors.some((e) => e.includes("target language") && e.includes("de")));
    assert.equal(translate.mock.callCount(), 0);
  });
});

describe("runById — selecting exactly one id", () => {
  it("is READ-ONLY without --translate-one, even when eligible", async () => {
    const item = makeItem();
    const { deps, logs, translate } = makeDeps(item, true);
    process.exitCode = undefined;

    await runById(item.id, false, deps);

    assert.equal(process.exitCode, undefined);
    assert.ok(logs.some((l) => l.includes("ELIGIBLE for translation right now")));
    assert.ok(logs.some((l) => l.includes("Read-only")));
    assert.equal(translate.mock.callCount(), 0, "must never translate without --translate-one");
  });

  it("with --translate-one, hands exactly this one item to the real translation service", async () => {
    const item = makeItem();
    const { deps, logs, translate } = makeDeps(item, true);
    process.exitCode = undefined;

    await runById(item.id, true, deps);

    assert.equal(process.exitCode, undefined);
    assert.equal(translate.mock.callCount(), 1, "must call the production service exactly once");

    const [options, callDeps] = translate.mock.calls[0].arguments;
    assert.equal(options.companyId, item.companyId);
    assert.equal(options.limit, 1);

    // The override selects ONLY this item — not a reimplementation of translation itself.
    const candidates = await callDeps!.findCandidates!("irrelevant", 999);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].id, item.id);
    assert.equal(candidates[0].title, item.title);
    assert.equal(candidates[0].content, item.content);

    assert.ok(logs.some((l) => l.includes(`Translating EXACTLY ONE item: ${item.id}`)));
    assert.ok(
      logs.some((l) => l.includes("translated")),
      "the summary must be printed"
    );
  });

  it("recovers a crashed `translating` lease and reports it clearly when NOT selectable", async () => {
    const item = makeItem({
      translationStatus: "translating",
      translationLeaseExpiresAt: new Date("2026-08-20T09:05:00.000Z"), // future — still live
    });
    const { deps, errors, translate } = makeDeps(item, false);
    process.exitCode = undefined;

    await runById(item.id, true, deps);

    assert.equal(process.exitCode, 1);
    assert.ok(errors.some((e) => e.includes("currently claimed by another run")));
    assert.equal(translate.mock.callCount(), 0);
  });
});
