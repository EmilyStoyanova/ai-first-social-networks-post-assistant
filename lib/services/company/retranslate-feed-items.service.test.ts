import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import {
  RETRANSLATE_REOPEN_DATA,
  parseIncludeCompletedFromBody,
  requestRetranslation,
  retranslatableWhere,
  retranslateSourceFeedItems,
} from "./retranslate-feed-items.service";
import { RECLASSIFY_REOPEN_DATA } from "./reclassify-feed-items.service";
import { MAX_TRANSLATION_ATTEMPTS } from "@/lib/ai/feed-item-translation";
import { translationSelectableWhere } from "@/lib/ai/feed-item-translation-claim";
import type { EnqueueJobResult } from "@/lib/services/queue/enqueue-job.service";

/**
 * "Retranslate this source" — the manual way back for an article whose translation
 * failed its way out of the queue.
 *
 * The two things worth pinning are the two that are invisible at the call site: WHICH
 * rows are eligible (a rule that must never quietly widen to consumed history or
 * successful translations) and WHAT the reset writes (an attempt count that must
 * reach zero or the reopen is cosmetic).
 */

const NOW = new Date("2026-08-25T12:00:00.000Z");

const enqueued: EnqueueJobResult = { enqueued: true, deduplicated: false, jobId: "job-1" };
const deduped: EnqueueJobResult = { enqueued: false, deduplicated: true, jobId: "job-0" };

/** The OR branch list the predicate builds, for readable assertions. */
function statusBranches(where: Record<string, unknown>): unknown[] {
  return where.OR as unknown[];
}

// ─── Eligibility ──────────────────────────────────────────────────────────────

describe("retranslatableWhere — what may be reopened", () => {
  it("scopes to one source, one company, and unconsumed RSS articles", () => {
    const where = retranslatableWhere("company-1", "source-1", NOW);
    assert.equal(where.companyId, "company-1");
    assert.equal(where.sourceId, "source-1");
    assert.equal(where.usedInPost, false);
    assert.deepEqual(where.source, { enabled: true, type: "rss" });
  });

  it("omits sourceId entirely when none is given, rather than matching null", () => {
    // A `sourceId: null` filter would match only rows with a NULL source, which is
    // the opposite of "every source".
    const where = retranslatableWhere("company-1", null, NOW);
    assert.ok(!("sourceId" in where));
    assert.equal(where.companyId, "company-1");
  });

  it("includes failed translations — the state the action exists for", () => {
    const branches = statusBranches(retranslatableWhere("c", "s", NOW));
    assert.ok(
      branches.some(
        (b) =>
          typeof b === "object" &&
          b !== null &&
          JSON.stringify((b as Record<string, unknown>).translationStatus) ===
            JSON.stringify({ in: ["failed"] })
      ),
      "failed must be reopenable"
    );
  });

  it("includes never-asked rows, which nothing else in the system can reach", () => {
    // The translation columns were added nullable and unbackfilled, so a pre-v2-4
    // article reads as null — and translationSelectableWhere never matches it.
    const branches = statusBranches(retranslatableWhere("c", "s", NOW));
    assert.ok(
      branches.some((b) => JSON.stringify(b) === JSON.stringify({ translationStatus: null }))
    );
  });

  it("includes a crashed claim whose lease has expired, but never a live one", () => {
    const branches = statusBranches(retranslatableWhere("c", "s", NOW));
    const translating = branches.find(
      (b) =>
        typeof b === "object" &&
        b !== null &&
        (b as Record<string, unknown>).translationStatus === "translating"
    ) as Record<string, unknown> | undefined;

    assert.ok(translating, "an expired claim must be recoverable");
    assert.deepEqual(translating.translationLeaseExpiresAt, { lt: NOW });
  });

  it("never reopens a COMPLETED translation BY DEFAULT", () => {
    // Requirement, not preference: a successful translation is not thrown away by an
    // accidental click. `includeCompleted` (below) is the explicit escape hatch.
    const serialised = JSON.stringify(retranslatableWhere("c", "s", NOW));
    assert.ok(!serialised.includes("completed"));
  });

  it("reopens a COMPLETED translation when includeCompleted is explicitly true", () => {
    const branches = statusBranches(retranslatableWhere("c", "s", NOW, true));
    assert.ok(
      branches.some(
        (b) =>
          typeof b === "object" &&
          b !== null &&
          (b as Record<string, unknown>).translationStatus === "completed"
      ),
      "an explicit request must be able to reach a successful translation"
    );
  });

  it("matches a completed row on STATUS alone, not on a hash comparison", () => {
    // The whole point of asking is to force a fresh attempt even when the article's
    // hash has not moved — a hash-gated branch would silently do nothing for the
    // common case (identical article, operator wants a BETTER translation of it).
    const branches = statusBranches(retranslatableWhere("c", "s", NOW, true));
    const completed = branches.find(
      (b) =>
        typeof b === "object" &&
        b !== null &&
        (b as Record<string, unknown>).translationStatus === "completed"
    ) as Record<string, unknown>;
    assert.deepEqual(completed, { translationStatus: "completed" });
  });

  it("does not add the completed branch at all when includeCompleted is false", () => {
    // Not merely "excluded by a filter" — explicitly absent from the query, so a
    // reader of the generated WHERE can see the feature was not asked for.
    assert.deepEqual(retranslatableWhere("c", "s", NOW, false), retranslatableWhere("c", "s", NOW));
  });

  it("still excludes a CONSUMED article even with includeCompleted", () => {
    // Forcing a redo is still a request about future output; a published post's
    // article is not that, regardless of which statuses are being reopened.
    assert.equal(retranslatableWhere("c", "s", NOW, true).usedInPost, false);
  });

  it("includeCompleted does not loosen ANY of the other exclusions", () => {
    // pending, skipped, and a LIVE translating claim must stay excluded — the flag
    // widens exactly one status, not the whole rule.
    const serialised = JSON.stringify(retranslatableWhere("c", "s", NOW, true));
    assert.ok(!serialised.includes('"pending"'));
    assert.ok(!serialised.includes("skipped"));
    const branches = statusBranches(retranslatableWhere("c", "s", NOW, true));
    const translatingBranches = branches.filter(
      (b) =>
        typeof b === "object" &&
        b !== null &&
        (b as Record<string, unknown>).translationStatus === "translating"
    );
    assert.equal(translatingBranches.length, 1, "only the expired-lease recovery branch");
  });

  it("never reopens a PENDING row — it is already queued", () => {
    const serialised = JSON.stringify(retranslatableWhere("c", "s", NOW));
    assert.ok(!serialised.includes("pending"));
  });

  it("never reopens a SKIPPED row", () => {
    // Terminal by design, and both causes are covered elsewhere: translation turned
    // off (re-enabling plus the next ingest reopens it, because the stored hash is
    // null and cannot match) or an article with no text (which would be re-skipped
    // without a model call and only inflate the reported count).
    const serialised = JSON.stringify(retranslatableWhere("c", "s", NOW));
    assert.ok(!serialised.includes("skipped"));
  });

  it("keeps consumed articles out, exactly as reclassification does", () => {
    // An article already written from is history: its translation is the text a
    // published post was built on.
    assert.equal(retranslatableWhere("c", "s", NOW).usedInPost, false);
  });
});

