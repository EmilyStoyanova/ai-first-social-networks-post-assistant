import { Prisma, type SocialChannel } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { type SemanticDecision } from "@/lib/ai/quality/semantic-duplicate";

/**
 * Semantic-gate calibration diagnostics (Phase 1.5).
 *
 * Two responsibilities, both against the `post_semantics` table:
 *   1. recordSemanticCalibration — best-effort write of the gate outcome for a
 *      generated post (topSimilarity, matchedPostId, decision, attempts,
 *      gateSkipped, evaluatedAt). Runs independently of embedding so even a
 *      skipped gate leaves a calibration record.
 *   2. getSemanticCalibrationSummary — a small read model summarizing the
 *      recorded outcomes for tuning the (still-unchanged) 0.80 / 0.86 thresholds.
 *
 * The gate columns live on post_semantics, NOT on Post — a queryable home that
 * avoids duplicating derived diagnostics on the hot posts row.
 */

// ─── Recording ──────────────────────────────────────────────────────────────

export interface SemanticCalibrationInput {
  postId: string;
  companyId: string;
  channel: SocialChannel;
  postCreatedAt: Date;
  /** Cosine similarity to the closest neighbor; null when no history / skipped. */
  topSimilarity: number | null;
  matchedPostId: string | null;
  decision: SemanticDecision;
  /** Number of generation attempts made (1..MAX_GENERATION_ATTEMPTS). */
  attempts: number;
  /** True when the gate could not run (fail-open). */
  gateSkipped: boolean;
  evaluatedAt: Date;
}

export interface SemanticCalibrationStore {
  record(input: SemanticCalibrationInput): Promise<void>;
}

const prismaCalibrationStore: SemanticCalibrationStore = {
  async record(input) {
    // Upsert only the gate_* columns. On insert the row is 'pending' with no
    // embedding; the embed path (embed-post.service) will set it 'ready' later.
    // On conflict we touch ONLY the gate columns so we never clobber embedding
    // state written by either path, regardless of ordering.
    await prisma.$executeRaw`
      INSERT INTO "post_semantics" (
        "post_id",
        "gate_top_similarity", "gate_matched_post_id", "gate_decision",
        "gate_attempts", "gate_skipped", "gate_evaluated_at",
        "company_id", "channel", "post_created_at", "created_at", "updated_at"
      ) VALUES (
        ${input.postId},
        ${input.topSimilarity}, ${input.matchedPostId}, ${input.decision},
        ${input.attempts}, ${input.gateSkipped}, ${input.evaluatedAt},
        ${input.companyId}, ${input.channel}::"SocialChannel", ${input.postCreatedAt}, now(), now()
      )
      ON CONFLICT ("post_id") DO UPDATE SET
        "gate_top_similarity"  = EXCLUDED."gate_top_similarity",
        "gate_matched_post_id" = EXCLUDED."gate_matched_post_id",
        "gate_decision"        = EXCLUDED."gate_decision",
        "gate_attempts"        = EXCLUDED."gate_attempts",
        "gate_skipped"         = EXCLUDED."gate_skipped",
        "gate_evaluated_at"    = EXCLUDED."gate_evaluated_at",
        "updated_at"           = now();
    `;
  },
};

export interface RecordSemanticCalibrationDeps {
  store?: SemanticCalibrationStore;
}

/**
 * Best-effort: never throws. A calibration write must never fail or delay post
 * generation, so any error is swallowed (the diagnostic is simply lost).
 */
export async function recordSemanticCalibration(
  input: SemanticCalibrationInput,
  deps: RecordSemanticCalibrationDeps = {}
): Promise<void> {
  const store = deps.store ?? prismaCalibrationStore;
  try {
    await store.record(input);
  } catch (err) {
    console.error(
      `[semantic-calibration] Failed to record for post ${input.postId} (non-fatal):`,
      err instanceof Error ? err.message : err
    );
  }
}

// ─── Reporting ──────────────────────────────────────────────────────────────

/** One recorded gate outcome, as read back for summarization. */
export interface SemanticCalibrationRecord {
  decision: SemanticDecision;
  topSimilarity: number | null;
  attempts: number;
  gateSkipped: boolean;
}

export type SimilarityBucket = "<0.60" | "0.60-0.70" | "0.70-0.80" | "0.80-0.86" | ">=0.86";

