import { prisma } from "@/lib/db/client";
import { resolveItemPublicUrl } from "@/lib/ai/source-types";
import {
  classificationBucketOf,
  classificationFilterWhere,
  summarizeClassificationError,
  type FeedItemClassificationFilter,
} from "@/lib/posts/feed-item-classification-filter";

export interface FeedItemRow {
  id: string;
  sourceId: string;
  title: string | null;
  content: string | null;
  /**
   * The stored url — for a prompt or calendar source this is the internal
   * `prompt:<id>` / `event:<id>` key, so never render it. Use `publicUrl`.
   */
  url: string;
  /**
   * The page a reader could open: the item's own url for rss/product_page, the
   * source's Event URL for a calendar event, null when there is none. The panel
   * shows its "view original" link only when this is set.
   */
  publicUrl: string | null;
  publishedAt: string | null;
  enabled: boolean;
  createdAt: string;
  /** pending | completed | failed | skipped | null (v2-4). */
  translationStatus: string | null;
  translationLanguage: string | null;
  /** Populated only for a failed translation; shown as an error summary. */
  translationError: string | null;
  /** HIGH | MEDIUM | REJECTED | null — null is "no verdict", never "rejected". */
  classification: string | null;
  /** pending | classifying | completed | skipped | failed | null. */
  classificationStatus: string | null;
  /** BLACKLIST | OUT_OF_SCOPE — set only alongside a REJECTED classification. */
  classificationRejectionReason: string | null;
  /** The configured topics this article matched, in their stored spelling. */
  classificationMatchedTopics: string[];
  /** One capped sentence of evidence. Shown on demand, never in the row itself. */
  classificationReason: string | null;
  /** Why the last attempt broke. Only ever set alongside a `failed` status. */
  classificationError: string | null;
  /**
   * Whether a post has already been written from this article. Drives the "already
   * used" badge: such a row is never reclassified, so its `classificationStatus`
   * is frozen history and must not be read out as a queue position.
   */
  usedInPost: boolean;
}

/**
 * How many articles this source has in each filter bucket — over the WHOLE
 * source, not the returned page. That is what lets the pills show honest counts
 * while the list itself stays capped.
 */
export interface FeedItemClassificationCounts {
  all: number;
  high: number;
  medium: number;
  rejected: number;
  /** Queued or in flight, and still eligible — a verdict really is coming. */
  pending: number;
  /** The classifier could not be reached or could not be trusted. NOT rejected. */
  failed: number;
  /** No verdict and none coming: consumed, settled without one, or never asked. */
  unclassified: number;
}

export type ListFeedItemsResult =
  | { success: true; items: FeedItemRow[]; counts: FeedItemClassificationCounts }
  | { success: false; code: "NOT_FOUND" | "FORBIDDEN" };