// ─── The reset ────────────────────────────────────────────────────────────────

describe("RETRANSLATE_REOPEN_DATA — what a reopen writes", () => {
  it("returns the row to pending", () => {
    assert.equal(RETRANSLATE_REOPEN_DATA.translationStatus, "pending");
  });

  it("zeroes the attempt count, without which the reopen is cosmetic", () => {
    // The drain filters on translationAttemptCount < MAX_TRANSLATION_ATTEMPTS, so an
    // exhausted row returned to `pending` with its count intact is reopened on paper
    // and unreachable in fact — which is the whole bug this action exists to undo.
    assert.equal(RETRANSLATE_REOPEN_DATA.translationAttemptCount, 0);
    assert.ok(RETRANSLATE_REOPEN_DATA.translationAttemptCount < MAX_TRANSLATION_ATTEMPTS);

    const selectable = translationSelectableWhere(NOW) as Record<string, unknown>;
    assert.deepEqual(
      selectable.translationAttemptCount,
      { lt: MAX_TRANSLATION_ATTEMPTS },
      "if the drain's own filter changes, this reset has to change with it"
    );
  });

  it("clears banked MADLAD batch progress from the run that failed", () => {
    // The schema is explicit that translationProgress must not outlive its article's
    // attempt; leaving it would resume a fresh translation from raw segments produced
    // under the settings that just failed.
    //
    // Compared against Prisma's own sentinel rather than `null`: a nullable Json
    // column is cleared with Prisma.JsonNull, and this is the SAME value
    // translate-feed-item.service.ts writes when it clears the column itself, so the
    // two clears cannot drift into meaning different things.
    assert.equal(RETRANSLATE_REOPEN_DATA.translationProgress, Prisma.JsonNull);
    assert.notEqual(
      RETRANSLATE_REOPEN_DATA.translationProgress,
      undefined,
      "undefined would leave the banked progress in place"
    );
  });

  it("releases a dead claim and clears the backoff", () => {
    assert.equal(RETRANSLATE_REOPEN_DATA.translationLeaseExpiresAt, null);
    assert.equal(RETRANSLATE_REOPEN_DATA.translationNextRetryAt, null);
    assert.equal(RETRANSLATE_REOPEN_DATA.translationError, null);
  });

  it("never touches the article's own text or its source metadata", () => {
    // The extracted article is immutable source data and is exactly what the retry
    // re-reads. Previous OUTPUT is kept too, so the old translation stays visible
    // until a new one replaces it.
    const written = Object.keys(RETRANSLATE_REOPEN_DATA);
    for (const forbidden of [
      "title",
      "content",
      "url",
      "sourceId",
      "companyId",
      "publishedAt",
      "translatedTitle",
      "translatedContent",
      "translationHash",
    ]) {
      assert.ok(!written.includes(forbidden), `${forbidden} must never be reset`);
    }
  });
});

