import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  claimFeedItemForTranslation,
  translationSelectableWhere,
  TRANSLATION_LEASE_MS,
  type TranslationClaimDb,
} from "./feed-item-translation-claim";
import { MAX_TRANSLATION_ATTEMPTS } from "./feed-item-translation";

// ─── A faithful conditional-UPDATE double ─────────────────────────────────────
//
// MockFeedItem models ONE feed_items row with the exact `UPDATE ... WHERE ...`
// semantics translation relies on: updateMany applies the write only when the row
// matches the WHERE, and reports how many rows changed. JS is single-threaded, so
// each updateMany runs to completion without interleaving — precisely the atomicity
// a single SQL statement provides. The matcher understands only the operators the
// claim and selection filters actually use.

interface RowState {
  translationStatus: string | null;
  translationHash: string | null;
  translationAttemptCount: number;
  translationNextRetryAt: Date | null;
  translationLeaseExpiresAt: Date | null;
}

const num = (v: unknown): number =>
  v instanceof Date ? v.getTime() : typeof v === "number" ? v : NaN;

function matchLeaf(value: unknown, cond: unknown): boolean {
  if (cond === null) return value === null;
  if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
  if (typeof cond === "object") {
    const c = cond as Record<string, unknown>;
    if ("in" in c) return (c.in as unknown[]).includes(value);
    if ("lt" in c) return value != null && num(value) < num(c.lt);
    if ("lte" in c) return value != null && num(value) <= num(c.lte);
    if ("not" in c) return value !== c.not;
  }
  return value === cond;
}

class MockFeedItem implements TranslationClaimDb {
  readonly id = "item-1";
  updates: Array<Record<string, unknown>> = [];

  constructor(private row: RowState) {}

  get state(): RowState {
    return this.row;
  }

  matches(where: Record<string, unknown>): boolean {
    for (const [k, v] of Object.entries(where)) {
      if (k === "id") {
        if (v !== this.id) return false;
        continue;
      }
      if (k === "OR") {
        if (!(v as Record<string, unknown>[]).some((sub) => this.matches(sub))) return false;
        continue;
      }
      if (!matchLeaf((this.row as unknown as Record<string, unknown>)[k], v)) return false;
    }
    return true;
  }

  private apply(data: Record<string, unknown>): void {
    for (const [k, v] of Object.entries(data)) {
      if (k === "translationAttemptCount" && v && typeof v === "object" && "increment" in v) {
        this.row.translationAttemptCount += (v as { increment: number }).increment;
      } else {
        (this.row as unknown as Record<string, unknown>)[k] = v;
      }
    }
    this.updates.push(data);
  }

  feedItem = {
    updateMany: async (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }> => {
      if (!this.matches(args.where)) return { count: 0 };
      this.apply(args.data);
      return { count: 1 };
    },
  };
}

const NOW = new Date("2026-07-24T12:00:00.000Z");
const HASH = "hash-abc";

function row(overrides: Partial<RowState> = {}): RowState {
  return {
    translationStatus: "pending",
    translationHash: null,
    translationAttemptCount: 0,
    translationNextRetryAt: null,
    translationLeaseExpiresAt: null,
    ...overrides,
  };
}

function claim(db: MockFeedItem) {
  return claimFeedItemForTranslation(db, { id: db.id, hash: HASH, targetLang: "bg", now: NOW });
}

// ─── Claiming an eligible item ────────────────────────────────────────────────

describe("claimFeedItemForTranslation — winning the claim", () => {
  it("claims a pending item: flips it to translating, stamps the lease, counts one attempt", async () => {
    const db = new MockFeedItem(row());
    const { claimed, leaseExpiresAt } = await claim(db);

    assert.equal(claimed, true);
    assert.equal(db.state.translationStatus, "translating");
    assert.equal(db.state.translationAttemptCount, 1);
    assert.equal(db.state.translationHash, HASH);
    assert.equal(leaseExpiresAt.getTime(), NOW.getTime() + TRANSLATION_LEASE_MS);
    assert.equal((db.state.translationLeaseExpiresAt as Date).getTime(), leaseExpiresAt.getTime());
  });

  it("claims a failed item whose backoff window has elapsed", async () => {
    const db = new MockFeedItem(
      row({
        translationStatus: "failed",
        translationAttemptCount: 2,
        translationNextRetryAt: new Date(NOW.getTime() - 1000),
      })
    );
    const { claimed } = await claim(db);

    assert.equal(claimed, true);
    assert.equal(db.state.translationAttemptCount, 3);
  });

  it("reclaims a completed item whose input hash changed (article/language changed)", async () => {
    const db = new MockFeedItem(row({ translationStatus: "completed", translationHash: "stale" }));
    const { claimed } = await claim(db);

    assert.equal(claimed, true, "a stale completed translation is re-translatable");
  });
});

