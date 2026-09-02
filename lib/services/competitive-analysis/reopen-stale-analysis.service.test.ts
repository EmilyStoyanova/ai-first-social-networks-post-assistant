/**
 * Stale-analysis recovery sweep — regression suite (2026-09-02).
 *
 * The fake store below is deliberately a real little state machine rather than
 * a set of canned answers: the properties under test (re-opened exactly once,
 * idempotent across restarts, no per-row job fan-out) are only meaningful if
 * re-opening actually MOVES a row out of the completed set the next sweep
 * reads, and a stub that always returns the same page would pass while the
 * real thing looped forever.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  reopenStaleAnalysis,
  reopenStaleAnalysisForCompany,
  triggerStaleAnalysisRecoveryForCompany,
  ANALYSIS_RECOVERY_MAX_REOPENS_PER_SWEEP,
  type CompletedAnalysisRow,
  type RecoverableAnalysisCompany,
} from "./reopen-stale-analysis.service";
import { computeExtractionHash } from "@/lib/ai/competitor-intelligence-extraction";
import {
  runCompetitorIntelligenceExtraction,
  selectableWhere,
} from "./run-competitor-intelligence-extraction.service";
import type { EnqueueJobResult } from "@/lib/services/queue/enqueue-job.service";

const BODY = "A reasonably long competitor article about heat pumps and insulation.";
const TITLE = "Heat pumps in 2026";

const hashFor = (language: "en" | "bg", body = BODY, title: string | null = TITLE) =>
  computeExtractionHash({ title, body }, language);

interface FakeRow {
  id: string;
  companyId: string;
  status: string;
  attemptCount: number;
  analysisHash: string | null;
  analysisError: string | null;
  leaseExpiresAt: Date | null;
  archived: boolean;
  feedItem: { title: string | null; content: string | null } | null;
  manualEntry: { content: string } | null;
  /** Never read by the sweep — present so a test can prove it is never
   *  written either. */
  competitorId: string;
}

function row(over: Partial<FakeRow> = {}): FakeRow {
  return {
    id: over.id ?? "ci-1",
    companyId: over.companyId ?? "co-1",
    status: over.status ?? "completed",
    attemptCount: over.attemptCount ?? 3,
    analysisHash: over.analysisHash !== undefined ? over.analysisHash : hashFor("en"),
    analysisError: over.analysisError ?? null,
    leaseExpiresAt: over.leaseExpiresAt ?? null,
    archived: over.archived ?? false,
    feedItem: over.feedItem !== undefined ? over.feedItem : { title: TITLE, content: BODY },
    manualEntry: over.manualEntry ?? null,
    competitorId: over.competitorId ?? "comp-1",
  };
}

/** In-memory store implementing the sweep's three DB seams faithfully —
 *  including the guarded write's `where` clause, which is where most of the
 *  safety actually lives. */
