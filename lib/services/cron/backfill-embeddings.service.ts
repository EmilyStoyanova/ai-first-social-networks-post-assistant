import { prisma } from "@/lib/db/client";
import { Prisma, type SocialChannel } from "@prisma/client";
import {
  embedPost,
  type EmbedPostInput,
  type EmbedPostOutcome,
} from "@/lib/services/ai/embed-post.service";
import { getEmbeddingProviderInfo } from "@/lib/ai/embedding/embedding-provider-factory";

/**
 * Backfill embeddings for posts that have a coreMessage but no up-to-date
 * embedding (Phase 1.2). This is the durable path that also serves as the retry
 * mechanism for failures during live generation — there is no queue.
 *
 * A post is a candidate when it has a non-null coreMessage AND either has no
 * post_semantics row or a row whose status is not 'ready' (i.e. pending/failed).
 * Legacy posts with a null coreMessage are intentionally excluded — we never
 * fall back to embedding full content.
 */

export interface BackfillSummary {
  scanned: number;
  embedded: number;
  skipped: number;
  failed: number;
  reason?: "no_provider";
}

interface CandidateRow {
  id: string;
  company_id: string;
  channel: SocialChannel;
  core_message: string;
  created_at: Date;
}

export interface BackfillDeps {
  embed?: (input: EmbedPostInput) => Promise<EmbedPostOutcome>;
  findCandidates?: (companyId: string | undefined, limit: number) => Promise<CandidateRow[]>;
  /** Availability probe; defaults to the real factory info. */
  providerAvailable?: () => boolean;
}

async function defaultFindCandidates(
  companyId: string | undefined,
  limit: number
): Promise<CandidateRow[]> {
  return prisma.$queryRaw<CandidateRow[]>`
    SELECT p."id", p."company_id", p."channel"::text AS channel, p."core_message", p."created_at"
    FROM "posts" p
    LEFT JOIN "post_semantics" s ON s."post_id" = p."id"
    WHERE p."core_message" IS NOT NULL
      ${companyId ? Prisma.sql`AND p."company_id" = ${companyId}` : Prisma.empty}
      AND (s."post_id" IS NULL OR s."status" <> 'ready')
    ORDER BY p."created_at" DESC
    LIMIT ${limit};
  `;
}

/**
 * Embeds up to `limit` pending posts. Bounded per call so it fits inside a cron
 * run; the caller (cron or the backfill script) repeats to drain the queue.
 */
export async function backfillEmbeddings(
  opts: { companyId?: string; limit?: number } = {},
  deps: BackfillDeps = {}
): Promise<BackfillSummary> {
  const limit = opts.limit ?? 25;
  const embed = deps.embed ?? embedPost;
  const providerAvailable = deps.providerAvailable ?? (() => getEmbeddingProviderInfo() !== null);

  const summary: BackfillSummary = { scanned: 0, embedded: 0, skipped: 0, failed: 0 };

  if (!providerAvailable()) {
    summary.reason = "no_provider";
    return summary;
  }

  const findCandidates = deps.findCandidates ?? defaultFindCandidates;
  const candidates = await findCandidates(opts.companyId, limit);
  summary.scanned = candidates.length;

  for (const c of candidates) {
    const outcome = await embed({
      postId: c.id,
      companyId: c.company_id,
      channel: c.channel,
      coreMessage: c.core_message,
      postCreatedAt: c.created_at,
    });
    if (outcome.status === "embedded") summary.embedded += 1;
    else if (outcome.status === "failed") summary.failed += 1;
    else summary.skipped += 1;
  }

  return summary;
}
