import { prisma } from "@/lib/db/client";
import { type SemanticDecision } from "@/lib/ai/quality/semantic-duplicate";
import {
  SEMANTIC_GRAY_ZONE_MIN,
  SEMANTIC_REGENERATE_MIN,
} from "@/lib/ai/quality/semantic-duplicate";

/**
 * Semantic-gate calibration report (evidence-gathering tooling).
 *
 * Reads the recorded gate outcomes on `post_semantics` and summarizes the
 * observed similarity distribution so the 0.80 / 0.86 thresholds can be tuned
 * from real data. This is READ-ONLY and descriptive: it never changes a
 * threshold or writes anything.
 *
 * The buckets here are intentionally FINER than
 * semantic-calibration.service's SimilarityBucket (they split 0.70-0.80 at the
 * 0.75 Jaccard line) — that service is left untouched to avoid behavior changes.
 */

// ─── Fine-grained buckets ─────────────────────────────────────────────────────

export type FineSimilarityBucket =
  "<0.60" | "0.60-0.70" | "0.70-0.75" | "0.75-0.80" | "0.80-0.86" | ">=0.86";

export const FINE_BUCKET_ORDER: readonly FineSimilarityBucket[] = [
  "<0.60",
  "0.60-0.70",
  "0.70-0.75",
  "0.75-0.80",
  "0.80-0.86",
  ">=0.86",
];

export function fineBucketFor(similarity: number): FineSimilarityBucket {
  if (similarity < 0.6) return "<0.60";
  if (similarity < 0.7) return "0.60-0.70";
  if (similarity < 0.75) return "0.70-0.75";
  if (similarity < 0.8) return "0.75-0.80";
  if (similarity < SEMANTIC_REGENERATE_MIN) return "0.80-0.86";
  return ">=0.86";
}

// ─── Records & report shape ───────────────────────────────────────────────────

/** One recorded gate outcome joined with the candidate + matched post text. */
export interface GateComparisonRecord {
  decision: SemanticDecision;
  /** Cosine similarity to the closest neighbor; null when skipped / no history. */
  topSimilarity: number | null;
  topic: string | null;
  coreMessage: string | null;
  matchedTopic: string | null;
  matchedCoreMessage: string | null;
}

/** A single high-similarity accepted comparison, for the top-N table. */
export interface AcceptedSample {
  similarity: number;
  topic: string | null;
  coreMessage: string | null;
  matchedTopic: string | null;
  matchedCoreMessage: string | null;
}

export interface SemanticGateReport {
  /** Records fetched, of any decision (including skipped / no-history). */
  totalRecords: number;
  /** Records that actually compared against a neighbor (non-null similarity). */
  totalComparisons: number;
  averageSimilarity: number | null;
  maxSimilarity: number | null;
  buckets: Record<FineSimilarityBucket, number>;
  /** Highest-similarity accepted comparisons, descending (capped at TOP_ACCEPTED_LIMIT). */
  topAccepted: AcceptedSample[];
}

export const TOP_ACCEPTED_LIMIT = 20;

/**
 * Pure summarization — no DB. Similarity stats and buckets consider only records
 * with a non-null topSimilarity (skipped gates / empty-history accepts have none).
 */