function makeStore(companies: RecoverableAnalysisCompany[], rows: FakeRow[]) {
  const enqueues: number[] = [];
  let queuedDrainActive = false;

  const listCompanies = async (limit: number) =>
    companies
      .filter((c) => rows.some((r) => r.companyId === c.id && r.status === "completed"))
      .slice(0, limit);

  const listCompletedRows = async (
    companyId: string,
    afterId: string | null,
    take: number
  ): Promise<CompletedAnalysisRow[]> =>
    rows
      .filter(
        (r) =>
          r.companyId === companyId &&
          r.status === "completed" &&
          !r.archived &&
          (afterId === null || r.id > afterId)
      )
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, take)
      .map((r) => ({
        id: r.id,
        analysisHash: r.analysisHash,
        feedItem: r.feedItem,
        manualEntry: r.manualEntry,
      }));

  const reopenRow = async (id: string, expectedHash: string | null): Promise<boolean> => {
    // Mirrors the real guarded updateMany's `where` exactly.
    const target = rows.find(
      (r) => r.id === id && r.status === "completed" && r.analysisHash === expectedHash
    );
    if (!target) return false;
    target.status = "pending";
    target.attemptCount = 0;
    target.analysisError = null;
    target.leaseExpiresAt = null;
    return true;
  };

  const enqueueExtraction = async (): Promise<EnqueueJobResult> => {
    enqueues.push(Date.now());
    const deduplicated = queuedDrainActive;
    queuedDrainActive = true;
    return { enqueued: !deduplicated, deduplicated, jobId: "drain-1" };
  };

  /** Simulates the extraction drain doing its job: every pending row is
   *  re-analyzed and stores the CURRENT hash for its company's language. */
  const drain = (language: (companyId: string) => "en" | "bg") => {
    queuedDrainActive = false;
    for (const r of rows) {
      if (r.status !== "pending") continue;
      const content = r.feedItem
        ? { title: r.feedItem.title, body: r.feedItem.content ?? "" }
        : r.manualEntry
          ? { title: null, body: r.manualEntry.content }
          : null;
      if (!content) continue;
      r.status = "completed";
      r.analysisHash = computeExtractionHash(content, language(r.companyId));
    }
  };

  return {
    deps: { listCompanies, listCompletedRows, reopenRow, enqueueExtraction },
    enqueues,
    drain,
  };
}

const BG_CO: RecoverableAnalysisCompany = { id: "co-1", analysisLanguage: "bg" };
const EN_CO: RecoverableAnalysisCompany = { id: "co-2", analysisLanguage: "en" };

describe("reopenStaleAnalysis — detection", () => {
  it("(1) re-opens a v1 English row for a Bulgarian company", async () => {
    const rows = [row({ id: "ci-1", analysisHash: hashFor("en") })];
    const store = makeStore([BG_CO], rows);

    const summary = await reopenStaleAnalysis(store.deps);

    assert.equal(summary.reopened, 1);
    assert.equal(summary.byStaleness.stale_hash, 1);
    assert.equal(rows[0]!.status, "pending");
  });

  it("(2)(7) leaves a current v2 Bulgarian row completely untouched", async () => {
    const rows = [row({ id: "ci-1", analysisHash: hashFor("bg") })];
    const store = makeStore([BG_CO], rows);

    const summary = await reopenStaleAnalysis(store.deps);

    assert.equal(summary.reopened, 0);
    assert.equal(summary.byStaleness.current, 1);
    assert.equal(rows[0]!.status, "completed");
    assert.equal(rows[0]!.attemptCount, 3, "an untouched row keeps its attempt history");
    assert.deepEqual(store.enqueues, [], "(8) nothing stale means no job at all");
  });

  it("(3) the SAME row is stale for a Bulgarian company and current for an English one", async () => {
    const enRows = [row({ id: "ci-1", companyId: "co-2", analysisHash: hashFor("en") })];
    const enStore = makeStore([EN_CO], enRows);
    assert.equal((await reopenStaleAnalysis(enStore.deps)).reopened, 0);

    const bgRows = [row({ id: "ci-1", companyId: "co-1", analysisHash: hashFor("en") })];
    const bgStore = makeStore([BG_CO], bgRows);
    assert.equal((await reopenStaleAnalysis(bgStore.deps)).reopened, 1);
  });

  it("re-opens a completed row that carries no fingerprint at all", async () => {
    const rows = [row({ id: "ci-1", analysisHash: null })];
    const store = makeStore([BG_CO], rows);

    const summary = await reopenStaleAnalysis(store.deps);

    assert.equal(summary.byStaleness.missing_hash, 1);
    assert.equal(summary.reopened, 1);
  });

  it("normalizes an unsupported analysisLanguage to English rather than inventing a language", async () => {
    const rows = [row({ id: "ci-1", companyId: "co-3", analysisHash: hashFor("en") })];
    const store = makeStore([{ id: "co-3", analysisLanguage: "de" }], rows);

    const summary = await reopenStaleAnalysis(store.deps);

    assert.equal(
      summary.reopened,
      0,
      "a company with an unrecognized analysisLanguage analyses in English, so an English row is current"
    );
  });

  it("(4) changing Company.defaultLang cannot stale anything — this sweep no longer reads it at all", async () => {
    // Structural, not just behavioral: `RecoverableAnalysisCompany` carries
    // only `id`/`analysisLanguage` — there is no `defaultLang` field left to
    // change. A row analyzed in Bulgarian stays current for a company whose
    // `analysisLanguage` is "bg", full stop, regardless of anything Brand
    // configures.
    const rows = [row({ id: "ci-1", companyId: "co-1", analysisHash: hashFor("bg") })];
    const store = makeStore([{ id: "co-1", analysisLanguage: "bg" }], rows);

    const summary = await reopenStaleAnalysis(store.deps);

    assert.equal(summary.reopened, 0);
    assert.equal(summary.byStaleness.current, 1);
  });

  it("(ownership-boundary) a company with completed content but NO saved Research Profile defaults to English, not Company.defaultLang", async () => {
    // Extraction never required a persisted Research Profile — a company can
    // have `completed` rows before ever saving one. `analysisLanguage: null`
    // is exactly that case, and must fall back to the same safe application
    // default an unrecognized value gets — never reach into Company.defaultLang,
    // which this sweep no longer even receives.
    const rows = [row({ id: "ci-1", companyId: "co-4", analysisHash: hashFor("en") })];
    const store = makeStore([{ id: "co-4", analysisLanguage: null }], rows);

    const summary = await reopenStaleAnalysis(store.deps);

    assert.equal(summary.reopened, 0, "no profile → English default → the English row is current");
    assert.equal(summary.byStaleness.current, 1);
  });
});

