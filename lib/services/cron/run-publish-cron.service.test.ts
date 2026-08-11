import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { runPublishCron, SOFT_TIME_BUDGET_MS } from "./run-publish-cron.service";
import type { PublishCronCompany, PublishCronDeps } from "./run-publish-cron.service";
import type { PublishScheduledSummary } from "./publish-scheduled-posts.service";
import { PUBLISH_SWEEP_INTERVAL_MS } from "@/lib/scheduling/publish-window";

/**
 * What is under test here is the SWEEP: which companies it visits, in what order,
 * how it survives one of them failing, and — the part that matters most — that
 * running it repeatedly cannot publish anything twice.
 *
 * The per-company publisher is injected, so no Buffer connection or database is
 * involved; the publishing RULE itself is unchanged and covered by
 * publish-scheduled-posts.service.test.ts and publish-window.test.ts.
 */

const NOW = new Date("2026-08-20T07:00:00.000Z");

function company(slug: string): PublishCronCompany {
  return { id: `id-${slug}`, slug };
}

function published(n: number): PublishScheduledSummary {
  return { published: n, failed: 0, skipped: 0, pastDue: 0, failures: [] };
}

interface Harness {
  deps: PublishCronDeps;
  /** Company ids handed to the publisher, in order. */
  publishedFor: string[];
  finished: Array<Record<string, unknown>>;
  failed: Array<{ actions: Record<string, unknown>; error: string }>;
}

function harness(overrides: Partial<PublishCronDeps> = {}): Harness {
  const publishedFor: string[] = [];
  const finished: Array<Record<string, unknown>> = [];
  const failed: Array<{ actions: Record<string, unknown>; error: string }> = [];

  const deps: PublishCronDeps = {
    now: () => NOW,
    createRun: async () => ({ id: "run-1" }),
    finishRun: async (_id, actions) => {
      finished.push(actions);
    },
    failRun: async (_id, actions, error) => {
      failed.push({ actions, error });
    },
    selectCompanies: async () => [company("acme")],
    countCompaniesWithWork: async () => 1,
    publish: async (companyId) => {
      publishedFor.push(companyId);
      return published(1);
    },
    ...overrides,
  };

  return { deps, publishedFor, finished, failed };
}

describe("runPublishCron — visiting companies", () => {
  it("publishes for every selected company and totals the results", async () => {
    const h = harness({
      selectCompanies: async () => [company("a"), company("b"), company("c")],
      countCompaniesWithWork: async () => 3,
      publish: async (companyId) => {
        h.publishedFor.push(companyId);
        return { published: 2, failed: 1, skipped: 3, pastDue: 1, failures: [] };
      },
    });

    const s = await runPublishCron(h.deps);

    assert.equal(s.kind, "publish");
    assert.equal(s.status, "completed");
    assert.equal(s.examined, 3);
    assert.equal(s.processed, 3);
    assert.equal(s.published, 6);
    assert.equal(s.failedPosts, 3);
    assert.equal(s.skipped, 9);
    assert.equal(s.pastDue, 3);
    assert.deepEqual(h.publishedFor, ["id-a", "id-b", "id-c"]);
  });

  it("asks for the batch cap and visits companies in the order given", async () => {
    // Selection order is the fairness rule — most overdue first — and the sweep
    // must not reshuffle it, or the post that has waited longest goes last.
    let askedLimit: number | null = null;
    const h = harness({
      maxCompanies: 4,
      selectCompanies: async (limit) => {
        askedLimit = limit;
        return [company("oldest"), company("newer")];
      },
      countCompaniesWithWork: async () => 2,
    });

    await runPublishCron(h.deps);

    assert.equal(askedLimit, 4);
    assert.deepEqual(h.publishedFor, ["id-oldest", "id-newer"]);
  });

  it("does nothing at all when no company has work", async () => {
    const h = harness({
      selectCompanies: async () => [],
      countCompaniesWithWork: async () => 0,
    });

    const s = await runPublishCron(h.deps);

    assert.equal(s.examined, 0);
    assert.equal(s.published, 0);
    assert.equal(s.remaining, 0);
    assert.deepEqual(h.publishedFor, []);
    // An idle sweep still records its run: 48 ticks a day of silence is not the
    // same evidence as 48 ticks of "nothing was due".
    assert.equal(h.finished.length, 1);
  });

  it("reports companies it could not reach as remaining", async () => {
    // The undersizing signal: more companies have due posts than the cap allows,
    // so somebody's post is late for a reason nobody chose.
    const h = harness({
      maxCompanies: 2,
      selectCompanies: async () => [company("a"), company("b")],
      countCompaniesWithWork: async () => 7,
    });

    const s = await runPublishCron(h.deps);

    assert.equal(s.examined, 2);
    assert.equal(s.remaining, 5);
  });

  it("never reports a negative backlog when work appears mid-sweep", async () => {
    const h = harness({
      selectCompanies: async () => [company("a"), company("b")],
      countCompaniesWithWork: async () => 1,
    });

    const s = await runPublishCron(h.deps);

    assert.equal(s.remaining, 0);
  });
});