// ─── Reopen + enqueue ─────────────────────────────────────────────────────────

describe("retranslateSourceFeedItems", () => {
  it("enqueues the drain when rows were reopened", async () => {
    let enqueueCalls = 0;
    const result = await retranslateSourceFeedItems(
      "company-1",
      "source-1",
      {},
      {
        reopen: async () => 7,
        enqueue: async () => {
          enqueueCalls += 1;
          return enqueued;
        },
      }
    );

    assert.equal(result.reopened, 7);
    assert.equal(enqueueCalls, 1);
    assert.deepEqual(result.enqueued, enqueued);
  });

  it("does NOT enqueue when nothing was reopened", async () => {
    let enqueueCalls = 0;
    const result = await retranslateSourceFeedItems(
      "company-1",
      "source-1",
      {},
      {
        reopen: async () => 0,
        enqueue: async () => {
          enqueueCalls += 1;
          return enqueued;
        },
      }
    );

    assert.equal(result.reopened, 0);
    assert.equal(result.enqueued, null);
    assert.equal(enqueueCalls, 0, "an empty reopen must not wake the worker");
  });

  it("passes the scope through to the reopen unchanged", async () => {
    const seen: Array<[string, string | null]> = [];
    await retranslateSourceFeedItems(
      "company-1",
      "source-9",
      {},
      {
        reopen: async (c, s) => {
          seen.push([c, s]);
          return 1;
        },
        enqueue: async () => enqueued,
      }
    );
    assert.deepEqual(seen, [["company-1", "source-9"]]);
  });

  it("defaults includeCompleted to false when options is omitted", async () => {
    let seenIncludeCompleted: boolean | undefined;
    await retranslateSourceFeedItems(
      "company-1",
      "source-1",
      {},
      {
        reopen: async (_c, _s, includeCompleted) => {
          seenIncludeCompleted = includeCompleted;
          return 1;
        },
        enqueue: async () => enqueued,
      }
    );
    assert.equal(seenIncludeCompleted, false);
  });

  it("passes includeCompleted: true through to the reopen", async () => {
    let seenIncludeCompleted: boolean | undefined;
    await retranslateSourceFeedItems(
      "company-1",
      "source-1",
      { includeCompleted: true },
      {
        reopen: async (_c, _s, includeCompleted) => {
          seenIncludeCompleted = includeCompleted;
          return 1;
        },
        enqueue: async () => enqueued,
      }
    );
    assert.equal(seenIncludeCompleted, true);
  });
});

// ─── Duplicate protection ─────────────────────────────────────────────────────

