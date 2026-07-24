/**
 * Atomic per-feed-item translation claim (v2-9).
 *
 * Translation candidates are selected by status with no lock, so the scheduled
 * cron and a continuation job can pick the SAME item. Without a claim they both
 * call the LLM (wasted work, double attempt counts) and their writes race —
 * exactly the bug where a late failure clobbered a concurrent success.
 *
 * The fix is the same lock-free pattern feed-item-reservation.ts uses for post
 * generation: a single conditional `UPDATE ... WHERE <still-eligible>` transitions
 * the item into an in-flight state before the LLM call. Postgres guarantees at most
 * one concurrent transaction flips the row, so:
 *
 *   • count === 1 → this run owns the item and proceeds to translate;
 *   • count === 0 → another run owns it (or it advanced) → skip cleanly.
 *
 * Crash recovery: the claim stamps `translationLeaseExpiresAt`. A worker that dies
 * mid-translation leaves the row `translating` with a lease in the past; the lease
 * check below makes such a row claimable again, so nothing gets stuck. The lease is
 * far longer than a single translation call, so a still-running translation is never
 * reclaimed out from under itself.
 *
 * The functions take an injectable db and a fixed `now`, so they unit-test without a
 * live database (see feed-item-translation-claim.test.ts).
 */

import type { Prisma } from "@prisma/client";
import { MAX_TRANSLATION_ATTEMPTS } from "./feed-item-translation";

/**
 * How long a claim is held before it is considered abandoned. Must comfortably
 * exceed the longest single translation call (the text-worker's 300s timeout) so a
 * healthy in-flight translation is never reclaimed; a crashed one recovers after this.
 */
export const TRANSLATION_LEASE_MS = 10 * 60_000; // 10 minutes

/** Narrow db surface — real Prisma satisfies it; tests inject a fake. */
export interface TranslationClaimDb {
  feedItem: {
    updateMany: (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
  };
}

/**
 * The rows a cron run should SELECT as translatable right now:
 *   • pending/failed items whose backoff window has elapsed, OR
 *   • a crashed run's `translating` claim whose lease has expired (recovery).
 * A live claim (`translating` with a future lease) is deliberately excluded — it is
 * in progress and must not be re-selected. Callers add their own scoping
 * (`companyId`, enabled source) on top of this.
 */
export function translationSelectableWhere(now: Date): Prisma.FeedItemWhereInput {
  return {
    translationAttemptCount: { lt: MAX_TRANSLATION_ATTEMPTS },
    OR: [
      {
        translationStatus: { in: ["pending", "failed"] },
        OR: [{ translationNextRetryAt: null }, { translationNextRetryAt: { lte: now } }],
      },
      { translationStatus: "translating", translationLeaseExpiresAt: { lt: now } },
    ],
  };
}

export interface ClaimTranslationArgs {
  id: string;
  /** The hash of the input being translated — lets a stale `completed` row be reclaimed. */
  hash: string;
  targetLang: string;
  now: Date;
  leaseMs?: number;
}

export interface TranslationClaim {
  /** True when this run atomically won the item (count === 1). */
  claimed: boolean;
  /** The lease this run stamped — reused as a fencing token for the failure write. */
  leaseExpiresAt: Date;
}

/**
 * Atomically claims one feed item for translation.
 *
 * Eligibility (the WHERE) matches an item that is genuinely translatable now:
 * a retry-due pending/failed item, a stale `completed` row whose input changed
 * (different hash), or a crashed `translating` claim past its lease. The write
 * flips the row to `translating`, stamps the lease, records the input hash/language,
 * and counts the attempt — all in one statement, so the attempt is counted exactly
 * once per claim and only by the run that won.
 */
export async function claimFeedItemForTranslation(
  db: TranslationClaimDb,
  args: ClaimTranslationArgs
): Promise<TranslationClaim> {
  const leaseExpiresAt = new Date(args.now.getTime() + (args.leaseMs ?? TRANSLATION_LEASE_MS));

  const result = await db.feedItem.updateMany({
    where: {
      id: args.id,
      translationAttemptCount: { lt: MAX_TRANSLATION_ATTEMPTS },
      OR: [
        {
          translationStatus: { in: ["pending", "failed"] },
          OR: [{ translationNextRetryAt: null }, { translationNextRetryAt: { lte: args.now } }],
        },
        // A completed translation whose input (article text or target language) changed —
        // its stored hash no longer matches, so it is stale and re-translatable.
        { translationStatus: "completed", translationHash: { not: args.hash } },
        // A crashed run's claim whose lease elapsed.
        { translationStatus: "translating", translationLeaseExpiresAt: { lt: args.now } },
      ],
    },
    data: {
      translationStatus: "translating",
      translationHash: args.hash,
      translationLanguage: args.targetLang,
      translationLastAttemptAt: args.now,
      translationLeaseExpiresAt: leaseExpiresAt,
      translationAttemptCount: { increment: 1 },
    },
  });

  return { claimed: result.count === 1, leaseExpiresAt };
}