describe("runPublishCron — one company's failure is not everyone's", () => {
  it("continues the sweep after a company throws", async () => {
    // An expired Buffer token at one company must not hold up the posts of the
    // companies behind it in the batch.
    const h = harness({
      selectCompanies: async () => [company("a"), company("boom"), company("c")],
      countCompaniesWithWork: async () => 3,
      publish: async (companyId) => {
        h.publishedFor.push(companyId);
        if (companyId === "id-boom") throw new Error("token expired");
        return published(1);
      },
    });

    const s = await runPublishCron(h.deps);

    assert.equal(s.status, "completed");
    assert.equal(s.examined, 3);
    assert.equal(s.processed, 2);
    assert.equal(s.failed, 1);
    assert.equal(s.published, 2);
    assert.deepEqual(
      s.companyFailures.map((f) => f.slug),
      ["boom"]
    );
    assert.match(s.companyFailures[0].message, /token expired/);
  });

  it("records a completed run even when every company failed", async () => {
    const h = harness({
      publish: async () => {
        throw new Error("buffer down");
      },
    });

    const s = await runPublishCron(h.deps);

    // Completed, not failed: the sweep did its job — it found out that Buffer is
    // down. Failing the RUN would hand it to the queue's retry policy, which would
    // re-attempt delivery for every company, including any that had succeeded.
    assert.equal(s.status, "completed");
    assert.equal(s.failed, 1);
    assert.equal(h.finished.length, 1);
    assert.equal(h.failed.length, 0);
  });

  it("fails the run when selection itself throws", async () => {
    const h = harness({
      selectCompanies: async () => {
        throw new Error("database unavailable");
      },
    });

    const s = await runPublishCron(h.deps);

    assert.equal(s.status, "failed");
    assert.equal(s.error, "database unavailable");
    assert.equal(h.failed.length, 1);
    assert.equal(h.failed[0].error, "database unavailable");
  });
});

describe("runPublishCron — the time budget", () => {
  it("stops claiming companies once the budget is spent", async () => {
    let ms = NOW.getTime();
    const h = harness({
      timeBudgetMs: 1_000,
      selectCompanies: async () => [company("a"), company("b"), company("c")],
      countCompaniesWithWork: async () => 3,
      // Each company costs 600ms of the 1000ms budget.
      now: () => new Date(ms),
      publish: async (companyId) => {
        h.publishedFor.push(companyId);
        ms += 600;
        return published(1);
      },
    });

    const s = await runPublishCron(h.deps);

    assert.deepEqual(h.publishedFor, ["id-a", "id-b"]);
    assert.equal(s.timedOut, true);
    assert.equal(s.examined, 2);
    // The abandoned company is still counted as backlog, so the interruption is
    // visible in the diagnostics rather than only in the flag.
    assert.equal(s.remaining, 1);
  });

  it("finishes well inside one sweep interval, so no tick is ever dropped", () => {
    // A sweep that outlives its own interval still holds the dedupe key when the
    // next tick arrives, and that tick is silently discarded. The budget is what
    // keeps that from happening.
    assert.ok(
      SOFT_TIME_BUDGET_MS < PUBLISH_SWEEP_INTERVAL_MS,
      `budget ${SOFT_TIME_BUDGET_MS}ms must be under the ${PUBLISH_SWEEP_INTERVAL_MS}ms interval`
    );
  });
});

