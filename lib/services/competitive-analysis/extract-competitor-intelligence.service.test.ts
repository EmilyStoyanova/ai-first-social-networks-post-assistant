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
    feedItem: { title: "T", content: "Some article body about insulation." },
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
      item({ feedItem: { title: "T", content: "Body" }, manualEntry: null }),
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

  it("fails with no_content when both origins are empty, without ever calling the model", async () => {
    const { db, row } = makeFakeDb({
      row: { id: "ci-1", status: "pending", leaseExpiresAt: null, attemptCount: 0 },
    });
    let called = false;
    const outcome = await extractCompetitorIntelligence(
      item({ feedItem: { title: null, content: "" }, manualEntry: null }),
      { db, resolveProvider: async () => (called = true) as never }
    );
    assert.deepEqual(outcome, { status: "skipped", reason: "no_content" });
    assert.equal(called, false);
    assert.equal(row.status, "failed");
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
