import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { enqueueJob, type JobInsert } from "./enqueue-job.service";

// ─── Helpers ────────────────────────────────────────────────────────────────

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: { target: "jobs_dedupe_active_key" },
  });
}

/**
 * In-memory job table that enforces the partial unique index the same way Postgres
 * does: at most one non-terminal row per dedupeKey. Lets a test replay overlapping
 * cron ticks and observe deduplication + release-after-terminal.
 */
function fakeJobTable() {
  const rows: Array<{ id: string; dedupeKey: string | null; terminal: boolean }> = [];
  let seq = 0;
  return {
    rows,
    complete: (id: string) => {
      const r = rows.find((x) => x.id === id);
      if (r) r.terminal = true;
    },
    insertJob: async (data: JobInsert): Promise<{ id: string }> => {
      if (
        data.dedupeKey !== null &&
        rows.some((r) => r.dedupeKey === data.dedupeKey && !r.terminal)
      ) {
        throw uniqueViolation();
      }
      const id = `job-${++seq}`;
      rows.push({ id, dedupeKey: data.dedupeKey, terminal: false });
      return { id };
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("enqueueJob", () => {
  it("inserts exactly one job with the given type + dedupeKey and defaults", async () => {
    const seen: JobInsert[] = [];
    const res = await enqueueJob(
      { type: "rss-ingestion", dedupeKey: "cron:rss-ingestion" },
      {
        insertJob: async (data) => {
          seen.push(data);
          return { id: "job-1" };
        },
      }
    );

    assert.equal(seen.length, 1);
    assert.equal(seen[0].type, "rss-ingestion");
    assert.equal(seen[0].dedupeKey, "cron:rss-ingestion");
    assert.deepEqual(seen[0].payload, {}); // defaulted
    assert.equal(seen[0].priority, 0);
    assert.equal(seen[0].maxAttempts, 5);
    assert.equal(seen[0].cronRunId, null);
    assert.deepEqual(res, { enqueued: true, deduplicated: false, jobId: "job-1" });
  });

  it("passes through explicit payload / priority / maxAttempts", async () => {
    let seen: JobInsert | undefined;
    await enqueueJob(
      { type: "t", payload: { a: 1 }, priority: 10, maxAttempts: 3 },
      { insertJob: async (d) => ((seen = d), { id: "x" }) }
    );
    assert.deepEqual(seen?.payload, { a: 1 });
    assert.equal(seen?.priority, 10);
    assert.equal(seen?.maxAttempts, 3);
  });

  it("treats a unique-violation (P2002) as deduplicated, not an error", async () => {
    const res = await enqueueJob(
      { type: "rss-ingestion", dedupeKey: "cron:rss-ingestion" },
      {
        insertJob: async () => {
          throw uniqueViolation();
        },
      }
    );
    assert.deepEqual(res, { enqueued: false, deduplicated: true, jobId: null });
  });

  it("rethrows errors that are not unique-constraint violations", async () => {
    await assert.rejects(
      () =>
        enqueueJob(
          { type: "t" },
          {
            insertJob: async () => {
              throw new Error("connection reset");
            },
          }
        ),
      /connection reset/
    );
  });

  it("repeated cron calls dedupe while active, then enqueue again after completion", async () => {
    const table = fakeJobTable();
    const deps = { insertJob: table.insertJob };
    const KEY = "cron:rss-ingestion";

    // Tick 1 — nothing active → enqueued.
    const first = await enqueueJob({ type: "rss-ingestion", dedupeKey: KEY }, deps);
    assert.deepEqual(first, { enqueued: true, deduplicated: false, jobId: "job-1" });

    // Tick 2 — job-1 still active → deduplicated, no second row.
    const second = await enqueueJob({ type: "rss-ingestion", dedupeKey: KEY }, deps);
    assert.deepEqual(second, { enqueued: false, deduplicated: true, jobId: null });
    assert.equal(table.rows.length, 1);

    // Worker finishes job-1 (terminal → leaves the partial unique index).
    table.complete("job-1");

    // Tick 3 — the guard released → a fresh job is enqueued.
    const third = await enqueueJob({ type: "rss-ingestion", dedupeKey: KEY }, deps);
    assert.deepEqual(third, { enqueued: true, deduplicated: false, jobId: "job-2" });
    assert.equal(table.rows.length, 2);
  });
});
