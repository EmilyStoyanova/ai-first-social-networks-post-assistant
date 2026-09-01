import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Structural regression test for the Part 3A hard boundary (§7): no code path
 * fetches a `CompetitorSocialProfile.url`, a `Competitor.website`, or any
 * other competitor-supplied address. Scoped to the SERVICE layer
 * (`lib/services/competitive-analysis/`), not the UI layer — client
 * components legitimately call `fetch()` against this app's OWN API routes
 * (e.g. `competitors-panel.tsx` POSTing to `/api/v1/.../competitors`), which
 * is a different fact from fetching a competitor's own external URL.
 *
 * Asserting the literal absence of `fetch(`/`http.get`/`https.get` in this
 * directory is a coarse but honest proxy: today, EVERY competitive-analysis
 * service is pure CRUD against Prisma, so the assertion is trivially true —
 * and it will fail loudly the moment Part 3B/3C adds a real network call here
 * without updating this test, which is the point.
 */
const SERVICE_DIR = join(__dirname);

function serviceSourceFiles(): string[] {
  return readdirSync(SERVICE_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
}

describe("no-social-fetch (Part 3A hard boundary)", () => {
  it("no competitive-analysis service performs an outbound fetch of any kind", () => {
    const offenders: string[] = [];
    for (const file of serviceSourceFiles()) {
      const src = readFileSync(join(SERVICE_DIR, file), "utf8");
      if (/\bfetch\s*\(|\bhttps?\.get\s*\(|\baxios\b/.test(src)) {
        offenders.push(file);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("sanity check: the scan actually inspected the CRUD services (not an empty/misconfigured glob)", () => {
    const files = serviceSourceFiles();
    assert.ok(files.includes("create-competitor.service.ts"));
    assert.ok(files.includes("update-competitor.service.ts"));
    assert.ok(files.length >= 10);
  });
});
