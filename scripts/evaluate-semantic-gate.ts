/**
 * Read-only calibration report for the semantic-duplicate gate.
 *
 * Inspects the most recent recorded gate outcomes on `post_semantics` and prints
 * the observed similarity distribution plus the highest accepted similarities, so
 * the 0.80 / 0.86 thresholds can be tuned from real evidence. It NEVER changes a
 * threshold or writes anything — the output is statistics only.
 *
 * Usage:
 *   npm run semantic:evaluate            # latest 500 comparisons
 *   npm run semantic:evaluate -- 1000    # latest 1000 comparisons
 *
 * Requires DATABASE_URL.
 */

import "dotenv/config";
import { prisma } from "@/lib/db/client";
import {
  getSemanticGateReport,
  formatSemanticGateReport,
} from "@/lib/services/ai/semantic-gate-report.service";

function parseLimit(argv: string[]): number | undefined {
  const raw = argv.find((a) => /^\d+$/.test(a));
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function main() {
  const limit = parseLimit(process.argv.slice(2));
  const report = await getSemanticGateReport({ limit });
  console.log(formatSemanticGateReport(report));
}

main()
  .catch((err) => {
    console.error("\nEvaluation failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
