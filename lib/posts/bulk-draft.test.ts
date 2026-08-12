import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BULK_RETURN_PARAM,
  BULK_RETURN_VALUE,
  bulkDraftKey,
  bulkGenerationHref,
  contentMixSettingsHref,
  isReturnToBulk,
  parseBulkDraft,
  stillAvailable,
  type BulkFormDraft,
} from "./bulk-draft";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** A filled-in batch: a custom five-post fortnight with an adjusted mix. */
function draft(overrides: Partial<BulkFormDraft> = {}): BulkFormDraft {
  return {
    version: 1,
    mode: "multiple",
    channel: "FACEBOOK",
    contentLanguage: "bg",
    imageOverride: "generate",
    contentSource: "__company_rules__",
    sourceLinkOverride: "exclude",
    llmConfigId: "llm-7",
    plan: {
      numberOfPosts: 5,
      startDate: "2026-08-13",
      endDate: "2026-08-26",
      distribution: "custom",
      counts: { "2026-08-13": 2, "2026-08-20": 3 },
      times: { "2026-08-13": ["09:00", "17:30"], "2026-08-20": ["08:00", "12:00", "18:00"] },
    },
    mixOverride: { "rss-a": 3, __company_content__: 2 },
    ...overrides,
  };
}

function stored(value: unknown): string {
  return JSON.stringify(value);
}

// ─── Round trip ───────────────────────────────────────────────────────────────

describe("parseBulkDraft", () => {
  it("restores a filled-in form exactly as it was left", () => {
    // The whole point of the feature: a trip to settings and back must cost
    // nothing that was typed, down to the per-day publish times.
    const original = draft();
    assert.deepEqual(parseBulkDraft(stored(original)), original);
  });

  it("keeps an untouched mix as null rather than as an empty object", () => {
    // null means "use the saved default"; {} would mean "a mix assigning nothing",
    // which is a different batch and one the form would refuse to submit.
    const parsed = parseBulkDraft(stored(draft({ mixOverride: null })));
    assert.equal(parsed?.mixOverride, null);
  });

  it("restores an even distribution with no per-day state", () => {
    const parsed = parseBulkDraft(
      stored(
        draft({
          plan: {
            numberOfPosts: 3,
            startDate: "2026-08-13",
            endDate: "2026-08-26",
            distribution: "even",
            counts: {},
            times: {},
          },
        })
      )
    );
    assert.equal(parsed?.plan.distribution, "even");
    assert.deepEqual(parsed?.plan.counts, {});
  });

  it("restores a single-post form, and an empty channel", () => {
    // "" is what the form holds when the company has connected nothing yet.
    const parsed = parseBulkDraft(stored(draft({ mode: "single", channel: "" })));
    assert.equal(parsed?.mode, "single");
    assert.equal(parsed?.channel, "");
  });

  it("returns null for nothing stored", () => {
    assert.equal(parseBulkDraft(null), null);
    assert.equal(parseBulkDraft(""), null);
  });

  it("returns null rather than throwing on unparseable storage", () => {
    // sessionStorage is shared with everything else the origin runs; a value
    // under this key that is not ours must open a fresh form, not crash one.
    assert.equal(parseBulkDraft("{not json"), null);
    assert.equal(parseBulkDraft(stored("a string")), null);
    assert.equal(parseBulkDraft(stored([1, 2, 3])), null);
  });

  it("drops a draft written by another version of the form", () => {
    // The shape may have changed underneath it — reading it half-right would
    // silently revert whichever fields moved.
    assert.equal(parseBulkDraft(stored({ ...draft(), version: 99 })), null);
    assert.equal(parseBulkDraft(stored({ ...draft(), version: undefined })), null);
  });
});

// ─── Rejection is whole-draft ─────────────────────────────────────────────────

