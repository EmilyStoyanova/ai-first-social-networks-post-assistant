import { prisma } from "@/lib/db/client";

/**
 * The article-level facts a post's trace records, and the runs that hold their
 * full detail.
 *
 * ── Why this is a reference rather than a copy ──────────────────────────────
 *
 * Translation, classification and product-page extraction happen to a FEED ITEM,
 * once, long before any post exists — and one article can then back a post on
 * three channels. Copying the translation's prompts, its raw model reply and the
 * whole translated article into each of those posts' traces would store the same
 * immutable artifact three times, for one article, and again for the next post
 * written from the next article.
 *
 * So the artifact is stored ONCE, in its own run (`GenerationRun.feedItemId`,
 * kind translation/classification/extraction), and a post's step points at it
 * with `linkedRunId`. Historical accuracy is not weakened by that: the linked run
 * is itself an immutable snapshot, so a later re-translation writes a NEW run and
 * the old post keeps pointing at the old one.
 *
 * What IS copied into the post's own step is the small, decisive part — the
 * verdict, the provider, the status, and an excerpt — so the timeline is readable
 * without following the link, and so a post whose article predates tracing still
 * shows what it was built from.
 *
 * ── Everything here is best-effort ──────────────────────────────────────────
 *
 * Every function returns null/empty on any failure and never throws. These are
 * extra reads on the generation path; a trace that cannot be enriched is worth
 * far less than a generation that fails.
 */

export interface FeedItemArtifacts {
  /** Translation state as it stood when the post was generated. */
  translation: {
    status: string | null;
    language: string | null;
    provider: string | null;
    model: string | null;
    translatedAt: Date | null;
    error: string | null;
    titleChars: number | null;
    contentChars: number | null;
  } | null;
  /** Topic verdict as it stood when the post was generated. */
  classification: {
    status: string | null;
    classification: string | null;
    rejectionReason: string | null;
    matchedTopics: string[];
    primaryTopic: string | null;
    mainSubject: string | null;
    reason: string | null;
    provider: string | null;
    model: string | null;
    classifiedAt: Date | null;
    error: string | null;
  } | null;
  /** Product-page extraction state as it stood when the post was generated. */
  extraction: {
    status: string | null;
    extractedAt: Date | null;
    error: string | null;
    rawChars: number | null;
    extractedChars: number | null;
  } | null;
  /** The runs holding the full prompts/responses, when they were traced. */
  runIds: { translation: string | null; classification: string | null; extraction: string | null };
}

export interface FeedItemArtifactsDb {
  feedItem: {
    findUnique: (args: {
      where: { id: string };
      select: Record<string, true>;
    }) => Promise<Record<string, unknown> | null>;
  };
  generationRun: {
    findMany: (args: {
      where: Record<string, unknown>;
      orderBy: { startedAt: "desc" };
      select: { id: true; kind: true };
      distinct: ["kind"];
    }) => Promise<Array<{ id: string; kind: string }>>;
  };
}

const FEED_ITEM_SELECT = {
  title: true,
  content: true,
  translationStatus: true,
  translationLanguage: true,
  translationProvider: true,
  translationModel: true,
  translatedAt: true,
  translationError: true,
  translatedTitle: true,
  translatedContent: true,
  classificationStatus: true,
  classification: true,
  classificationRejectionReason: true,
  classificationMatchedTopics: true,
  classificationPrimaryTopic: true,
  classificationMainSubject: true,
  classificationReason: true,
  classificationProvider: true,
  classificationModel: true,
  classifiedAt: true,
  classificationError: true,
  extractionStatus: true,
  extractedContent: true,
  extractedAt: true,
  extractionError: true,
} as const;