// ─── Refusing an ineligible item ──────────────────────────────────────────────

describe("claimFeedItemForTranslation — refusing the claim", () => {
  it("refuses a failed item still inside its backoff window", async () => {
    const db = new MockFeedItem(
      row({
        translationStatus: "failed",
        translationNextRetryAt: new Date(NOW.getTime() + 60_000),
      })
    );
    const { claimed } = await claim(db);

    assert.equal(claimed, false);
    assert.equal(db.state.translationAttemptCount, 0, "no attempt is burned on a refused claim");
    assert.equal(db.updates.length, 0);
  });

  it("refuses a completed item whose hash still matches (nothing changed)", async () => {
    const db = new MockFeedItem(row({ translationStatus: "completed", translationHash: HASH }));
    const { claimed } = await claim(db);

    assert.equal(claimed, false);
  });

  it("refuses an item at the attempt cap", async () => {
    const db = new MockFeedItem(
      row({ translationStatus: "failed", translationAttemptCount: MAX_TRANSLATION_ATTEMPTS })
    );
    const { claimed } = await claim(db);

    assert.equal(claimed, false);
  });
});

// ─── Crash recovery via the lease ─────────────────────────────────────────────

describe("claimFeedItemForTranslation — lease recovery", () => {
  it("refuses an item with a LIVE claim (translating, lease in the future)", async () => {
    const db = new MockFeedItem(
      row({
        translationStatus: "translating",
        translationAttemptCount: 1,
        translationLeaseExpiresAt: new Date(NOW.getTime() + 60_000),
      })
    );
    const { claimed } = await claim(db);

    assert.equal(claimed, false, "an in-flight translation must not be reclaimed");
    assert.equal(db.state.translationAttemptCount, 1);
  });

  it("reclaims an item whose lease EXPIRED (the worker crashed mid-translation)", async () => {
    const db = new MockFeedItem(
      row({
        translationStatus: "translating",
        translationAttemptCount: 1,
        translationLeaseExpiresAt: new Date(NOW.getTime() - 1000),
      })
    );
    const { claimed, leaseExpiresAt } = await claim(db);

    assert.equal(claimed, true, "a crashed claim recovers once its lease elapses");
    assert.equal(db.state.translationAttemptCount, 2);
    assert.equal((db.state.translationLeaseExpiresAt as Date).getTime(), leaseExpiresAt.getTime());
  });
});

// ─── Concurrency: exactly one winner ──────────────────────────────────────────

describe("claimFeedItemForTranslation — concurrency", () => {
  it("two runs racing for the same pending item yield exactly one winner", async () => {
    const db = new MockFeedItem(row());

    const [a, b] = await Promise.all([claim(db), claim(db)]);

    const winners = [a, b].filter((r) => r.claimed);
    assert.equal(winners.length, 1, "only one run may hold the claim");
    assert.equal(db.state.translationAttemptCount, 1, "the attempt is counted exactly once");
    assert.equal(db.state.translationStatus, "translating");
  });
});

// ─── The selection filter mirrors the claim (minus stale-completed) ───────────

describe("translationSelectableWhere", () => {
  // The recovery-aware SELECTION filter must surface exactly what a run can then claim
  // among queued/crashed items: retry-due pending/failed and expired `translating`. It
  // deliberately excludes live claims and completed rows (those are re-opened by ingest).
  const selects = (r: RowState): boolean => {
    const where = translationSelectableWhere(NOW) as unknown as Record<string, unknown>;
    return new MockFeedItem(r).matches(where);
  };

  it("selects a retry-due pending item", () => {
    assert.equal(selects(row()), true);
  });

  it("selects an expired translating claim (recovery) but not a live one", () => {
    assert.equal(
      selects(row({ translationStatus: "translating", translationLeaseExpiresAt: new Date(NOW.getTime() - 1) })),
      true
    );
    assert.equal(
      selects(row({ translationStatus: "translating", translationLeaseExpiresAt: new Date(NOW.getTime() + 60_000) })),
      false
    );
  });

  it("excludes a failed item still in backoff and an attempt-capped item", () => {
    assert.equal(
      selects(row({ translationStatus: "failed", translationNextRetryAt: new Date(NOW.getTime() + 60_000) })),
      false
    );
    assert.equal(
      selects(row({ translationStatus: "failed", translationAttemptCount: MAX_TRANSLATION_ATTEMPTS })),
      false
    );
  });

  it("excludes a completed row (re-translation is driven by ingest re-opening it, not selection)", () => {
    assert.equal(selects(row({ translationStatus: "completed", translationHash: "stale" })), false);
  });
});
