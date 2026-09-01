import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractCompetitorIntelligence,
  type ExtractCompetitorIntelligenceDb,
  type ExtractableIntelligenceItem,
} from "./extract-competitor-intelligence.service";
import type { ILlmProvider } from "@/lib/ai/types";

const VALID_REPLY = JSON.stringify({
  topic: "Home insulation",
  subtopic: null,
  summary: "A guide to insulating an attic.",
  angle: null,
  hookType: "question",
  structurePattern: "how_to",
  targetAudience: null,
  problemAddressed: null,
  keyMessage: null,
  tone: null,
  ctaText: null,
  contentType: "guide",
  commercialIntent: null,
  ctaType: null,
  angleCategory: "how_to",
  productsServicesMentioned: [],
  originalLanguage: "en",
});

/** In-memory row store + fake DB satisfying `ExtractCompetitorIntelligenceDb`. */
function makeFakeDb(overrides: {
  row: { id: string; status: string; leaseExpiresAt: Date | null; attemptCount: number };
  competitorArchivedAt?: Date | null;
}) {
  const row = { ...overrides.row };
  let competitorArchivedAt = overrides.competitorArchivedAt ?? null;
  const writes: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];

  const db: ExtractCompetitorIntelligenceDb = {
    competitorIntelligence: {
      updateMany: async ({ where, data }) => {
        writes.push({ where, data });
        const w = where as { id: string; status?: string; leaseExpiresAt?: Date };
        if (w.id !== row.id) return { count: 0 };
        if (w.status !== undefined && row.status !== w.status) return { count: 0 };
        if (
          w.leaseExpiresAt !== undefined &&
          row.leaseExpiresAt?.getTime() !== w.leaseExpiresAt.getTime()
        ) {
          return { count: 0 };
        }
        // OR-claim shape: { OR: [{status:{in:[...]}}, {status:"analyzing", leaseExpiresAt:{lt:now}}] }
        if (w.status === undefined && "OR" in where) {
          const or = (where as { OR: Array<Record<string, unknown>> }).OR;
          const matchesPendingFailed =
            "status" in or[0] && (or[0].status as { in: string[] }).in.includes(row.status);
          const matchesExpiredLease =
            or[1] &&
            row.status === "analyzing" &&
            row.leaseExpiresAt !== null &&
            row.leaseExpiresAt.getTime() < (or[1].leaseExpiresAt as { lt: Date }).lt.getTime();
          if (!matchesPendingFailed && !matchesExpiredLease) return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    competitor: {
      findFirst: async () => ({ archivedAt: competitorArchivedAt }),
    },
  };

  return { db, row, writes, setArchived: (d: Date | null) => (competitorArchivedAt = d) };
}

function item(overrides: Partial<ExtractableIntelligenceItem> = {}): ExtractableIntelligenceItem {
  return {
    id: "ci-1",
    competitorId: "c-1",
    status: "pending",
    attemptCount: 0,
    // 2026-09 content-acquisition fix: kept comfortably above
    // MIN_ANALYZABLE_CONTENT_LENGTH so this default fixture exercises the
    // ordinary extraction path, not the new content_too_short gate — see the
    // dedicated "content_too_short" describe block below for that.
    feedItem: {
      title: "T",
      content: "Some article body about home insulation and energy savings.",
    },
    manualEntry: null,
    ...overrides,
  };
}

function stubProvider(text: string): ILlmProvider {
  return { generate: async () => ({ text }) };
}

const okProvider = async () => ({
  ok: true as const,
  instance: stubProvider(VALID_REPLY),
  provider: "test",
  model: "test-model",
});

describe("extractCompetitorIntelligence — claim", () => {
  it("claims a pending row and persists a successful extraction", async () => {
    const { db, row } = makeFakeDb({
      row: { id: "ci-1", status: "pending", leaseExpiresAt: null, attemptCount: 0 },
    });
    const outcome = await extractCompetitorIntelligence(item(), {
      db,
      resolveProvider: okProvider,
    });
    assert.deepEqual(outcome, { status: "extracted" });
    assert.equal(row.status, "completed");
  });

  it("skips as 'claimed' when the row is already being processed by another run (live lease)", async () => {
    const future = new Date(Date.now() + 60_000);
    const { db } = makeFakeDb({
      row: { id: "ci-1", status: "analyzing", leaseExpiresAt: future, attemptCount: 1 },
    });
    const outcome = await extractCompetitorIntelligence(
      item({ status: "analyzing", attemptCount: 1 }),
      {
        db,
        resolveProvider: okProvider,
      }
    );
    assert.deepEqual(outcome, { status: "skipped", reason: "claimed" });
  });

  it("reclaims a row whose lease has expired (crashed run recovery)", async () => {
    const past = new Date(Date.now() - 60_000);
    const { db, row } = makeFakeDb({
      row: { id: "ci-1", status: "analyzing", leaseExpiresAt: past, attemptCount: 1 },
    });
    const outcome = await extractCompetitorIntelligence(
      item({ status: "analyzing", attemptCount: 1 }),
      {
        db,
        resolveProvider: okProvider,
      }
    );
    assert.deepEqual(outcome, { status: "extracted" });
    assert.equal(row.status, "completed");
  });

  it("respects the max-attempts cap without even attempting a claim", async () => {
    const { db } = makeFakeDb({
      row: { id: "ci-1", status: "failed", leaseExpiresAt: null, attemptCount: 3 },
    });
    const outcome = await extractCompetitorIntelligence(
      item({ status: "failed", attemptCount: 3 }),
      {
        db,
        resolveProvider: okProvider,
      }
    );
    assert.deepEqual(outcome, { status: "skipped", reason: "max_attempts" });
  });
});

describe("extractCompetitorIntelligence — archived (§5/§14, fresh re-check)", () => {
  it("skips when the competitor is ALREADY archived at claim time", async () => {
    const { db, row } = makeFakeDb({
      row: { id: "ci-1", status: "pending", leaseExpiresAt: null, attemptCount: 0 },
      competitorArchivedAt: new Date(),
    });
    const outcome = await extractCompetitorIntelligence(item(), {
      db,
      resolveProvider: okProvider,
    });
    assert.deepEqual(outcome, { status: "skipped", reason: "archived" });
    // Released back to pending, not left stuck "analyzing" or burned as a failure.
    assert.equal(row.status, "pending");
    assert.equal(row.leaseExpiresAt, null);
  });

  it("skips when the competitor is archived AFTER the caller's selection snapshot but BEFORE the model call", async () => {
    // Reproduces the exact race §5 asks about: the item passed in carries no
    // archived flag at all (by design), so this can only be caught by a
    // FRESH read at execution time.
    const { db, setArchived } = makeFakeDb({
      row: { id: "ci-1", status: "pending", leaseExpiresAt: null, attemptCount: 0 },
      competitorArchivedAt: null,
    });
    setArchived(new Date()); // archived "just before" this call runs
    const outcome = await extractCompetitorIntelligence(item(), {
      db,
      resolveProvider: okProvider,
    });
    assert.deepEqual(outcome, { status: "skipped", reason: "archived" });
  });

  it("does NOT burn a real attempt slot's worth of failure state on an archived skip", async () => {
    const { db, row } = makeFakeDb({
      row: { id: "ci-1", status: "pending", leaseExpiresAt: null, attemptCount: 0 },
      competitorArchivedAt: new Date(),
    });
    await extractCompetitorIntelligence(item(), { db, resolveProvider: okProvider });
    assert.notEqual(row.status, "failed");
  });

  // 2026-09 livelock fix, second bug found in the same pass: the archived
  // release used to leave the claim's attemptCount increment in place,
  // contradicting this describe block's own name. Regression coverage for
  // that specific scar, starting from a non-zero attemptCount so a bug that
  // merely resets to 0 (instead of restoring the PRE-claim value) would still
  // be caught.
  it("restores attemptCount to its PRE-claim value on an archived release, not just off of 'failed'", async () => {
    const { db, row } = makeFakeDb({
      row: { id: "ci-1", status: "failed", leaseExpiresAt: null, attemptCount: 1 },
      competitorArchivedAt: new Date(),
    });
    const outcome = await extractCompetitorIntelligence(
      item({ status: "failed", attemptCount: 1 }),
      { db, resolveProvider: okProvider }
    );
    assert.deepEqual(outcome, { status: "skipped", reason: "archived" });
    assert.equal(row.attemptCount, 1, "attemptCount must be restored to its pre-claim value (1)");
    assert.equal(row.status, "pending");
  });
});

describe("extractCompetitorIntelligence — persistence only while the claim is owned", () => {
  it("does not persist a result if a concurrent run reclaimed the row mid-flight", async () => {
    const { db, row } = makeFakeDb({
      row: { id: "ci-1", status: "pending", leaseExpiresAt: null, attemptCount: 0 },
    });
    let resolveGenerate!: (v: { text: string }) => void;
    let notifyGenerateCalled!: () => void;
    const generateCalled = new Promise<void>((resolve) => (notifyGenerateCalled = resolve));
    const stalling: ILlmProvider = {
      generate: () => {
        const p = new Promise<{ text: string }>((resolve) => (resolveGenerate = resolve));
        notifyGenerateCalled();
        return p;
      },
    };
    const pending = extractCompetitorIntelligence(item(), {
      db,
      resolveProvider: async () => ({ ok: true, instance: stalling, provider: "t", model: "m" }),
    });
    // Wait until the model call has actually started (past the claim and the
    // archived re-check) before simulating a concurrent run stealing the
    // claim — otherwise `resolveGenerate` may not be assigned yet.
    await generateCalled;
    row.status = "analyzing";
    row.leaseExpiresAt = new Date(Date.now() + 999_000); // a DIFFERENT lease
    resolveGenerate({ text: VALID_REPLY });
    const outcome = await pending;
    assert.deepEqual(outcome, { status: "skipped", reason: "claimed" });
  });
});

describe("extractCompetitorIntelligence — content resolution", () => {
  it("reads from feedItem when present", async () => {
    const { db, row } = makeFakeDb({
      row: { id: "ci-1", status: "pending", leaseExpiresAt: null, attemptCount: 0 },
    });
    await extractCompetitorIntelligence(
      item({
        feedItem: {
          title: "T",
          content: "A feedItem body long enough to clear the analyzable-content bar.",
        },
        manualEntry: null,
      }),
      { db, resolveProvider: okProvider }
    );
    assert.equal(row.status, "completed");
  });

  it("reads from manualEntry when feedItem is absent", async () => {
    const { db, row } = makeFakeDb({
      row: { id: "ci-1", status: "pending", leaseExpiresAt: null, attemptCount: 0 },
    });
    await extractCompetitorIntelligence(
      item({ feedItem: null, manualEntry: { content: "Pasted content" } }),
      { db, resolveProvider: okProvider }
    );
    assert.equal(row.status, "completed");
  });

  // 2026-09 livelock fix (see the module comment): this used to run BEFORE
  // the atomic claim and write `status: "failed"` unconditionally, never
  // touching `attemptCount` — the row stayed selectable forever, which is
  // exactly the production incident this regression guards against. It now
  // runs AFTER the claim, so it consumes attempt budget like every other
  // terminal outcome. Provider resolution therefore now DOES happen (it sits
  // before the claim), but the model is still never actually called — the
  // check below bails before the generate() loop, which `stubProvider`'s
  // `generate` would throw if reached.
  it("fails with missing_content when the loaded origin's body is empty, consuming an attempt without calling the model", async () => {
    const { db, row } = makeFakeDb({
      row: { id: "ci-1", status: "pending", leaseExpiresAt: null, attemptCount: 0 },
    });
    let generateCalled = false;
    const outcome = await extractCompetitorIntelligence(
      item({ feedItem: { title: null, content: "" }, manualEntry: null }),
      {
        db,
        resolveProvider: async () => ({
          ok: true,
          instance: {
            generate: async () => {
              generateCalled = true;
              return { text: VALID_REPLY };
            },
          },
          provider: "test",
          model: "test-model",
        }),
      }
    );
    assert.deepEqual(outcome, { status: "skipped", reason: "missing_content" });
    assert.equal(generateCalled, false, "the model must never be called for empty content");
    assert.equal(row.status, "failed");
    assert.equal(row.attemptCount, 1, "attemptCount must advance so this row eventually ages out");
  });

  it("fails with missing_origin (distinct from missing_content) when neither feedItem nor manualEntry loaded", async () => {
    const { db, row } = makeFakeDb({
      row: { id: "ci-1", status: "pending", leaseExpiresAt: null, attemptCount: 0 },
    });
    const outcome = await extractCompetitorIntelligence(
      item({ feedItem: null, manualEntry: null }),
      { db, resolveProvider: okProvider }
    );
    assert.deepEqual(outcome, { status: "skipped", reason: "missing_origin" });
    assert.equal(row.status, "failed");
    assert.equal(row.attemptCount, 1);
  });

  it("a missing-content row eventually ages out of eligibility after MAX_EXTRACTION_ATTEMPTS repeats", async () => {
    const { db, row } = makeFakeDb({
      row: { id: "ci-1", status: "pending", leaseExpiresAt: null, attemptCount: 0 },
    });
    let outcome;
    for (let i = 0; i < 3; i++) {
      outcome = await extractCompetitorIntelligence(
        item({
          status: row.status,
          attemptCount: row.attemptCount,
          feedItem: { title: null, content: "" },
          manualEntry: null,
        }),
        { db, resolveProvider: okProvider }
      );
    }
    assert.deepEqual(outcome, { status: "skipped", reason: "missing_content" });
    assert.equal(row.attemptCount, 3);
    // A 4th attempt is refused up front — matches selectableWhere's cap, no
    // DB write, no infinite growth.
    const finalOutcome = await extractCompetitorIntelligence(
      item({
        status: row.status,
        attemptCount: row.attemptCount,
        feedItem: { title: null, content: "" },
        manualEntry: null,
      }),
      { db, resolveProvider: okProvider }
    );
    assert.deepEqual(finalOutcome, { status: "skipped", reason: "max_attempts" });
    assert.equal(
      row.attemptCount,
      3,
      "max_attempts must not itself increment attemptCount further"
    );
  });
});

describe("extractCompetitorIntelligence — no provider", () => {
  it("returns no_provider and does not touch the row", async () => {
    const { db, row } = makeFakeDb({
      row: { id: "ci-1", status: "pending", leaseExpiresAt: null, attemptCount: 0 },
    });
    const outcome = await extractCompetitorIntelligence(item(), {
      db,
      resolveProvider: async () => ({ ok: false }),
    });
    assert.deepEqual(outcome, { status: "no_provider" });
    assert.equal(row.status, "pending");
  });
});

// ─── 2026-09 content-acquisition fix — the too-thin content gate ─────────────
//
// With `<content:encoded>` now parsed (see parser.ts) a feed fallback can be
// real text but still useless — "Read more...", a bare repeated title. That is
// not worth a model call, and it must NOT be silently treated as a full
// analyzable article. See this service's module comment.

describe("extractCompetitorIntelligence — content_too_short", () => {
  it("refuses a below-threshold RSS fallback WITHOUT calling the model", async () => {
    const { db, row } = makeFakeDb({
      row: { id: "ci-1", status: "pending", leaseExpiresAt: null, attemptCount: 0 },
    });
    let generateCalled = false;
    const outcome = await extractCompetitorIntelligence(
      item({ feedItem: { title: "T", content: "Read more..." } }),
      {
        db,
        resolveProvider: async () => ({
          ok: true as const,
          instance: {
            generate: async () => {
              generateCalled = true;
              return { text: VALID_REPLY };
            },
          },
          provider: "test",
          model: "test-model",
        }),
      }
    );

    assert.deepEqual(outcome, { status: "skipped", reason: "content_too_short" });
    assert.equal(generateCalled, false, "a blurb must never cost a model call");
    assert.equal(row.status, "failed");
  });

  it("consumes attempt budget, so a permanently-thin row ages out instead of looping", async () => {
    // The livelock lesson applied to the new branch: this is a terminal
    // outcome and must advance state exactly like every other one.
    const { db, row } = makeFakeDb({
      row: { id: "ci-1", status: "pending", leaseExpiresAt: null, attemptCount: 0 },
    });
    const thin = item({ feedItem: { title: "T", content: "Read more..." } });

    for (let i = 1; i <= 3; i++) {
      const outcome = await extractCompetitorIntelligence(
        { ...thin, status: row.status, attemptCount: row.attemptCount },
        { db, resolveProvider: okProvider }
      );
      assert.deepEqual(outcome, { status: "skipped", reason: "content_too_short" });
      assert.equal(row.attemptCount, i, `attempt ${i} must advance the count`);
    }

    const fourth = await extractCompetitorIntelligence(
      { ...thin, status: row.status, attemptCount: row.attemptCount },
      { db, resolveProvider: okProvider }
    );
    assert.deepEqual(fourth, { status: "skipped", reason: "max_attempts" });
  });

  it("records WHY it was refused, with the measured length", async () => {
    const { db, row } = makeFakeDb({
      row: { id: "ci-1", status: "pending", leaseExpiresAt: null, attemptCount: 0 },
    });
    await extractCompetitorIntelligence(item({ feedItem: { title: "T", content: "Too short." } }), {
      db,
      resolveProvider: okProvider,
    });
    assert.match(
      String((row as unknown as { analysisError: string }).analysisError),
      /too short/i,
      "the reason must be distinguishable from a plain missing-content failure"
    );
  });

  it("still ACCEPTS a substantial RSS fallback — the fix must not over-reject", async () => {
    // This is the whole point of the acquisition fix: a real
    // <content:encoded> body reaches the model.
    const { db, row } = makeFakeDb({
      row: { id: "ci-1", status: "pending", leaseExpiresAt: null, attemptCount: 0 },
    });
    const outcome = await extractCompetitorIntelligence(
      item({
        feedItem: {
          title: "T",
          content: "The full article body the publisher shipped in content:encoded. ".repeat(4),
        },
      }),
      { db, resolveProvider: okProvider }
    );
    assert.deepEqual(outcome, { status: "extracted" });
    assert.equal(row.status, "completed");
  });

  it("never applies the threshold to a MANUAL entry — owner-typed text is deliberate", async () => {
    // A short pasted ad headline is genuine competitive signal, not feed
    // noise, and the owner explicitly chose to add it.
    const { db, row } = makeFakeDb({
      row: { id: "ci-1", status: "pending", leaseExpiresAt: null, attemptCount: 0 },
    });
    const outcome = await extractCompetitorIntelligence(
      item({ feedItem: null, manualEntry: { content: "Half price this week." } }),
      { db, resolveProvider: okProvider }
    );
    assert.deepEqual(outcome, { status: "extracted" });
    assert.equal(row.status, "completed");
  });

  it("an empty body is still missing_content, not content_too_short", async () => {
    const { db } = makeFakeDb({
      row: { id: "ci-1", status: "pending", leaseExpiresAt: null, attemptCount: 0 },
    });
    const outcome = await extractCompetitorIntelligence(
      item({ feedItem: { title: "T", content: null } }),
      { db, resolveProvider: okProvider }
    );
    assert.deepEqual(outcome, { status: "skipped", reason: "missing_content" });
  });
});