describe("reopenStaleAnalysis — what it must never touch", () => {
  it("(5) never re-opens a row that is actively analyzing", async () => {
    const rows = [
      row({
        id: "ci-1",
        status: "analyzing",
        leaseExpiresAt: new Date(Date.now() + 60_000),
        analysisHash: hashFor("en"),
      }),
    ];
    const store = makeStore([BG_CO], rows);

    const summary = await reopenStaleAnalysis(store.deps);

    assert.equal(summary.rowsInspected, 0, "an analyzing row is not even inspected");
    assert.equal(summary.reopened, 0);
    assert.equal(rows[0]!.status, "analyzing");
    assert.notEqual(rows[0]!.leaseExpiresAt, null, "its lease must survive the sweep");
  });

  it("(6) excludes an archived competitor's history", async () => {
    const rows = [row({ id: "ci-1", archived: true, analysisHash: hashFor("en") })];
    const store = makeStore([BG_CO], rows);

    const summary = await reopenStaleAnalysis(store.deps);

    assert.equal(summary.rowsInspected, 0);
    assert.equal(summary.reopened, 0);
    assert.equal(rows[0]!.status, "completed");
  });

  it("never mutates the original competitor content", async () => {
    // The sweep only ever READS title/body — it re-analyzes what the
    // competitor published, it does not rewrite it.
    const rows = [row({ id: "ci-1", analysisHash: hashFor("en") })];
    const store = makeStore([BG_CO], rows);

    await reopenStaleAnalysis(store.deps);

    assert.deepEqual(rows[0]!.feedItem, { title: TITLE, content: BODY });
  });

  it("preserves the origin and competitor references it re-opens across", async () => {
    const rows = [
      row({ id: "ci-1", analysisHash: hashFor("en") }),
      row({
        id: "ci-2",
        analysisHash: hashFor("en", "Pasted ad copy.", null),
        feedItem: null,
        manualEntry: { content: "Pasted ad copy." },
        competitorId: "comp-2",
      }),
    ];
    const store = makeStore([BG_CO], rows);

    const summary = await reopenStaleAnalysis(store.deps);

    assert.equal(summary.reopened, 2, "both origins are recoverable");
    assert.deepEqual(rows[0]!.manualEntry, null);
    assert.deepEqual(rows[1]!.manualEntry, { content: "Pasted ad copy." });
    assert.equal(rows[1]!.competitorId, "comp-2");
  });

  it("skips a row with no readable origin instead of burning its attempt budget", async () => {
    const rows = [row({ id: "ci-1", feedItem: null, manualEntry: null, analysisHash: null })];
    const store = makeStore([BG_CO], rows);

    const summary = await reopenStaleAnalysis(store.deps);

    assert.equal(summary.byStaleness.unanalyzable, 1);
    assert.equal(summary.reopened, 0);
    assert.equal(rows[0]!.status, "completed");
  });

  it("no-ops when the guarded write loses a race, rather than clobbering the winner", async () => {
    const rows = [row({ id: "ci-1", analysisHash: hashFor("en") })];
    const store = makeStore([BG_CO], rows);
    // Another process re-analyzes the row between the read and the write.
    const racingReopen = async (id: string, expectedHash: string | null) => {
      rows[0]!.analysisHash = hashFor("bg");
      return store.deps.reopenRow(id, expectedHash);
    };

    const summary = await reopenStaleAnalysis({ ...store.deps, reopenRow: racingReopen });

    assert.equal(summary.raced, 1);
    assert.equal(summary.reopened, 0);
    assert.equal(rows[0]!.status, "completed");
    assert.deepEqual(store.enqueues, [], "a sweep that re-opened nothing enqueues nothing");
  });
});