export interface SemanticCalibrationSummary {
  total: number;
  /** Count of records per gate decision. */
  byDecision: Record<SemanticDecision, number>;
  /** Mean / max of the non-null similarities; null when none are present. */
  averageSimilarity: number | null;
  maxSimilarity: number | null;
  /** Distribution of non-null similarities across fixed buckets. */
  buckets: Record<SimilarityBucket, number>;
  /** Fraction of records that needed more than one generation attempt (0..1). */
  retryRate: number;
  /** Fraction of records where the gate was skipped / fail-open (0..1). */
  skippedGateRate: number;
}

function bucketFor(similarity: number): SimilarityBucket {
  if (similarity < 0.6) return "<0.60";
  if (similarity < 0.7) return "0.60-0.70";
  if (similarity < 0.8) return "0.70-0.80";
  if (similarity < 0.86) return "0.80-0.86";
  return ">=0.86";
}

/**
 * Pure summarization of calibration records — no DB. Similarity stats and
 * buckets consider only records with a non-null topSimilarity (skipped gates
 * and empty-history accepts have none). Rates are over the full record set.
 */
export function summarizeCalibration(
  records: SemanticCalibrationRecord[]
): SemanticCalibrationSummary {
  const byDecision: Record<SemanticDecision, number> = {
    accept: 0,
    gray_zone: 0,
    regenerate: 0,
  };
  const buckets: Record<SimilarityBucket, number> = {
    "<0.60": 0,
    "0.60-0.70": 0,
    "0.70-0.80": 0,
    "0.80-0.86": 0,
    ">=0.86": 0,
  };

  let similaritySum = 0;
  let similarityCount = 0;
  let maxSimilarity: number | null = null;
  let retried = 0;
  let skipped = 0;

  for (const r of records) {
    byDecision[r.decision] = (byDecision[r.decision] ?? 0) + 1;
    if (r.attempts > 1) retried += 1;
    if (r.gateSkipped) skipped += 1;
    if (r.topSimilarity !== null) {
      similaritySum += r.topSimilarity;
      similarityCount += 1;
      maxSimilarity =
        maxSimilarity === null ? r.topSimilarity : Math.max(maxSimilarity, r.topSimilarity);
      buckets[bucketFor(r.topSimilarity)] += 1;
    }
  }

  const total = records.length;
  return {
    total,
    byDecision,
    averageSimilarity: similarityCount > 0 ? similaritySum / similarityCount : null,
    maxSimilarity,
    buckets,
    retryRate: total > 0 ? retried / total : 0,
    skippedGateRate: total > 0 ? skipped / total : 0,
  };
}

export interface CalibrationReportFilter {
  companyId?: string;
  channel?: SocialChannel;
  /** Cap the number of most-recent records considered. Defaults to 500. */
  limit?: number;
}

export interface CalibrationReportDeps {
  fetch?: (filter: CalibrationReportFilter) => Promise<SemanticCalibrationRecord[]>;
}

interface CalibrationRow {
  decision: string;
  top_similarity: number | null;
  attempts: number | null;
  gate_skipped: boolean | null;
}

async function fetchCalibrationRecords(
  filter: CalibrationReportFilter
): Promise<SemanticCalibrationRecord[]> {
  const limit = filter.limit ?? 500;
  const conditions: Prisma.Sql[] = [Prisma.sql`"gate_decision" IS NOT NULL`];
  if (filter.companyId) conditions.push(Prisma.sql`"company_id" = ${filter.companyId}`);
  if (filter.channel) conditions.push(Prisma.sql`"channel" = ${filter.channel}::"SocialChannel"`);
  const where = Prisma.join(conditions, " AND ");

  const rows = await prisma.$queryRaw<CalibrationRow[]>`
    SELECT "gate_decision"       AS decision,
           "gate_top_similarity" AS top_similarity,
           "gate_attempts"       AS attempts,
           "gate_skipped"        AS gate_skipped
    FROM "post_semantics"
    WHERE ${where}
    ORDER BY "gate_evaluated_at" DESC NULLS LAST
    LIMIT ${limit};
  `;

  return rows.map((r) => ({
    decision: (r.decision as SemanticDecision) ?? "accept",
    topSimilarity: r.top_similarity,
    attempts: r.attempts ?? 1,
    gateSkipped: r.gate_skipped ?? false,
  }));
}

/**
 * Fetches recent calibration records (optionally scoped to a company/channel)
 * and summarizes them. The fetch is injectable so the summary can be unit-tested
 * without a database.
 */
export async function getSemanticCalibrationSummary(
  filter: CalibrationReportFilter = {},
  deps: CalibrationReportDeps = {}
): Promise<SemanticCalibrationSummary> {
  const fetch = deps.fetch ?? fetchCalibrationRecords;
  const records = await fetch(filter);
  return summarizeCalibration(records);
}
