import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// The service encrypts for real (that is worth exercising — it proves the stored
// value is not plaintext), and lib/security/encryption.ts reads this at call
// time. A fixed throwaway key keeps the suite independent of any .env file.
process.env.LLM_ENCRYPTION_KEY ??= "0".repeat(64);

import { setAnalyticsKey, type SetAnalyticsKeyDeps } from "./manage-analytics-key.service";
import type { SyncPostMetricsSummary } from "./sync-post-metrics.service";
import {
  AnalyticsKeyInvalidError,
  AnalyticsScopeError,
} from "@/lib/buffer/buffer-analytics-errors";
import { prisma } from "@/lib/db/client";

/**
 * Covers the save -> automatic-first-sync chain.
 *
 * The service talks to Prisma directly, so these tests stub the two
 * bufferConnection methods it uses. Everything else — key validation, the sync,
 * the audit log — comes in through SetAnalyticsKeyDeps.
 */

const COMPANY_ID = "company-1";
const VALID_KEY = "1/abcdefghijklmnopqrstuvwxyz";

interface Recorded {
  updateData: Record<string, unknown> | null;
  auditActions: string[];
  syncCalls: string[];
}

let recorded: Recorded;
let originalFindUnique: unknown;
let originalUpdate: unknown;

function summary(over: Partial<SyncPostMetricsSummary> = {}): SyncPostMetricsSummary {
  return {
    skipped: false,
    examined: 0,
    updated: 0,
    noData: 0,
    forbidden: 0,
    notFound: 0,
    failed: 0,
    ...over,
  };
}

/** Deps with everything succeeding; individual tests override what they exercise. */
function deps(over: SetAnalyticsKeyDeps = {}): SetAnalyticsKeyDeps {
  return {
    access: async () => ({ ok: true, companyId: COMPANY_ID }),
    validateKey: async () => ({ organizationId: "org-1", organizationName: "My Organization" }),
    syncMetrics: async (companyId) => {
      recorded.syncCalls.push(companyId);
      return summary({ examined: 6, updated: 6 });
    },
    auditLog: (async (input: { action: string }) => {
      recorded.auditActions.push(input.action);
    }) as SetAnalyticsKeyDeps["auditLog"],
    ...over,
  };
}

beforeEach(() => {
  recorded = { updateData: null, auditActions: [], syncCalls: [] };

  originalFindUnique = prisma.bufferConnection.findUnique;
  originalUpdate = prisma.bufferConnection.update;

  // A connected company by default — the precondition for configuring a key.
  (prisma.bufferConnection as unknown as Record<string, unknown>).findUnique = async () => ({
    id: "conn-1",
  });
  (prisma.bufferConnection as unknown as Record<string, unknown>).update = async (args: {
    data: Record<string, unknown>;
  }) => {
    recorded.updateData = args.data;
    return {
      analyticsKeyEnc: args.data.analyticsKeyEnc,
      analyticsKeyLast4: args.data.analyticsKeyLast4,
      analyticsKeyAddedAt: args.data.analyticsKeyAddedAt,
      analyticsKeyLastValidAt: args.data.analyticsKeyLastValidAt,
    };
  };
});

afterEach(() => {
  (prisma.bufferConnection as unknown as Record<string, unknown>).findUnique = originalFindUnique;
  (prisma.bufferConnection as unknown as Record<string, unknown>).update = originalUpdate;
});