describe("the sweep is the only publisher", () => {
  // This is a structural test, and it exists because the invariant it guards cannot be
  // observed from any single module: `publishScheduledPosts` sends to Buffer and only
  // afterwards marks the post sent, with no per-post claim in between. One caller is
  // safe; two callers running at once deliver the same post twice. Unit tests cannot
  // catch a SECOND caller being added — only counting the callers can.
  const ROOT = path.resolve(process.cwd());
  const SOURCE_DIRS = ["app", "lib", "worker", "scripts"];
  /** The one legitimate caller: the sweep orchestrator. */
  const PUBLISHER = path.join("lib", "services", "cron", "run-publish-cron.service.ts");
  const DEFINITION = path.join("lib", "services", "cron", "publish-scheduled-posts.service.ts");

  function sourceFiles(): string[] {
    const found: string[] = [];
    for (const dir of SOURCE_DIRS) {
      const abs = path.join(ROOT, dir);
      if (!existsSync(abs)) continue;
      for (const entry of readdirSync(abs, { recursive: true, encoding: "utf8" })) {
        if (!/\.tsx?$/.test(entry) || entry.endsWith(".test.ts") || entry.endsWith(".test.tsx"))
          continue;
        found.push(path.join(dir, entry));
      }
    }
    return found;
  }

  it("scans a real source tree (so a wrong cwd fails loudly instead of passing vacuously)", () => {
    const files = sourceFiles();
    assert.ok(files.length > 100, `expected a full source tree, scanned ${files.length} files`);
    assert.ok(files.includes(DEFINITION), `did not find ${DEFINITION} — cwd is wrong`);
    assert.ok(files.includes(PUBLISHER), `did not find ${PUBLISHER} — cwd is wrong`);
  });

  it("has exactly one caller of publishScheduledPosts: the sweep orchestrator", () => {
    const callers = sourceFiles().filter((file) => {
      if (file === DEFINITION) return false; // where it is declared
      return /\bpublishScheduledPosts\s*\(/.test(readFileSync(path.join(ROOT, file), "utf8"));
    });

    assert.deepEqual(
      callers.sort(),
      [PUBLISHER],
      "publishScheduledPosts must be called only by runPublishCron. A second caller can " +
        "publish the same post concurrently with the sweep, and Buffer receives it twice. " +
        "Enqueue PUBLISH_SWEEP_JOB_TYPE instead of calling the publisher directly."
    );
  });

  it("keeps the deprecated combined cron on the enqueue path", () => {
    // The legacy /api/v1/internal/cron route used to publish inline at its step 5. It is
    // the one place most likely to regress, so it is asserted by name.
    const legacy = readFileSync(path.join(ROOT, "lib/services/cron/run-cron.service.ts"), "utf8");
    // The name may still appear in prose explaining WHY it is not called; the call and
    // the import are what must be gone.
    assert.ok(!/publishScheduledPosts\s*\(/.test(legacy), "run-cron must not publish inline");
    assert.ok(
      !/from\s+"\.\/publish-scheduled-posts\.service"/.test(legacy),
      "run-cron must not import the publisher"
    );
    assert.match(legacy, /PUBLISH_SWEEP_JOB_TYPE/);
    assert.match(legacy, /PUBLISH_SWEEP_DEDUPE_KEY/);
  });
});

describe("runPublishCron — idempotency", () => {
  it("publishes nothing on a second sweep once the posts are gone", async () => {
    // The real guarantee, modelled end to end: `scheduledFor` + `status` ARE the
    // state. A post that was sent is no longer `approved`, so it is not selected,
    // so it cannot be sent again — no per-tick bookkeeping is involved.
    const remaining = new Map([
      ["id-a", 2],
      ["id-b", 1],
    ]);

    const deps: PublishCronDeps = {
      now: () => NOW,
      createRun: async () => ({ id: "run" }),
      finishRun: async () => {},
      failRun: async () => {},
      selectCompanies: async () =>
        [...remaining.entries()].filter(([, due]) => due > 0).map(([id]) => ({ id, slug: id })),
      countCompaniesWithWork: async () => [...remaining.values()].filter((due) => due > 0).length,
      publish: async (companyId) => {
        const due = remaining.get(companyId) ?? 0;
        remaining.set(companyId, 0);
        return published(due);
      },
    };

    const first = await runPublishCron(deps);
    const second = await runPublishCron(deps);
    const third = await runPublishCron(deps);

    assert.equal(first.published, 3);
    assert.equal(second.published, 0);
    assert.equal(second.examined, 0);
    assert.equal(third.published, 0);
  });

  it("re-derives its work from scratch every run, holding no state between sweeps", async () => {
    // Two sweeps over an unchanged world must be identical. If a run kept a cursor,
    // the second would drift — and a drifting publisher either skips a post or
    // sends one twice.
    const h = harness({
      selectCompanies: async () => [company("a"), company("b")],
      countCompaniesWithWork: async () => 2,
    });

    const first = await runPublishCron(h.deps);
    const second = await runPublishCron(h.deps);

    assert.equal(first.examined, second.examined);
    assert.equal(first.published, second.published);
    assert.equal(first.remaining, second.remaining);
    assert.deepEqual(h.publishedFor, ["id-a", "id-b", "id-a", "id-b"]);
  });

  it("asks the publisher exactly once per company per sweep", async () => {
    // Belt and braces on the sweep's own loop: whatever else changes, one visit
    // per company per run is the invariant a duplicate delivery would break.
    const h = harness({
      selectCompanies: async () => [company("a"), company("b"), company("c")],
      countCompaniesWithWork: async () => 3,
    });

    await runPublishCron(h.deps);

    assert.deepEqual(h.publishedFor, ["id-a", "id-b", "id-c"]);
    assert.equal(new Set(h.publishedFor).size, h.publishedFor.length);
  });
});