describe("reopenStaleAnalysis — bounded, idempotent, no fan-out", () => {
  it("(4)(8)(13) re-opens each stale row exactly once and asks for ONE drain, not one job per row", async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      row({ id: `ci-${String(i).padStart(2, "0")}`, analysisHash: hashFor("en") })
    );
    const store = makeStore([BG_CO], rows);

    const summary = await reopenStaleAnalysis(store.deps);

    assert.equal(summary.reopened, 12);
    assert.equal(
      store.enqueues.length,
      1,
      "one extraction job for the whole sweep — never one per article"
    );
    assert.equal(summary.extractionEnqueued, true);
    assert.equal(
      rows.filter((r) => r.status === "pending").length,
      12,
      "every stale row moved exactly once"
    );
  });

  it("pages past the batch size — a backlog larger than one page is fully found", async () => {
    const rows = Array.from({ length: 120 }, (_, i) =>
      row({ id: `ci-${String(i).padStart(3, "0")}`, analysisHash: hashFor("en") })
    );
    const store = makeStore([BG_CO], rows);

    const summary = await reopenStaleAnalysis(store.deps);

    assert.equal(summary.rowsInspected, 120, "the id cursor must not skip rows it mutates");
    assert.equal(summary.reopened, 120);
  });

  it("(9)(10)(12) a second sweep after re-analysis finds nothing and enqueues nothing", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      row({ id: `ci-${i}`, analysisHash: hashFor("en") })
    );
    const store = makeStore([BG_CO], rows);

    const first = await reopenStaleAnalysis(store.deps);
    assert.equal(first.reopened, 5);

    // The drain runs and stores the current hash — no RSS re-ingestion, no
    // Research Profile edit, no manual DB change involved.
    store.drain(() => "bg");

    const second = await reopenStaleAnalysis(store.deps);
    assert.equal(second.reopened, 0, "restarting must not re-analyze healed rows");
    assert.equal(second.byStaleness.current, 5);
    assert.equal(store.enqueues.length, 1, "the second sweep adds no job at all");
  });

  it("(9) repeated restarts BEFORE the drain runs add no further work", async () => {
    const rows = [row({ id: "ci-1", analysisHash: hashFor("en") })];
    const store = makeStore([BG_CO], rows);

    await reopenStaleAnalysis(store.deps);
    const second = await reopenStaleAnalysis(store.deps);
    const third = await reopenStaleAnalysis(store.deps);

    // The row is already `pending`, so it is no longer in the completed set
    // the sweep reads — it cannot be re-opened a second time.
    assert.equal(second.rowsInspected, 0);
    assert.equal(third.rowsInspected, 0);
    assert.equal(store.enqueues.length, 1, "only the sweep that actually moved a row enqueued");
  });

  it("(13) a row that fails re-analysis leaves `completed` and is never re-opened again", async () => {
    const rows = [row({ id: "ci-1", analysisHash: hashFor("en") })];
    const store = makeStore([BG_CO], rows);

    await reopenStaleAnalysis(store.deps);
    // The drain exhausts MAX_EXTRACTION_ATTEMPTS and settles the row `failed`.
    rows[0]!.status = "failed";
    rows[0]!.attemptCount = 3;

    const second = await reopenStaleAnalysis(store.deps);

    assert.equal(second.rowsInspected, 0, "only completed rows are ever inspected");
    assert.equal(second.reopened, 0);
    assert.equal(rows[0]!.attemptCount, 3, "its exhausted budget is not reset behind its back");
  });

  it("caps re-opens per sweep and reports the sweep as truncated", async () => {
    const overCap = ANALYSIS_RECOVERY_MAX_REOPENS_PER_SWEEP + 10;
    const rows = Array.from({ length: overCap }, (_, i) =>
      row({ id: `ci-${String(i).padStart(4, "0")}`, analysisHash: hashFor("en") })
    );
    const store = makeStore([BG_CO], rows);

    const summary = await reopenStaleAnalysis(store.deps);

    assert.equal(summary.reopened, ANALYSIS_RECOVERY_MAX_REOPENS_PER_SWEEP);
    assert.equal(summary.truncated, true);
    assert.equal(store.enqueues.length, 1);

    // The remainder is picked up by the next start — recovery still completes,
    // it is just spread across restarts.
    const second = await reopenStaleAnalysis(store.deps);
    assert.equal(second.reopened, 10);
  });

  it("collapses into an already-queued drain instead of stacking jobs", async () => {
    const rows = [
      row({ id: "ci-1", analysisHash: hashFor("en") }),
      row({ id: "ci-2", analysisHash: hashFor("en") }),
    ];
    const store = makeStore([BG_CO], rows);

    await reopenStaleAnalysis(store.deps);
    // A second stale row appears (new ingest) while the first drain is still
    // queued; the restart's enqueue must dedupe into it.
    rows.push(row({ id: "ci-3", analysisHash: hashFor("en") }));
    const second = await reopenStaleAnalysis(store.deps);

    assert.equal(second.reopened, 1);
    assert.equal(second.extractionDeduplicated, true);
    assert.equal(second.extractionEnqueued, false);
  });

  it("a failing enqueue never fails the sweep — the rows are already pending", async () => {
    const rows = [row({ id: "ci-1", analysisHash: hashFor("en") })];
    const store = makeStore([BG_CO], rows);

    const summary = await reopenStaleAnalysis({
      ...store.deps,
      enqueueExtraction: async () => {
        throw new Error("queue unavailable");
      },
    });

    assert.equal(summary.reopened, 1);
    assert.equal(summary.extractionEnqueued, false);
    assert.equal(rows[0]!.status, "pending", "the re-open is committed regardless");
  });
});