function str(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function date(row: Record<string, unknown>, key: string): Date | null {
  const value = row[key];
  return value instanceof Date ? value : null;
}

function len(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  return typeof value === "string" ? value.length : null;
}

/**
 * Reads a feed item's translation/classification/extraction state, plus the ids
 * of the runs that recorded them.
 *
 * `null` for a missing item, a failed read, or tracing being unable to reach the
 * database at all — every caller treats that as "record no article-level steps".
 */
export async function loadFeedItemArtifacts(
  feedItemId: string,
  db: FeedItemArtifactsDb = prisma as unknown as FeedItemArtifactsDb
): Promise<FeedItemArtifacts | null> {
  try {
    const [row, runs] = await Promise.all([
      db.feedItem.findUnique({ where: { id: feedItemId }, select: { ...FEED_ITEM_SELECT } }),
      db.generationRun
        .findMany({
          where: {
            feedItemId,
            kind: { in: ["translation", "classification", "extraction"] },
            status: "completed",
          },
          orderBy: { startedAt: "desc" },
          select: { id: true, kind: true },
          distinct: ["kind"],
        })
        // A failed run lookup must not cost us the state snapshot beside it.
        .catch(() => [] as Array<{ id: string; kind: string }>),
    ]);
    if (!row) return null;

    const runIdOf = (kind: string) => runs.find((r) => r.kind === kind)?.id ?? null;

    const translationStatus = str(row, "translationStatus");
    const classificationStatus = str(row, "classificationStatus");
    const extractionStatus = str(row, "extractionStatus");

    return {
      translation: translationStatus
        ? {
            status: translationStatus,
            language: str(row, "translationLanguage"),
            provider: str(row, "translationProvider"),
            model: str(row, "translationModel"),
            translatedAt: date(row, "translatedAt"),
            error: str(row, "translationError"),
            titleChars: len(row, "translatedTitle"),
            contentChars: len(row, "translatedContent"),
          }
        : null,
      classification: classificationStatus
        ? {
            status: classificationStatus,
            classification: str(row, "classification"),
            rejectionReason: str(row, "classificationRejectionReason"),
            matchedTopics: Array.isArray(row.classificationMatchedTopics)
              ? (row.classificationMatchedTopics as string[])
              : [],
            primaryTopic: str(row, "classificationPrimaryTopic"),
            mainSubject: str(row, "classificationMainSubject"),
            reason: str(row, "classificationReason"),
            provider: str(row, "classificationProvider"),
            model: str(row, "classificationModel"),
            classifiedAt: date(row, "classifiedAt"),
            error: str(row, "classificationError"),
          }
        : null,
      extraction: extractionStatus
        ? {
            status: extractionStatus,
            extractedAt: date(row, "extractedAt"),
            error: str(row, "extractionError"),
            rawChars: len(row, "content"),
            extractedChars: len(row, "extractedContent"),
          }
        : null,
      runIds: {
        translation: runIdOf("translation"),
        classification: runIdOf("classification"),
        extraction: runIdOf("extraction"),
      },
    };
  } catch (err) {
    console.error(
      `[generation-trace] Could not read article artifacts for feed item ${feedItemId} ` +
        `(the trace will omit its translation/classification detail):`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

export interface CandidateFacts {
  id: string;
  classification: string | null;
  primaryTopic: string | null;
  reason: string | null;
  usedInPost: boolean;
  enabled: boolean;
}

export interface CandidateFactsDb {
  feedItem: {
    findMany: (args: {
      where: { id: { in: string[] } };
      select: {
        id: true;
        classification: true;
        classificationPrimaryTopic: true;
        classificationReason: true;
        usedInPost: true;
        enabled: true;
      };
    }) => Promise<
      Array<{
        id: string;
        classification: string | null;
        classificationPrimaryTopic: string | null;
        classificationReason: string | null;
        usedInPost: boolean;
        enabled: boolean;
      }>
    >;
  };
}

/**
 * Eligibility and priority for the articles a generation actually considered.
 *
 * The generation context carries the candidates' text but not their verdicts —
 * the verdict orders the window and is deliberately never an input to the prompt
 * (see build-generation-context.service.ts). A trace has to answer "why this
 * article and not that one", so it reads them back here, in one indexed query,
 * only for the ids already in hand.
 */
export async function loadCandidateFacts(
  ids: readonly string[],
  db: CandidateFactsDb = prisma as unknown as CandidateFactsDb
): Promise<CandidateFacts[]> {
  if (ids.length === 0) return [];
  try {
    const rows = await db.feedItem.findMany({
      where: { id: { in: [...ids] } },
      select: {
        id: true,
        classification: true,
        classificationPrimaryTopic: true,
        classificationReason: true,
        usedInPost: true,
        enabled: true,
      },
    });
    return rows.map((row) => ({
      id: row.id,
      classification: row.classification,
      primaryTopic: row.classificationPrimaryTopic,
      reason: row.classificationReason,
      usedInPost: row.usedInPost,
      enabled: row.enabled,
    }));
  } catch (err) {
    console.error(
      "[generation-trace] Could not read candidate eligibility " +
        "(the trace will omit per-candidate priority):",
      err instanceof Error ? err.message : err
    );
    return [];
  }
}