async function resolveCompanyAndSource(
  slug: string,
  sourceId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<
  | { ok: true; companyId: string; sourceConfig: unknown }
  | { ok: false; code: "NOT_FOUND" | "FORBIDDEN" }
> {
  let companyId: string;

  if (isGlobalAdmin) {
    const company = await prisma.company.findUnique({ where: { slug }, select: { id: true } });
    if (!company) return { ok: false, code: "NOT_FOUND" };
    companyId = company.id;
  } else {
    const membership = await prisma.companyMember.findFirst({
      where: { company: { slug }, userId },
      select: { companyId: true },
    });
    if (!membership) return { ok: false, code: "NOT_FOUND" };
    companyId = membership.companyId;
  }

  const source = await prisma.contentSource.findFirst({
    where: { id: sourceId, companyId },
    select: { id: true, config: true },
  });
  if (!source) return { ok: false, code: "NOT_FOUND" };

  // Carried through for the same reason generation reads it: a calendar event's
  // optional Event URL lives here, because its items hold only `event:<id>`.
  return { ok: true, companyId, sourceConfig: source.config };
}

const ITEMS_LIMIT = 50;

/**
 * True when the company has at least one enabled feed item from an enabled
 * source — i.e. generation would be based on an RSS article (v2-1). Used to
 * decide whether the manual source-link override is shown.
 */
export async function hasEnabledFeedItems(companyId: string): Promise<boolean> {
  const item = await prisma.feedItem.findFirst({
    where: { companyId, enabled: true, source: { enabled: true } },
    select: { id: true },
  });
  return item !== null;
}

/** One `groupBy` row: a distinct combination and how many articles share it. */
export interface ClassificationCountGroup {
  classification: string | null;
  classificationStatus: string | null;
  usedInPost: boolean;
  count: number;
}

/**
 * Turn the grouped rows into pill counts. Pure, and exported so the arithmetic is
 * testable without a database.
 *
 * Every group goes through `classificationBucketOf` — the SAME function the badge
 * on the row uses — so a pill and the rows it reveals can never disagree about
 * what an article is. A bucket the vocabulary does not know cannot occur: the
 * function is total over the state union.
 */
export function tallyClassificationCounts(
  groups: readonly ClassificationCountGroup[]
): FeedItemClassificationCounts {
  const counts: FeedItemClassificationCounts = {
    all: 0,
    high: 0,
    medium: 0,
    rejected: 0,
    pending: 0,
    failed: 0,
    unclassified: 0,
  };

  for (const group of groups) {
    counts.all += group.count;
    counts[classificationBucketOf(group)] += group.count;
  }

  return counts;
}

/**
 * Bucket counts over the whole source.
 *
 * One `groupBy` rather than six counts, and taken WITHOUT the active filter so
 * every pill keeps showing its own total while one of them is selected — a
 * filter bar whose other counts collapse to zero as soon as you use it is
 * useless for deciding where to go next.
 *
 * Grouped by three columns instead of one because that is the smallest key that
 * separates the no-verdict cases from each other. The cardinality stays tiny —
 * 4 verdicts × 6 statuses × 2 — so this is still one cheap aggregate, not a scan.
 */
async function classificationCounts(sourceId: string): Promise<FeedItemClassificationCounts> {
  const groups = await prisma.feedItem.groupBy({
    by: ["classification", "classificationStatus", "usedInPost"],
    where: { sourceId },
    _count: { _all: true },
  });

  return tallyClassificationCounts(
    groups.map((g) => ({
      classification: g.classification,
      classificationStatus: g.classificationStatus,
      usedInPost: g.usedInPost,
      count: g._count._all,
    }))
  );
}

export async function listFeedItems(
  slug: string,
  sourceId: string,
  userId: string,
  isGlobalAdmin: boolean,
  /**
   * Applied in the DATABASE, not over the returned page. See the filter module:
   * the list is capped, so a client-side filter would answer a different
   * question from the one the user asked.
   */
  filter: FeedItemClassificationFilter = "all"
): Promise<ListFeedItemsResult> {
  const ctx = await resolveCompanyAndSource(slug, sourceId, userId, isGlobalAdmin);
  if (!ctx.ok) return { success: false, code: ctx.code };

  const [rows, counts] = await Promise.all([
    prisma.feedItem.findMany({
      where: { sourceId, ...classificationFilterWhere(filter) },
      orderBy: [{ publishedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      take: ITEMS_LIMIT,
      select: {
        id: true,
        sourceId: true,
        title: true,
        content: true,
        url: true,
        publishedAt: true,
        enabled: true,
        createdAt: true,
        translationStatus: true,
        translationLanguage: true,
        translationError: true,
        classification: true,
        classificationStatus: true,
        classificationRejectionReason: true,
        classificationMatchedTopics: true,
        classificationReason: true,
        classificationError: true,
        usedInPost: true,
      },
    }),
    classificationCounts(sourceId),
  ]);

  return {
    success: true,
    counts,
    items: rows.map((r) => ({
      id: r.id,
      sourceId: r.sourceId,
      // Always the ORIGINAL article text — the panel lists source material, not
      // the translation (v2-4).
      title: r.title,
      content: r.content,
      url: r.url,
      publicUrl: resolveItemPublicUrl(r.url, ctx.sourceConfig),
      publishedAt: r.publishedAt?.toISOString() ?? null,
      enabled: r.enabled,
      createdAt: r.createdAt.toISOString(),
      translationStatus: r.translationStatus,
      translationLanguage: r.translationLanguage,
      translationError: r.translationError,
      classification: r.classification,
      classificationStatus: r.classificationStatus,
      classificationRejectionReason: r.classificationRejectionReason,
      classificationMatchedTopics: r.classificationMatchedTopics,
      classificationReason: r.classificationReason,
      // Summarised here rather than in the browser so a provider's raw response
      // body never reaches the client at all.
      classificationError: summarizeClassificationError(r.classificationError),
      usedInPost: r.usedInPost,
    })),
  };
}