describe("reopenStaleAnalysis — the natural job chain", () => {
  it("(11)(12) a re-opened row is exactly what the existing extraction drain selects", async () => {
    // The recovery does NOT reach into extraction: it puts the row back into
    // the state the drain already knows how to pick up. This asserts that
    // against the drain's OWN predicate rather than a restatement of it, so a
    // future change to `selectableWhere` this sweep failed to follow breaks
    // here instead of silently stranding re-opened rows.
    const rows = [row({ id: "ci-1", analysisHash: hashFor("en"), attemptCount: 3 })];
    const store = makeStore([BG_CO], rows);

    await reopenStaleAnalysis(store.deps);

    const where = selectableWhere(new Date()) as {
      attemptCount: { lt: number };
      competitor: { archivedAt: null };
      OR: Array<{ status?: unknown }>;
    };
    const reopened = rows[0]!;
    assert.equal(reopened.status, "pending");
    assert.ok(
      reopened.attemptCount < where.attemptCount.lt,
      "the attempt budget must be reset, or the drain would skip the row it just re-opened"
    );
    assert.ok(
      where.OR.some(
        (clause) =>
          Array.isArray((clause.status as { in?: string[] })?.in) &&
          (clause.status as { in: string[] }).in.includes(reopened.status)
      ),
      "a re-opened row must match the drain's own selection"
    );
    assert.equal(reopened.leaseExpiresAt, null, "no stale lease may block the claim");
    assert.equal(reopened.analysisError, null, "the previous error must not persist");
  });

  it("(11) re-extraction of a re-opened row triggers relevance through the existing enqueue", async () => {
    // Nothing new is wired for relevance: the drain's own post-extraction
    // enqueue fires for a recovered row exactly as it does for a fresh one.
    const relevanceFor: string[] = [];
    const summary = await runCompetitorIntelligenceExtraction({
      findCandidates: async () => [
        {
          id: "ci-1",
          companyId: "co-1",
          competitorId: "comp-1",
          status: "pending",
          attemptCount: 0,
          analysisLanguage: "bg",
          feedItem: { title: TITLE, content: BODY },
          manualEntry: null,
        },
      ],
      extract: async () => ({ status: "extracted" }),
      countRemaining: async () => ({ ready: 0, deferred: 0 }),
      enqueueRelevance: async (companyId) => {
        relevanceFor.push(companyId);
        return { enqueued: true, deduplicated: false, jobId: "rel-1" };
      },
    });

    assert.equal(summary.extracted, 1);
    assert.deepEqual(relevanceFor, ["co-1"], "relevance follows extraction with no extra wiring");
    assert.deepEqual(summary.relevanceEnqueuedFor, ["co-1"]);
  });
});

