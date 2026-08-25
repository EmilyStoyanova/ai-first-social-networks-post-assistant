import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SOURCE_QUEUE_ACTIONS,
  isSourceQueueActionDisabled,
  queuedMessageFor,
  queuedMessageKey,
  sourceQueueActionEndpoint,
  type SourceQueueAction,
} from "./source-queue-action";
import en from "@/i18n/messages/en.json";
import bg from "@/i18n/messages/bg.json";

/**
 * The RSS articles panel's two requeue controls, tested where they are logic.
 *
 * This project has no component-test harness, so the parts of the panel that can
 * actually be wrong — which endpoint a button posts to, which message a count
 * produces, and whether a control may be pressed at all — live in a pure module and
 * are covered here.
 */

describe("sourceQueueActionEndpoint", () => {
  it("builds the reclassify endpoint the existing route serves", () => {
    assert.equal(
      sourceQueueActionEndpoint("acme", "src-1", "reclassify"),
      "/api/v1/companies/acme/content-sources/src-1/reclassify"
    );
  });

  it("builds the retranslate endpoint alongside it", () => {
    assert.equal(
      sourceQueueActionEndpoint("acme", "src-1", "retranslate"),
      "/api/v1/companies/acme/content-sources/src-1/retranslate"
    );
  });

  it("gives the two actions DIFFERENT endpoints", () => {
    // They are nested identically and differ only in the last segment, so a typo
    // would silently hit a real, adjacent endpoint that does something else.
    const a = sourceQueueActionEndpoint("acme", "src-1", "reclassify");
    const b = sourceQueueActionEndpoint("acme", "src-1", "retranslate");
    assert.notEqual(a, b);
  });

  it("keeps the slug and source id in the path", () => {
    const url = sourceQueueActionEndpoint("my-co", "abc-123", "retranslate");
    assert.ok(url.includes("/my-co/"));
    assert.ok(url.includes("/abc-123/"));
  });
});

describe("isSourceQueueActionDisabled", () => {
  it("enables both controls when nothing is happening", () => {
    for (const action of SOURCE_QUEUE_ACTIONS) {
      assert.equal(isSourceQueueActionDisabled({ running: null, loading: false }, action), false);
    }
  });

  it("disables BOTH controls while either action runs", () => {
    // Mutual on purpose: the two act on overlapping rows and both reset attempt
    // counts, so starting a retranslation on top of an in-flight reclassification is
    // the UI-level version of the duplicate work the dedupe key prevents server-side.
    for (const running of SOURCE_QUEUE_ACTIONS) {
      for (const action of SOURCE_QUEUE_ACTIONS) {
        assert.equal(
          isSourceQueueActionDisabled({ running, loading: false }, action),
          true,
          `${running} running must disable ${action}`
        );
      }
    }
  });

  it("disables both while the article list is reloading", () => {
    // The list underneath is what the reported count is checked against.
    for (const action of SOURCE_QUEUE_ACTIONS) {
      assert.equal(isSourceQueueActionDisabled({ running: null, loading: true }, action), true);
    }
  });
});

describe("queuedMessageKey", () => {
  it("uses the dedicated empty message for zero", () => {
    // "0 articles queued" reads as a failure when it almost always means the source
    // was already up to date.
    assert.equal(queuedMessageKey(0), "queuedNone");
  });

  it("uses the counted message for anything reopened", () => {
    for (const count of [1, 2, 10, 250]) {
      assert.equal(queuedMessageKey(count), "queued");
    }
  });
});

describe("queuedMessageFor", () => {
  it("maps each action and count to its own key", () => {
    assert.equal(queuedMessageFor("reclassify", 10), "reclassifyQueued");
    assert.equal(queuedMessageFor("reclassify", 0), "reclassifyQueuedNone");
    assert.equal(queuedMessageFor("retranslate", 10), "retranslateQueued");
    assert.equal(queuedMessageFor("retranslate", 0), "retranslateQueuedNone");
  });

  it("never returns one action's message for the other", () => {
    for (const count of [0, 3]) {
      assert.ok(!queuedMessageFor("retranslate", count).startsWith("reclassify"));
      assert.ok(!queuedMessageFor("reclassify", count).startsWith("retranslate"));
    }
  });
});

// ─── The messages actually exist ──────────────────────────────────────────────
//
// next-intl throws on a missing key rather than falling back, so a key this module
// names but the catalogue does not carry is a runtime crash in the panel — not a
// cosmetic gap. messages.test.ts guards en/bg parity; this guards that the keys
// these functions RETURN are keys at all.

const feedItems = (messages: typeof en): Record<string, unknown> =>
  messages.feedItems as unknown as Record<string, unknown>;

describe("the panel's message keys resolve in both locales", () => {
  const RETRANSLATE_KEYS = [
    "retranslate",
    "retranslating",
    "retranslateQueued",
    "retranslateQueuedNone",
    "retranslateError",
  ];

  for (const key of RETRANSLATE_KEYS) {
    it(`feedItems.${key} exists in en and bg`, () => {
      assert.equal(typeof feedItems(en)[key], "string", `en is missing feedItems.${key}`);
      assert.equal(typeof feedItems(bg)[key], "string", `bg is missing feedItems.${key}`);
    });
  }

  it("every key queuedMessageFor can return exists for retranslation", () => {
    for (const count of [0, 5]) {
      const key = queuedMessageFor("retranslate", count);
      assert.equal(typeof feedItems(en)[key], "string", `en is missing feedItems.${key}`);
      assert.equal(typeof feedItems(bg)[key], "string", `bg is missing feedItems.${key}`);
    }
  });

  it("the counted message carries a {count} placeholder in both locales", () => {
    for (const messages of [en, bg]) {
      const text = feedItems(messages).retranslateQueued as string;
      assert.match(text, /\{count\}/, `"${text}" must interpolate the number reported`);
    }
  });

  it("the empty message does NOT depend on a count", () => {
    for (const messages of [en, bg]) {
      const text = feedItems(messages).retranslateQueuedNone as string;
      assert.ok(!text.includes("{count}"), `"${text}" is the zero case and names no number`);
    }
  });

  it("names the action distinctly from reclassification, so the two alerts differ", () => {
    for (const messages of [en, bg]) {
      const f = feedItems(messages);
      const classification = (f.classification as Record<string, unknown>) ?? {};
      assert.notEqual(f.retranslate, classification.reclassify);
      assert.notEqual(f.retranslateQueued, classification.reclassifyQueued);
    }
  });
});

describe("SOURCE_QUEUE_ACTIONS", () => {
  it("lists exactly the two actions the panel draws", () => {
    assert.deepEqual([...SOURCE_QUEUE_ACTIONS], ["reclassify", "retranslate"]);
  });

  it("is exhaustive over the action type", () => {
    // A third action added to the union without being added here would leave the
    // panel drawing a control this module cannot describe.
    const all: Record<SourceQueueAction, true> = { reclassify: true, retranslate: true };
    assert.deepEqual(Object.keys(all).sort(), [...SOURCE_QUEUE_ACTIONS].sort());
  });
});
