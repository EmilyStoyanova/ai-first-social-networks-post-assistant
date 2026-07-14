/**
 * One-off backfill of semantic embeddings for all posts that have a coreMessage
 * but no up-to-date embedding (Phase 1.2). Idempotent: already-embedded posts are
 * skipped via the coreMessage hash, so it is safe to re-run.
 *
 * Usage:
 *   npm run backfill:embeddings
 *   AI_MOCK_MODE=true npm run backfill:embeddings   # offline dry-run with mock vectors
 *
 * Requires an active embedding provider (EMBEDDING_PROVIDER=worker once
 * implemented, or EMBEDDING_PROVIDER=mock / AI_MOCK_MODE=true), plus DATABASE_URL.
 */

import "dotenv/config";
import { prisma } from "@/lib/db/client";
import { backfillEmbeddings } from "@/lib/services/cron/backfill-embeddings.service";
import { getEmbeddingProviderInfo } from "@/lib/ai/embedding/embedding-provider-factory";

const BATCH_SIZE = 50;

async function main() {
  const info = getEmbeddingProviderInfo();
  if (!info) {
    console.error(
      "No embedding provider configured. Set EMBEDDING_PROVIDER=worker (once implemented), EMBEDDING_PROVIDER=mock, or AI_MOCK_MODE=true."
    );
    process.exit(1);
  }

  console.log(`Backfilling embeddings with ${info.provider}/${info.model} (${info.dims} dims)…\n`);

  const total = { scanned: 0, embedded: 0, skipped: 0, failed: 0 };
  let batch = 0;

  for (;;) {
    batch += 1;
    const s = await backfillEmbeddings({ limit: BATCH_SIZE });
    total.scanned += s.scanned;
    total.embedded += s.embedded;
    total.skipped += s.skipped;
    total.failed += s.failed;

    console.log(
      `  batch ${batch}: scanned=${s.scanned} embedded=${s.embedded} skipped=${s.skipped} failed=${s.failed}`
    );

    // Stop when the queue is drained, or when a batch makes no forward progress
    // (only permanently-failing or unchanged rows remain) to avoid looping.
    if (s.scanned === 0 || s.embedded === 0) break;
  }

  console.log(
    `\nDone. scanned=${total.scanned} embedded=${total.embedded} skipped=${total.skipped} failed=${total.failed}`
  );
}

main()
  .catch((err) => {
    console.error("\nBackfill failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