describe("duplicate protection", () => {
  it("reports a deduplicated enqueue rather than starting a second run", async () => {
    // The job-level half: the partial unique index jobs_dedupe_active_key rejects a
    // second enqueue while one translation run is queued or active. The run already
    // in flight re-derives its work from the rows, which now include the reopened ones.
    const result = await requestRetranslation(
      "acme",
      "source-1",
      "user-1",
      false,
      {},
      {
        resolveAccess: async () => ({ ok: true, companyId: "company-1" }) as never,
        sourceBelongsToCompany: async () => true,
        translationEnabled: async () => true,
        reopen: async () => 4,
        enqueue: async () => deduped,
      }
    );

    assert.equal(result.success, true);
    assert.ok(result.success);
    assert.equal(result.reopened, 4);
    assert.equal(result.enqueued, false);
    assert.equal(result.deduplicated, true);
  });

  it("leaves already-queued and in-flight rows out of the reopen entirely", () => {
    // The row-level half, and the one that actually prevents duplicate WORK: a
    // `pending` row is already owed a translation and a live `translating` claim is
    // mid-call, so neither is matched by the predicate at all.
    const serialised = JSON.stringify(retranslatableWhere("c", "s", NOW));
    assert.ok(!serialised.includes('"pending"'));
    // The only `translating` branch present is the expired-lease recovery one.
    const branches = statusBranches(retranslatableWhere("c", "s", NOW));
    const translatingBranches = branches.filter(
      (b) =>
        typeof b === "object" &&
        b !== null &&
        (b as Record<string, unknown>).translationStatus === "translating"
    );
    assert.equal(translatingBranches.length, 1);
    assert.ok("translationLeaseExpiresAt" in (translatingBranches[0] as object));
  });

  it("is safe to press twice — the second press matches only what is still eligible", async () => {
    // First press reopens 5; the drain claims them (they become `translating`), so
    // the second press finds nothing and never wakes the worker again.
    const counts = [5, 0];
    let enqueueCalls = 0;
    const deps = {
      resolveAccess: async () => ({ ok: true, companyId: "company-1" }) as never,
      sourceBelongsToCompany: async () => true,
      translationEnabled: async () => true,
      reopen: async () => counts.shift() ?? 0,
      enqueue: async () => {
        enqueueCalls += 1;
        return enqueued;
      },
    };

    const first = await requestRetranslation("acme", "source-1", "user-1", false, {}, deps);
    const second = await requestRetranslation("acme", "source-1", "user-1", false, {}, deps);

    assert.ok(first.success && second.success);
    assert.equal(first.reopened, 5);
    assert.equal(second.reopened, 0);
    assert.equal(enqueueCalls, 1, "the no-op second press must not enqueue");
  });
});

// ─── Access control ───────────────────────────────────────────────────────────

describe("requestRetranslation — authorization", () => {
  const baseDeps = {
    sourceBelongsToCompany: async () => true,
    translationEnabled: async () => true,
    reopen: async () => 3,
    enqueue: async () => enqueued,
  };

  it("reopens for an owner", async () => {
    const result = await requestRetranslation(
      "acme",
      "source-1",
      "user-1",
      false,
      {},
      {
        ...baseDeps,
        resolveAccess: async () => ({ ok: true, companyId: "company-1" }) as never,
      }
    );
    assert.ok(result.success);
    assert.equal(result.reopened, 3);
  });

  it("refuses an editor with FORBIDDEN", async () => {
    const result = await requestRetranslation(
      "acme",
      "source-1",
      "user-1",
      false,
      {},
      {
        ...baseDeps,
        resolveAccess: async () => ({ ok: false, code: "FORBIDDEN" }) as never,
      }
    );
    assert.equal(result.success, false);
    assert.ok(!result.success);
    assert.equal(result.code, "FORBIDDEN");
  });

  it("answers NOT_FOUND for a non-member, so the response cannot confirm the company", async () => {
    const result = await requestRetranslation(
      "acme",
      "source-1",
      "user-1",
      false,
      {},
      {
        ...baseDeps,
        resolveAccess: async () => ({ ok: false, code: "NOT_FOUND" }) as never,
      }
    );
    assert.ok(!result.success);
    assert.equal(result.code, "NOT_FOUND");
  });

  it("answers NOT_FOUND for a source belonging to ANOTHER company, and writes nothing", async () => {
    let reopenCalls = 0;
    const result = await requestRetranslation(
      "acme",
      "someone-elses-source",
      "user-1",
      false,
      {},
      {
        ...baseDeps,
        resolveAccess: async () => ({ ok: true, companyId: "company-1" }) as never,
        sourceBelongsToCompany: async () => false,
        reopen: async () => {
          reopenCalls += 1;
          return 99;
        },
      }
    );

    assert.ok(!result.success);
    assert.equal(result.code, "NOT_FOUND");
    assert.equal(reopenCalls, 0, "an unowned source must leave every row untouched");
  });

  it("lets a global admin through", async () => {
    const result = await requestRetranslation(
      "acme",
      "source-1",
      "admin-1",
      true,
      {},
      {
        ...baseDeps,
        resolveAccess: async () => ({ ok: true, companyId: "company-1" }) as never,
      }
    );
    assert.ok(result.success);
    assert.equal(result.reopened, 3);
  });

  it("passes includeCompleted through to the eventual reopen call", async () => {
    let seenIncludeCompleted: boolean | undefined;
    const result = await requestRetranslation(
      "acme",
      "source-1",
      "user-1",
      false,
      { includeCompleted: true },
      {
        ...baseDeps,
        resolveAccess: async () => ({ ok: true, companyId: "company-1" }) as never,
        reopen: async (_c, _s, includeCompleted) => {
          seenIncludeCompleted = includeCompleted;
          return 2;
        },
      }
    );
    assert.ok(result.success);
    assert.equal(seenIncludeCompleted, true);
  });
});

