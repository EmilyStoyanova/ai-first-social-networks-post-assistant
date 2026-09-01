import { prisma } from "@/lib/db/client";
import type { ContentSourceType } from "@prisma/client";
import { eligibleClassificationWhere } from "@/lib/ai/candidate-priority";

/**
 * Why a listed source cannot currently be picked.
 *
 *   • no_articles — an RSS feed with no article left that generation could draw:
 *                   every one is already used, switched off, or REJECTED by the
 *                   company's own topic rules. The feed itself is fine; it simply
 *                   has nothing worth writing about.
 *   • no_content  — a non-RSS source (product page / prompt / calendar) that has
 *                   never been extracted, or whose extraction is disabled.
 *
 * Null when the source is selectable. Two reasons rather than one flag because
 * the fix differs: "wait for new articles" vs "fetch this source".
 */
export type GenerationSourceUnavailableReason = "no_articles" | "no_content";

/**
 * A content source offered in the manual "Content source" dropdown.
 *
 * EVERY enabled source is returned, whatever its type — an RSS feed, a product
 * page, a prompt, a calendar event. A source that cannot currently back a post
 * is still returned: the dropdown shows it disabled rather than hiding it, so an
 * owner can see that the source exists and is merely dry or unfetched, instead
 * of wondering where it went.
 */
export interface GenerationSourceOption {
  id: string;
  name: string;
  /** Drives the disabled label, and is why RSS and the rest read differently. */
  type: ContentSourceType;
  /** False when the source cannot back a post right now — renders disabled. */
  available: boolean;
  /** Why it is unavailable; null when `available`. */
  unavailableReason: GenerationSourceUnavailableReason | null;
}

export type ListGenerationSourcesResult =
  { success: true; sources: GenerationSourceOption[] } | { success: false; code: "NOT_FOUND" };

// ─── Minimal DB interface for testability ─────────────────────────────────────
// Mirrors get-available-llms.service.ts: the real Prisma client satisfies this
// narrow shape, and unit tests inject a fake.

export interface GenerationSourcesDb {
  company: {
    findUnique: (args: {
      where: { slug: string };
      select: { id: true };
    }) => Promise<{ id: string } | null>;
  };
  companyMember: {
    findFirst: (args: {
      where: { company: { slug: string }; userId: string };
      select: { companyId: true };
    }) => Promise<{ companyId: string } | null>;
  };
  contentSource: {
    findMany: (args: {
      where: { companyId: string; enabled: true; competitorId: null };
      orderBy: { createdAt: "asc" };
      select: { id: true; name: true; type: true };
    }) => Promise<Array<{ id: string; name: string; type: ContentSourceType }>>;
  };
  feedItem: {
    findMany: (args: {
      // `usedInPost` is present only for the RSS window — the non-RSS window
      // deliberately omits it (see below). The `OR` is the classification
      // eligibility fragment, which both windows carry.
      where: {
        sourceId: { in: string[] };
        enabled: true;
        usedInPost?: false;
        OR?: Array<{ classification: string | null }>;
      };
      select: { sourceId: true };
      distinct: ["sourceId"];
    }) => Promise<Array<{ sourceId: string }>>;
  };
}

/**
 * Lists the enabled content sources a member may generate from, flagging which
 * ones can currently back a post.
 *
 * Availability is asked differently per kind, because the two generation paths
 * consume differently:
 *
 *   • RSS      — needs an UNUSED article, since generation reserves one and
 *                marks it used (one-post-per-article).
 *   • anything — needs any stored extraction at all. A product page, prompt, or
 *     else       calendar event is read directly and consumed by nothing, so a
 *                post already written from it leaves it just as available.
 *
 * Both additionally need an item generation would actually draw — i.e. one whose
 * classification is a tier the candidate window queries. REJECTED does not count
 * towards availability, in either window.
 *
 * Both predicates match the window the generation context builds for that kind
 * exactly — otherwise the dropdown would offer a source generation then refuses.
 * The company/source-enabled halves are already covered by `rows` below.
 *
 * Any member (owner or editor) or a global admin may read this — the same bar as
 * triggering generation itself.
 */
export async function listGenerationSourcesCore(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean,
  db: GenerationSourcesDb
): Promise<ListGenerationSourcesResult> {
  // RBAC — confirm the caller can see this company (mirrors getAvailableLlmsCore).
  let companyId: string;
  if (isGlobalAdmin) {
    const company = await db.company.findUnique({ where: { slug }, select: { id: true } });
    if (!company) return { success: false, code: "NOT_FOUND" };
    companyId = company.id;
  } else {
    const membership = await db.companyMember.findFirst({
      where: { company: { slug }, userId },
      select: { companyId: true },
    });
    if (!membership) return { success: false, code: "NOT_FOUND" };
    companyId = membership.companyId;
  }

  // A disabled source is switched off, not dry — it is left out entirely rather
  // than shown greyed out, which would imply content is all that is missing.
  //
  // competitorId: null — a competitor's ContentSource (Part 3B) is monitoring
  // input for Competitive Analysis, never a generation source; it must not
  // appear in the manual "Content source" picker (§3.8/§4).
  const rows = await db.contentSource.findMany({
    where: { companyId, enabled: true, competitorId: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, type: true },
  });
  if (rows.length === 0) return { success: true, sources: [] };

  const rssIds = rows.filter((r) => r.type === "rss").map((r) => r.id);
  const directIds = rows.filter((r) => r.type !== "rss").map((r) => r.id);

  // The classification gate, on BOTH windows because generation applies it to
  // both. A REJECTED article cannot back a post, so a feed holding nothing else
  // is dry — offering it here would produce a dropdown entry that looks fine and
  // then fails with SELECTED_SOURCE_UNAVAILABLE the moment it is picked. Today
  // only RSS items are ever classified, so the direct window's copy is a no-op;
  // it is there so the two can never fall out of step if that changes.
  const classificationGate = eligibleClassificationWhere();

  const [withArticles, withContent] = await Promise.all([
    rssIds.length > 0
      ? db.feedItem.findMany({
          where: {
            sourceId: { in: rssIds },
            enabled: true,
            usedInPost: false,
            ...classificationGate,
          },
          select: { sourceId: true },
          distinct: ["sourceId"],
        })
      : Promise.resolve([]),
    // No `usedInPost` filter: a direct content source is never consumed, so an
    // item already cited by a post still makes its source selectable.
    directIds.length > 0
      ? db.feedItem.findMany({
          where: { sourceId: { in: directIds }, enabled: true, ...classificationGate },
          select: { sourceId: true },
          distinct: ["sourceId"],
        })
      : Promise.resolve([]),
  ]);

  const available = new Set([...withArticles, ...withContent].map((r) => r.sourceId));

  return {
    success: true,
    sources: rows.map((r) => {
      const isAvailable = available.has(r.id);
      return {
        id: r.id,
        name: r.name,
        type: r.type,
        available: isAvailable,
        unavailableReason: isAvailable ? null : r.type === "rss" ? "no_articles" : "no_content",
      };
    }),
  };
}

// ─── Public API (uses real Prisma) ────────────────────────────────────────────

export async function listGenerationSources(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<ListGenerationSourcesResult> {
  return listGenerationSourcesCore(slug, userId, isGlobalAdmin, prisma);
}