export function buildSemanticGateReport(
  records: GateComparisonRecord[],
  topLimit = TOP_ACCEPTED_LIMIT
): SemanticGateReport {
  const buckets: Record<FineSimilarityBucket, number> = {
    "<0.60": 0,
    "0.60-0.70": 0,
    "0.70-0.75": 0,
    "0.75-0.80": 0,
    "0.80-0.86": 0,
    ">=0.86": 0,
  };

  let sum = 0;
  let count = 0;
  let max: number | null = null;
  const accepted: AcceptedSample[] = [];

  for (const r of records) {
    if (r.topSimilarity === null) continue;
    sum += r.topSimilarity;
    count += 1;
    max = max === null ? r.topSimilarity : Math.max(max, r.topSimilarity);
    buckets[fineBucketFor(r.topSimilarity)] += 1;

    if (r.decision === "accept") {
      accepted.push({
        similarity: r.topSimilarity,
        topic: r.topic,
        coreMessage: r.coreMessage,
        matchedTopic: r.matchedTopic,
        matchedCoreMessage: r.matchedCoreMessage,
      });
    }
  }

  accepted.sort((a, b) => b.similarity - a.similarity);

  return {
    totalRecords: records.length,
    totalComparisons: count,
    averageSimilarity: count > 0 ? sum / count : null,
    maxSimilarity: max,
    buckets,
    topAccepted: accepted.slice(0, topLimit),
  };
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function pct(part: number, whole: number): string {
  if (whole === 0) return "0.0%";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function fmtSim(n: number | null): string {
  return n === null ? "n/a" : n.toFixed(4);
}

function truncate(text: string | null, max = 100): string {
  if (!text) return "(none)";
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/**
 * Renders the report as plain text. The "Statistics" section frames observations
 * against the current thresholds as counts only — it never recommends or applies
 * a change.
 */
export function formatSemanticGateReport(report: SemanticGateReport): string {
  const lines: string[] = [];
  const c = report.totalComparisons;

  lines.push("Semantic Gate Calibration Report");
  lines.push("================================");
  lines.push("");
  lines.push(`Records inspected:  ${report.totalRecords}`);
  lines.push(`Total comparisons:  ${c}   (records with a neighbor to compare)`);
  lines.push(`Average similarity: ${fmtSim(report.averageSimilarity)}`);
  lines.push(`Max similarity:     ${fmtSim(report.maxSimilarity)}`);
  lines.push("");

  lines.push("Similarity distribution:");
  for (const bucket of FINE_BUCKET_ORDER) {
    const n = report.buckets[bucket];
    lines.push(`  ${bucket.padEnd(11)}: ${String(n).padStart(5)}  (${pct(n, c)})`);
  }
  lines.push("");

  lines.push(
    `Top ${TOP_ACCEPTED_LIMIT} accepted similarities (decision=accept, closest to the gray zone):`
  );
  if (report.topAccepted.length === 0) {
    lines.push("  (none)");
  } else {
    report.topAccepted.forEach((s, i) => {
      const rank = String(i + 1).padStart(2);
      lines.push(`  ${rank}. ${s.similarity.toFixed(3)}`);
      lines.push(`      topic:   ${truncate(s.topic)}`);
      lines.push(`      core:    ${truncate(s.coreMessage)}`);
      lines.push(`      matched topic: ${truncate(s.matchedTopic)}`);
      lines.push(`      matched core:  ${truncate(s.matchedCoreMessage)}`);
    });
  }
  lines.push("");

  // Descriptive statistics only — thresholds are NOT changed by this tool.
  const grayZone = report.buckets["0.80-0.86"];
  const regenerate = report.buckets[">=0.86"];
  const approaching = report.buckets["0.75-0.80"];
  lines.push("Statistics (no thresholds changed):");
  lines.push(
    `  Current thresholds: gray zone ≥ ${SEMANTIC_GRAY_ZONE_MIN}, regenerate ≥ ${SEMANTIC_REGENERATE_MIN} (unchanged)`
  );
  lines.push(
    `  Accepted, approaching gray zone (0.75-0.80): ${approaching}  (${pct(approaching, c)})`
  );
  lines.push(`  Gray-zone comparisons (0.80-0.86):           ${grayZone}  (${pct(grayZone, c)})`);
  lines.push(
    `  Regenerate comparisons (>=0.86):             ${regenerate}  (${pct(regenerate, c)})`
  );
  lines.push("");
  lines.push("  These are observations only. Review the distribution and the top accepted");
  lines.push("  samples above before adjusting any threshold by hand.");

  return lines.join("\n");
}

// ─── DB read model ────────────────────────────────────────────────────────────

export interface GateReportFilter {
  /** Cap the number of most-recent records considered. Defaults to 500. */
  limit?: number;
}

export interface GateReportDeps {
  fetch?: (filter: GateReportFilter) => Promise<GateComparisonRecord[]>;
}

interface ReportRow {
  decision: string;
  top_similarity: number | null;
  topic: string | null;
  core_message: string | null;
  matched_topic: string | null;
  matched_core_message: string | null;
}

async function fetchGateComparisons(filter: GateReportFilter): Promise<GateComparisonRecord[]> {
  const limit = filter.limit ?? 500;
  const rows = await prisma.$queryRaw<ReportRow[]>`
    SELECT s."gate_decision"                     AS decision,
           s."gate_top_similarity"               AS top_similarity,
           p."prompt_snapshot"->>'topic'         AS topic,
           p."core_message"                      AS core_message,
           mp."prompt_snapshot"->>'topic'        AS matched_topic,
           mp."core_message"                     AS matched_core_message
    FROM "post_semantics" s
    JOIN "posts" p ON p."id" = s."post_id"
    LEFT JOIN "posts" mp ON mp."id" = s."gate_matched_post_id"
    WHERE s."gate_decision" IS NOT NULL
    ORDER BY s."gate_evaluated_at" DESC NULLS LAST
    LIMIT ${limit};
  `;

  return rows.map((r) => ({
    decision: (r.decision as SemanticDecision) ?? "accept",
    topSimilarity: r.top_similarity,
    topic: r.topic,
    coreMessage: r.core_message,
    matchedTopic: r.matched_topic,
    matchedCoreMessage: r.matched_core_message,
  }));
}

/**
 * Fetches recent gate comparisons and builds the report. The fetch is injectable
 * so the summary can be unit-tested without a database.
 */
export async function getSemanticGateReport(
  filter: GateReportFilter = {},
  deps: GateReportDeps = {}
): Promise<SemanticGateReport> {
  const fetch = deps.fetch ?? fetchGateComparisons;
  const records = await fetch(filter);
  return buildSemanticGateReport(records);
}