describe("reopenStaleAnalysis — cross-company isolation", () => {
  it("judges each company's rows against its OWN analysis language", async () => {
    const rows = [
      row({ id: "ci-1", companyId: "co-1", analysisHash: hashFor("en") }), // BG company → stale
      row({ id: "ci-2", companyId: "co-2", analysisHash: hashFor("en") }), // EN company → current
    ];
    const store = makeStore([BG_CO, EN_CO], rows);

    const summary = await reopenStaleAnalysis(store.deps);

    assert.equal(summary.reopened, 1);
    assert.deepEqual(summary.companyIds, ["co-1"]);
    assert.equal(rows[0]!.status, "pending");
    assert.equal(rows[1]!.status, "completed", "another company's rows are never touched");
  });

  it("reports only the companies it actually re-opened rows for", async () => {
    const rows = [
      row({ id: "ci-1", companyId: "co-1", analysisHash: hashFor("bg") }),
      row({ id: "ci-2", companyId: "co-2", analysisHash: hashFor("en") }),
    ];
    const store = makeStore([BG_CO, EN_CO], rows);

    const summary = await reopenStaleAnalysis(store.deps);

    assert.equal(summary.companiesExamined, 2);
    assert.deepEqual(summary.companyIds, [], "nothing stale in either company");
  });
});