describe("setAnalyticsKey — save then sync", () => {
  it("saves the key and reports a successful first sync", async () => {
    const result = await setAnalyticsKey("acme", VALID_KEY, "user-1", false, deps());

    assert.equal(result.success, true);
    if (!result.success) return;

    assert.equal(result.data.configured, true);
    assert.equal(result.data.organizationName, "My Organization");
    // Only the last 4 characters ever leave the service.
    assert.equal(result.data.last4, VALID_KEY.slice(-4));
    assert.equal(result.data.sync?.updated, 6);

    // The sync ran for the company that was just configured.
    assert.deepEqual(recorded.syncCalls, [COMPANY_ID]);
    assert.deepEqual(recorded.auditActions, ["ANALYTICS_KEY_SET"]);
  });

  it("never returns the raw key, and stores it encrypted", async () => {
    const result = await setAnalyticsKey("acme", VALID_KEY, "user-1", false, deps());
    assert.equal(result.success, true);

    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(VALID_KEY), false);

    // Encrypted at rest: the stored value is not the plaintext.
    assert.notEqual(recorded.updateData?.analyticsKeyEnc, VALID_KEY);
    assert.equal(typeof recorded.updateData?.analyticsKeyEnc, "string");
  });

  it("keeps the saved key when the sync returns no data", async () => {
    const result = await setAnalyticsKey(
      "acme",
      VALID_KEY,
      "user-1",
      false,
      // Buffer had the posts but reported nothing — it ingests once daily.
      deps({ syncMetrics: async () => summary({ examined: 4, noData: 4 }) })
    );

    assert.equal(result.success, true);
    if (!result.success) return;

    // Saving still succeeded; this is a "no metrics yet" outcome, not an error.
    assert.equal(result.data.configured, true);
    assert.equal(result.data.sync?.examined, 4);
    assert.equal(result.data.sync?.updated, 0);
    assert.equal(result.data.sync?.noData, 4);
    assert.deepEqual(recorded.auditActions, ["ANALYTICS_KEY_SET"]);
  });

  it("keeps the saved key when the sync throws", async () => {
    const result = await setAnalyticsKey(
      "acme",
      VALID_KEY,
      "user-1",
      false,
      deps({
        syncMetrics: async () => {
          throw new Error("Buffer unreachable");
        },
      })
    );

    // The whole point of requirement 4: a transient sync failure must not cost
    // the user a key that Buffer already accepted.
    assert.equal(result.success, true);
    if (!result.success) return;

    assert.equal(result.data.configured, true);
    assert.equal(result.data.last4, VALID_KEY.slice(-4));
    // null is the signal the UI turns into "saved, but not synced yet".
    assert.equal(result.data.sync, null);
    assert.ok(recorded.updateData?.analyticsKeyEnc);
  });

  it("reports a skipped sync without failing the save", async () => {
    const result = await setAnalyticsKey(
      "acme",
      VALID_KEY,
      "user-1",
      false,
      deps({ syncMetrics: async () => summary({ skipped: true, reason: "RATE_LIMITED" }) })
    );

    assert.equal(result.success, true);
    if (!result.success) return;
    assert.equal(result.data.configured, true);
    assert.equal(result.data.sync?.skipped, true);
    assert.equal(result.data.sync?.reason, "RATE_LIMITED");
  });
});

describe("setAnalyticsKey — invalid keys are never stored or synced", () => {
  it("rejects a key Buffer refuses, without writing or syncing", async () => {
    const result = await setAnalyticsKey(
      "acme",
      VALID_KEY,
      "user-1",
      false,
      deps({
        validateKey: async () => {
          throw new AnalyticsKeyInvalidError();
        },
      })
    );

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, "INVALID_KEY");

    // Nothing written, nothing synced, nothing logged.
    assert.equal(recorded.updateData, null);
    assert.deepEqual(recorded.syncCalls, []);
    assert.deepEqual(recorded.auditActions, []);
  });

  it("rejects a key that authenticates but cannot read insights", async () => {
    const result = await setAnalyticsKey(
      "acme",
      VALID_KEY,
      "user-1",
      false,
      deps({
        validateKey: async () => {
          throw new AnalyticsScopeError();
        },
      })
    );

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, "INSUFFICIENT_SCOPE");
    assert.equal(recorded.updateData, null);
    assert.deepEqual(recorded.syncCalls, []);
  });

  it("rejects obvious junk before calling Buffer at all", async () => {
    let validateCalled = false;
    const result = await setAnalyticsKey(
      "acme",
      "short",
      "user-1",
      false,
      deps({
        validateKey: async () => {
          validateCalled = true;
          return { organizationId: "o", organizationName: "n" };
        },
      })
    );

    assert.equal(result.success, false);
    assert.equal(validateCalled, false);
    assert.deepEqual(recorded.syncCalls, []);
  });

  it("does not sync when the caller lacks access", async () => {
    const result = await setAnalyticsKey(
      "acme",
      VALID_KEY,
      "user-1",
      false,
      deps({ access: async () => ({ ok: false, error: "FORBIDDEN" }) })
    );

    assert.equal(result.success, false);
    if (result.success) return;
    assert.equal(result.code, "FORBIDDEN");
    assert.deepEqual(recorded.syncCalls, []);
  });
});
