import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Structural regression test for the hard boundary that survives Part 3A into
 * Part 3B (§21/§25.9): no code path fetches a `CompetitorSocialProfile.url`, a
 * `CompetitorManualEntry.url`, a `Competitor.website`, or any other
 * competitor-SUPPLIED reference address. Scoped to the SERVICE layer
 * (`lib/services/competitive-analysis/`), not the UI layer — client
 * components legitimately call `fetch()` against this app's OWN API routes,
 * which is a different fact from fetching a competitor's own external URL.
 *
 * Part 3B adds exactly ONE legitimate exception:
 * `ingest-competitor-source.service.ts` fetches the competitor RSS FEED URL an
 * owner explicitly configured on a `ContentSource` row — the same kind of
 * address the normal RSS pipeline has always fetched, and the whole point of
 * "ingest a competitor RSS feed" (§3). That file is carved out of the blanket
 * scan below, by name, so the exception is visible and singular rather than a
 * silently loosened regex; every OTHER file in this directory — including
 * `create-manual-entry.service.ts` and the competitor social-profile
 * services — still has none.
 */
const SERVICE_DIR = join(__dirname);

/** The one file allowed to perform an outbound fetch, and why. */
const FETCH_EXCEPTIONS = new Set(["ingest-competitor-source.service.ts"]);

function serviceSourceFiles(): string[] {
  return readdirSync(SERVICE_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
}

function performsOutboundFetch(src: string): boolean {
  return /\bfetch\s*\(|\bhttps?\.get\s*\(|\baxios\b/.test(src);
}

describe("no-social-fetch (Part 3A/3B hard boundary)", () => {
  it("no competitive-analysis service outside the RSS-ingestion exception performs an outbound fetch", () => {
    const offenders: string[] = [];
    for (const file of serviceSourceFiles()) {
      if (FETCH_EXCEPTIONS.has(file)) continue;
      const src = readFileSync(join(SERVICE_DIR, file), "utf8");
      if (performsOutboundFetch(src)) offenders.push(file);
    }
    assert.deepEqual(offenders, []);
  });

  it("specifically: manual competitor content import never fetches the supplied URL", () => {
    const src = readFileSync(join(SERVICE_DIR, "create-manual-entry.service.ts"), "utf8");
    assert.equal(performsOutboundFetch(src), false);
    assert.doesNotMatch(src, /extractArticle|parseFeed/);
  });

  it("specifically: competitor CRUD never fetches a social profile or website URL", () => {
    for (const file of ["create-competitor.service.ts", "update-competitor.service.ts"]) {
      const src = readFileSync(join(SERVICE_DIR, file), "utf8");
      assert.equal(performsOutboundFetch(src), false, file);
      assert.doesNotMatch(src, /extractArticle|parseFeed/, file);
    }
  });

  it("the RSS-ingestion exception is real, not merely declared", () => {
    // Confirms the carve-out corresponds to an actual, intentional network
    // call (delegated to the shared RSS integration layer) — not a stale
    // exception nobody exercises any more.
    const src = readFileSync(join(SERVICE_DIR, "ingest-competitor-source.service.ts"), "utf8");
    assert.match(src, /parseFeed/);
    assert.match(src, /extractArticle/);
  });

  it("sanity check: the scan actually inspected the CRUD services (not an empty/misconfigured glob)", () => {
    const files = serviceSourceFiles();
    assert.ok(files.includes("create-competitor.service.ts"));
    assert.ok(files.includes("update-competitor.service.ts"));
    assert.ok(files.includes("create-manual-entry.service.ts"));
    assert.ok(files.length >= 10);
  });
});