// ─── 2026-09-02 ownership-boundary fix — the per-company entry point ───────
// `reopenStaleAnalysisForCompany` is the exact mechanism the boot sweep above
// uses internally, extracted so a Research Profile Save can trigger it
// directly for just its own company (`triggerStaleAnalysisRecoveryForCompany`)
// — see update-research-profile.service.ts.
describe("reopenStaleAnalysisForCompany — the extracted single-company sweep", () => {
  it("re-opens a stale row for exactly the company it is called with", async () => {
    const rows = [row({ id: "ci-1", companyId: "co-1", analysisHash: hashFor("en") })];
    const store = makeStore([BG_CO], rows);

    const result = await reopenStaleAnalysisForCompany("co-1", "bg", {
      listCompletedRows: store.deps.listCompletedRows,
      reopenRow: store.deps.reopenRow,
    });

    assert.equal(result.reopened, 1);
    assert.equal(result.byStaleness.stale_hash, 1);
    assert.equal(rows[0]!.status, "pending");
  });

  it("respects its own maxReopens budget independently of the global sweep constant", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      row({ id: `ci-${i}`, companyId: "co-1", analysisHash: hashFor("en") })
    );
    const store = makeStore([BG_CO], rows);

    const result = await reopenStaleAnalysisForCompany("co-1", "bg", {
      listCompletedRows: store.deps.listCompletedRows,
      reopenRow: store.deps.reopenRow,
      maxReopens: 2,
    });

    assert.equal(result.reopened, 2);
    assert.equal(result.truncated, true);
  });

  it("composes into the exact same boot-sweep behavior it was extracted from (regression check)", async () => {
    // Same fixture and assertions as test (4)(8)(13) above — proves the
    // refactor did not change the global sweep's own behavior.
    const rows = Array.from({ length: 12 }, (_, i) =>
      row({ id: `ci-${String(i).padStart(2, "0")}`, analysisHash: hashFor("en") })
    );
    const store = makeStore([BG_CO], rows);

    const summary = await reopenStaleAnalysis(store.deps);

    assert.equal(summary.reopened, 12);
    assert.equal(store.enqueues.length, 1);
  });
});

describe("triggerStaleAnalysisRecoveryForCompany — the Save-triggered path", () => {
  it("re-opens this company's stale rows and enqueues ONE extraction job, exactly like the boot sweep", async () => {
    const rows = [
      row({ id: "ci-1", companyId: "co-1", analysisHash: hashFor("en") }),
      row({ id: "ci-2", companyId: "co-1", analysisHash: hashFor("en") }),
    ];
    const store = makeStore([BG_CO], rows);

    const result = await triggerStaleAnalysisRecoveryForCompany("co-1", "bg", {
      listCompletedRows: store.deps.listCompletedRows,
      reopenRow: store.deps.reopenRow,
      enqueueExtraction: store.deps.enqueueExtraction,
    });

    assert.equal(result.reopened, 2);
    assert.equal(result.extractionEnqueued, true);
    assert.equal(store.enqueues.length, 1, "one job, not one per row");
  });

  it("enqueues nothing when there is nothing stale — a topics/markets/period-only save never reaches this path with anything to do", async () => {
    const rows = [row({ id: "ci-1", companyId: "co-1", analysisHash: hashFor("bg") })];
    const store = makeStore([BG_CO], rows);

    const result = await triggerStaleAnalysisRecoveryForCompany("co-1", "bg", {
      listCompletedRows: store.deps.listCompletedRows,
      reopenRow: store.deps.reopenRow,
      enqueueExtraction: store.deps.enqueueExtraction,
    });

    assert.equal(result.reopened, 0);
    assert.equal(result.extractionEnqueued, false);
    assert.deepEqual(store.enqueues, []);
  });

  it("a failing enqueue never throws — the reopen is already committed regardless", async () => {
    const rows = [row({ id: "ci-1", companyId: "co-1", analysisHash: hashFor("en") })];
    const store = makeStore([BG_CO], rows);

    const result = await triggerStaleAnalysisRecoveryForCompany("co-1", "bg", {
      listCompletedRows: store.deps.listCompletedRows,
      reopenRow: store.deps.reopenRow,
      enqueueExtraction: async () => {
        throw new Error("queue unavailable");
      },
    });

    assert.equal(result.reopened, 1);
    assert.equal(result.extractionEnqueued, false);
    assert.equal(rows[0]!.status, "pending");
  });
});