describe("parseBulkDraft — rejects rather than half-restores", () => {
  it("drops the draft when any single field is not what it claims", () => {
    // A partially restored form is worse than a fresh one: the user has to spot
    // which of a dozen fields quietly reverted.
    const bad: Array<Partial<Record<keyof BulkFormDraft, unknown>>> = [
      { mode: "bulk" },
      { channel: 7 },
      { contentLanguage: "de" },
      { imageOverride: "maybe" },
      { contentSource: null },
      { sourceLinkOverride: "sometimes" },
      { llmConfigId: 12 },
      { mixOverride: { "rss-a": "three" } },
      { mixOverride: [1, 2] },
      { plan: undefined },
    ];

    for (const patch of bad) {
      assert.equal(
        parseBulkDraft(stored({ ...draft(), ...patch })),
        null,
        `accepted ${JSON.stringify(patch)}`
      );
    }
  });

  it("drops the draft when the plan is malformed", () => {
    const plans: unknown[] = [
      { ...draft().plan, distribution: "spread" },
      { ...draft().plan, numberOfPosts: "5" },
      { ...draft().plan, numberOfPosts: Number.NaN },
      { ...draft().plan, startDate: 20260813 },
      { ...draft().plan, counts: { "2026-08-13": "2" } },
      { ...draft().plan, times: { "2026-08-13": "09:00" } },
      { ...draft().plan, times: { "2026-08-13": [9] } },
      "even",
      null,
    ];

    for (const plan of plans) {
      assert.equal(parseBulkDraft(stored({ ...draft(), plan })), null, `accepted ${stored(plan)}`);
    }
  });
});

// ─── Storage key ──────────────────────────────────────────────────────────────

describe("bulkDraftKey", () => {
  it("scopes a draft to one company", () => {
    // Two companies open in two tabs must not restore each other's batch.
    assert.notEqual(bulkDraftKey("acme"), bulkDraftKey("globex"));
    assert.match(bulkDraftKey("acme"), /acme/);
  });
});

// ─── The round-trip links ─────────────────────────────────────────────────────

describe("contentMixSettingsHref", () => {
  it("points at the editor itself, not the top of the settings page", () => {
    const href = contentMixSettingsHref("acme", false);
    assert.equal(href, "/companies/acme/settings/channels#content-mix");
  });

  it("marks a trip from the bulk form so the way back is offered", () => {
    const href = contentMixSettingsHref("acme", true);
    assert.equal(
      href,
      `/companies/acme/settings/channels?${BULK_RETURN_PARAM}=${BULK_RETURN_VALUE}#content-mix`
    );
    assert.equal(
      isReturnToBulk(new URL(href, "https://x").searchParams.get("from") ?? undefined),
      true
    );
  });

  it("leaves an ordinary settings link unmarked", () => {
    // A direct visit must behave exactly as it always has — no back link, no
    // scrolling, no draft in play.
    assert.equal(contentMixSettingsHref("acme", false).includes(BULK_RETURN_PARAM), false);
  });
});

describe("bulkGenerationHref", () => {
  it("returns to the form by anchor, not to the top of the posts page", () => {
    assert.equal(bulkGenerationHref("acme"), "/companies/acme/posts#bulk-generate");
  });
});

describe("isReturnToBulk", () => {
  it("recognises the marker, including a repeated param", () => {
    assert.equal(isReturnToBulk(BULK_RETURN_VALUE), true);
    assert.equal(isReturnToBulk([BULK_RETURN_VALUE, "other"]), true);
  });

  it("ignores anything else, so a stray value cannot fake a round trip", () => {
    assert.equal(isReturnToBulk(undefined), false);
    assert.equal(isReturnToBulk(""), false);
    assert.equal(isReturnToBulk("dashboard"), false);
    assert.equal(isReturnToBulk([]), false);
  });
});

// ─── Restoring against what is still on offer ─────────────────────────────────

describe("stillAvailable", () => {
  it("keeps a value that is still offered", () => {
    assert.equal(stillAvailable("LINKEDIN", ["FACEBOOK", "LINKEDIN"], "FACEBOOK"), "LINKEDIN");
  });

  it("falls back when the saved choice is gone", () => {
    // A channel can be disconnected, or a source deleted, while the user is in
    // settings. A select holding a value that is no longer an option shows blank.
    assert.equal(stillAvailable("TIKTOK", ["FACEBOOK"], "FACEBOOK"), "FACEBOOK");
    assert.equal(stillAvailable("deleted-source", [], "__company_rules__"), "__company_rules__");
  });

  it("falls back on an empty saved value", () => {
    assert.equal(stillAvailable("", ["FACEBOOK"], "FACEBOOK"), "FACEBOOK");
  });
});
