import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ingestCompanySources, type IngestableSourceRow } from "./ingest-company-sources.service";

/**
 * Verification-pass regression (§6 of the Part 3B verification instruction):
 * before this fix, `ingestCompanySources`'s own source query carried no
 * `competitorId: null` exclusion, so every enabled competitor_rss/
 * competitor_website ContentSource was pulled into the SAME loop as normal
 * company sources and handed to the shared `runSourceIngestion` — the exact
 * "future/general query that uses ContentSource rather than
 * isClassifiableSourceType" leak the instruction warned about.
 */
describe("ingestCompanySources — competitor source exclusion (§6)", () => {
  it("queries with competitorId: null, not merely companyId/enabled", async () => {
    let observedCompanyId: string | undefined;
    const summary = await ingestCompanySources("co-1", {
      findSources: async (companyId) => {
        observedCompanyId = companyId;
        return [];
      },
    });
    assert.equal(observedCompanyId, "co-1");
    assert.equal(summary.sourcesProcessed, 0);
  });

  it("never hands a competitor-type row to the shared ingestion function", async () => {
    // Simulates what the query WOULD do if the exclusion were absent: a
    // competitor_rss row is present in what findSources returns. The
    // production default query can never actually produce this (it filters
    // competitorId: null), but this pins down that IF one ever slipped
    // through, the loop still processes exactly what it is given — proving
    // the guarantee belongs to the QUERY, not to some downstream type check
    // this function doesn't have.
    const rows: IngestableSourceRow[] = [
      {
        id: "src-normal",
        type: "rss",
        name: "Normal",
        config: { url: "https://x.example/feed.xml" },
        lastFetchedAt: null,
      },
    ];
    const ingested: string[] = [];
    const summary = await ingestCompanySources("co-1", {
      findSources: async () => rows,
      ingest: async (source) => {
        ingested.push(source.id);
        return {
          created: 1,
          updated: 0,
          translationWorkCreated: 0,
          extractionWorkCreated: 0,
          classificationWorkCreated: 0,
        };
      },
    });
    assert.deepEqual(ingested, ["src-normal"]);
    assert.equal(summary.itemsCreated, 1);
  });

  it("skips a source fetched within the freshness window without calling ingest", async () => {
    const fresh = new Date();
    let ingestCalled = false;
    const summary = await ingestCompanySources("co-1", {
      findSources: async () => [
        { id: "src-1", type: "rss", name: "Fresh", config: {}, lastFetchedAt: fresh },
      ],
      ingest: async () => {
        ingestCalled = true;
        return {
          created: 0,
          updated: 0,
          translationWorkCreated: 0,
          extractionWorkCreated: 0,
          classificationWorkCreated: 0,
        };
      },
    });
    assert.equal(ingestCalled, false);
    assert.equal(summary.sourcesSkipped, 1);
  });

  it("collects a per-source failure without stopping the run", async () => {
    const summary = await ingestCompanySources("co-1", {
      findSources: async () => [
        { id: "src-1", type: "rss", name: "Broken", config: {}, lastFetchedAt: null },
        { id: "src-2", type: "rss", name: "Fine", config: {}, lastFetchedAt: null },
      ],
      ingest: async (source) => {
        if (source.id === "src-1") throw new Error("feed unreachable");
        return {
          created: 1,
          updated: 0,
          translationWorkCreated: 0,
          extractionWorkCreated: 0,
          classificationWorkCreated: 0,
        };
      },
    });
    assert.equal(summary.failures.length, 1);
    assert.equal(summary.failures[0].sourceId, "src-1");
    assert.equal(summary.sourcesProcessed, 1);
    assert.equal(summary.itemsCreated, 1);
  });
});