// ─── Sources with translation turned off ──────────────────────────────────────

describe("requestRetranslation — a source with translation disabled", () => {
  it("reports zero honestly instead of queueing rows the drain would only skip", async () => {
    let reopenCalls = 0;
    let enqueueCalls = 0;
    const result = await requestRetranslation(
      "acme",
      "source-1",
      "user-1",
      false,
      {},
      {
        resolveAccess: async () => ({ ok: true, companyId: "company-1" }) as never,
        sourceBelongsToCompany: async () => true,
        translationEnabled: async () => false,
        reopen: async () => {
          reopenCalls += 1;
          return 42;
        },
        enqueue: async () => {
          enqueueCalls += 1;
          return enqueued;
        },
      }
    );

    assert.ok(result.success);
    assert.equal(result.reopened, 0);
    assert.equal(result.enqueued, false);
    assert.equal(reopenCalls, 0, "nothing may be written for a source that cannot translate");
    assert.equal(enqueueCalls, 0);
  });
});

// ─── The request body ─────────────────────────────────────────────────────────
//
// The route reads `req.json()` and hands whatever it got (or nothing, on a parse
// failure) to this function — see retranslate/route.ts. It lives here rather than
// in the route itself because Node's test runner glob-expands any CLI argument
// containing `[...]` characters, so a `route.test.ts` inside this app's
// `[slug]/[sourceId]` directories is unreachable by `npx tsx --test`; every other
// company-scoped route in this codebase is tested at this same seam for the same
// reason.

describe("parseIncludeCompletedFromBody", () => {
  it("defaults to false for the ordinary bodyless click (undefined body)", () => {
    assert.equal(parseIncludeCompletedFromBody(undefined), false);
  });

  it("reads includeCompleted: true", () => {
    assert.equal(parseIncludeCompletedFromBody({ includeCompleted: true }), true);
  });

  it("reads includeCompleted: false", () => {
    assert.equal(parseIncludeCompletedFromBody({ includeCompleted: false }), false);
  });

  it("defaults to false when the key is absent", () => {
    assert.equal(parseIncludeCompletedFromBody({}), false);
  });

  it("defaults to false for null", () => {
    assert.equal(parseIncludeCompletedFromBody(null), false);
  });

  it("ignores a non-boolean value rather than trusting it", () => {
    assert.equal(parseIncludeCompletedFromBody({ includeCompleted: "true" }), false);
    assert.equal(parseIncludeCompletedFromBody({ includeCompleted: 1 }), false);
    assert.equal(parseIncludeCompletedFromBody({ includeCompleted: null }), false);
  });

  it("defaults to false for a body that is not a plain object", () => {
    assert.equal(parseIncludeCompletedFromBody(["includeCompleted", true]), false);
    assert.equal(parseIncludeCompletedFromBody("includeCompleted"), false);
    assert.equal(parseIncludeCompletedFromBody(42), false);
  });
});

// ─── The classification hand-off ──────────────────────────────────────────────

describe("returning to the classification flow", () => {
  it("reopens classification in the same write, reusing reclassify's own payload", () => {
    // A row eligible here has usually already been JUDGED on its original English
    // text — the classification drain accepts an item whose translation has settled,
    // and `failed` counts as settled. Storing a fresh Bulgarian translation under
    // that verdict without re-asking is the silent half of this feature, and
    // classificationSelectableWhere never revisits a `completed` verdict on its own.
    assert.equal(RECLASSIFY_REOPEN_DATA.classificationStatus, "pending");
    assert.equal(RECLASSIFY_REOPEN_DATA.classificationAttemptCount, 0);
  });

  it("does not race translation — the verdict waits for the new text", () => {
    // Both statuses go to `pending` together, and the classification drain skips any
    // item whose translation has NOT settled, so the re-judgement necessarily happens
    // after the retranslation lands rather than beside it.
    assert.equal(RETRANSLATE_REOPEN_DATA.translationStatus, "pending");
    assert.equal(RECLASSIFY_REOPEN_DATA.classificationStatus, "pending");
  });
});
