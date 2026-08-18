import { prisma } from "@/lib/db/client";
import type { GenerationContext } from "@/lib/ai/types";
import {
  CONSUMABLE_SOURCE_TYPES,
  isConsumableSourceType,
  resolveItemPublicUrl,
} from "@/lib/ai/source-types";
import { resolveFeedItemContent } from "@/lib/ai/feed-item-translation";
import {
  countOffered,
  describePrioritySelection,
  emptyPriorityDiagnostic,
  orderByPriority,
  priorityTierWheres,
  type PriorityDiagnostic,
} from "@/lib/ai/candidate-priority";

const VALID_CHANNELS = ["facebook", "linkedin", "instagram", "tiktok"] as const;
type ValidChannel = (typeof VALID_CHANNELS)[number];

const CHANNEL_DEFAULTS: Record<ValidChannel, { postingLanguage: string; imageRequired: boolean }> =
  {
    facebook: { postingLanguage: "en", imageRequired: true },
    linkedin: { postingLanguage: "en", imageRequired: false },
    instagram: { postingLanguage: "en", imageRequired: true },
    tiktok: { postingLanguage: "en", imageRequired: true },
  };

/** Reads ContentSource.config.includeSourceLink; undefined when unset or not a boolean. */
function extractSourceLinkPreference(config: unknown): boolean | undefined {
  if (config === null || typeof config !== "object") return undefined;
  const value = (config as Record<string, unknown>).includeSourceLink;
  return typeof value === "boolean" ? value : undefined;
}

export type BuildGenerationContextResult =
  | {
      success: true;
      context: GenerationContext;
      companyId: string;
      /**
       * How priority shaped this window. Carried on the result rather than on the
       * context because it explains how the context was chosen, not what it
       * contains. Nothing downstream branches on it; it is logged.
       *
       * Absent only for a window that drew from no articles at all (a
       * company-content slot), where there is nothing for it to describe.
       */
      priority?: PriorityDiagnostic;
    }
  | {
      success: false;
      // NO_ACTIVE_PROVIDER is kept for backward compatibility with existing route handlers
      // but is no longer returned by this function (provider info comes from env vars).
      code: "NOT_FOUND" | "FORBIDDEN" | "INVALID_CHANNEL" | "NO_ACTIVE_PROVIDER";
    };

/**
 * Which sources a generation may draw from (v2-8).
 *
 *   • pooled          — every enabled source, newest articles first. The
 *                       pre-v2-8 behaviour, and still what unconfigured
 *                       companies and the manual flow's default choice use.
 *   • source          — exactly one content source, because a content-mix quota
 *                       for it is due, or a manual generation picked it.
 *                       Nothing else may leak into the context. The window keeps
 *                       the one-post-per-article filter, so a post drawn here
 *                       reserves and consumes an unused article.
 *   • content_source  — exactly one NON-RSS source (product page, prompt,
 *                       calendar), read directly from what ingestion stored for
 *                       it. Same single-source window as `source` but WITHOUT
 *                       the `usedInPost` filter: a product page's extraction is
 *                       the page as it stands, not a one-shot article, so it
 *                       stays available after the first post is written from it.
 *   • company_content — no sources at all, forcing the mission/brand post path.
 *
 * A discriminated union rather than a nullable sourceId: "no source" and "any
 * source" are opposites here, and null/undefined would not keep them apart.
 */
export type SourceScope =
  | { kind: "pooled" }
  | { kind: "source"; sourceId: string }
  | { kind: "content_source"; sourceId: string }
  | { kind: "company_content" }
  /**
   * Exactly ONE named feed item, with the `usedInPost` filter dropped — the
   * sibling-channel window for multi-channel generation.
   *
   * The item is used, by definition: the first channel of this content group
   * claimed it when the topic was decided. Keeping the filter here would hide
   * the article from every sibling and the group would silently fragment into
   * three different topics, which is the exact failure multi-channel generation
   * exists to avoid. Nothing is claimed from this window (see planPinnedFeedItem).
   */
  | { kind: "feed_item"; feedItemId: string };

const POOLED: SourceScope = { kind: "pooled" };

/**
 * System-level context builder — no RBAC. Used by the cron dispatcher, where
 * there is no acting user; user-facing callers go through
 * buildGenerationContext below.
 *
 * The two differ ONLY in how they establish the company and whether a user is
 * allowed to ask. Both hand off to the same `loadContext`, which is what makes
 * the candidate rules — eligibility, priority order, the REJECTED exclusion —
 * impossible to have in one flow and not the other.
 */
export async function buildGenerationContextForCompany(
  companyId: string,
  rawChannel: string,
  scope: SourceScope = POOLED
): Promise<BuildGenerationContextResult> {
  const channel = rawChannel.toLowerCase() as ValidChannel;
  if (!VALID_CHANNELS.includes(channel)) {
    return { success: false, code: "INVALID_CHANNEL" };
  }

  const companyRow = await prisma.company.findUnique({
    where: { id: companyId },
    select: { id: true, name: true, website: true, automationMode: true, defaultLang: true },
  });
  if (!companyRow) return { success: false, code: "NOT_FOUND" };

  return loadContext(companyId, channel, companyRow, scope);
}

export async function buildGenerationContext(
  slug: string,
  rawChannel: string,
  userId: string,
  isGlobalAdmin: boolean,
  /** Manual "Content source" choice; defaults to the pooled (pre-existing) behaviour. */
  scope: SourceScope = POOLED
): Promise<BuildGenerationContextResult> {
  // Normalise channel
  const channel = rawChannel.toLowerCase() as ValidChannel;
  if (!VALID_CHANNELS.includes(channel)) {
    return { success: false, code: "INVALID_CHANNEL" };
  }

  // ── RBAC ──────────────────────────────────────────────────────────────────
  let companyId: string;
  let companyRow: {
    id: string;
    name: string;
    website: string | null;
    automationMode: string;
    defaultLang: string;
  };

  if (isGlobalAdmin) {
    const company = await prisma.company.findUnique({
      where: { slug },
      select: { id: true, name: true, website: true, automationMode: true, defaultLang: true },
    });
    if (!company) return { success: false, code: "NOT_FOUND" };
    companyId = company.id;
    companyRow = company;
  } else {
    const membership = await prisma.companyMember.findFirst({
      where: { company: { slug }, userId },
      select: {
        role: true,
        companyId: true,
        company: {
          select: { id: true, name: true, website: true, automationMode: true, defaultLang: true },
        },
      },
    });
    if (!membership) return { success: false, code: "NOT_FOUND" };
    // Both owner and editor can trigger generation
    if (membership.role !== "owner" && membership.role !== "editor") {
      return { success: false, code: "FORBIDDEN" };
    }
    companyId = membership.companyId;
    companyRow = membership.company;
  }

  return loadContext(companyId, channel, companyRow, scope);
}

/** The candidate window's shape and order — one definition, both query paths. */
const CANDIDATE_ORDER_BY = [
  { publishedAt: { sort: "desc", nulls: "last" } },
  { createdAt: "desc" },
] as const;

const CANDIDATE_TAKE = 5;

const CANDIDATE_SELECT = {
  id: true,
  title: true,
  content: true,
  url: true,
  publishedAt: true,
  sourceImageUrl: true,
  // v2-4 — translated text is preferred over the original only when the
  // translation completed; see resolveFeedItemContent below.
  translatedTitle: true,
  translatedContent: true,
  translationStatus: true,
  // The product-page extraction result. Read here, with the row, so the prompt
  // builder and aspect mining see the same authoritative text rather than each
  // re-deriving it from the raw page.
  extractedContent: true,
  extractionStatus: true,
  // The topic verdict — read only to ORDER this window and to explain the
  // ordering afterwards. It is never an input to the prompt.
  classification: true,
  // `name` rides along on a join that already exists — it and `type` are frozen
  // into the post's origin snapshot at generation time.
  source: { select: { name: true, type: true, config: true } },
} as const;

function fetchCandidates(where: Record<string, unknown>, take: number) {
  return prisma.feedItem.findMany({
    where,
    orderBy: [...CANDIDATE_ORDER_BY],
    take,
    select: CANDIDATE_SELECT,
  });
}

/**
 * How the tiered window reads its rows. Injectable so the tier composition and
 * the merge can be exercised against actual rows in a test — a `where` asserted
 * by SHAPE proves nothing about which articles come back.
 */
export type CandidateFinder<T> = (where: Record<string, unknown>, take: number) => Promise<T[]>;

/**
 * THE candidate window. Every generation in the product — cron, bulk, the manual
 * form, the prompt preview — gets its articles from this one function, and there
 * is no parameter that makes it behave differently for any of them.
 *
 * One query per tier rather than a sort over a recency-limited page, and that is
 * the correctness point: taking the newest five and THEN sorting would never see
 * a HIGH article older than five newer MEDIUM ones. Each tier is asked for the
 * full window, and the merge takes the first `take` in tier order — so HIGH is
 * genuinely exhausted before MEDIUM is drawn on, and MEDIUM before unclassified.
 *
 * REJECTED is excluded by construction: it is simply never one of the tiers
 * queried. That is stronger than a `NOT` filter, which a later edit could weaken
 * without noticing.
 *
 * The final `orderByPriority` is belt-and-braces — the tiers already arrive in
 * rank order — and costs nothing. It is what keeps the guarantee true if the
 * merge above is ever changed.
 */
export async function fetchGenerationCandidates<T extends { classification?: string | null }>(
  where: Record<string, unknown>,
  take: number,
  find: CandidateFinder<T>
): Promise<T[]> {
  // The tier list and its composition rule live in candidate-priority.ts, so the
  // "REJECTED is never queried" guarantee is one testable definition rather than
  // three literals here. The unclassified tier is the backwards-compatibility
  // one: for a company with no topics every row lands there and the order is
  // exactly what it was before this feature existed.
  const tiers = await Promise.all(priorityTierWheres(where).map((tier) => find(tier.where, take)));
  return orderByPriority(tiers.flat().slice(0, take));
}

/**
 * The eligibility filter — every rule that decides whether an article MAY be
 * used, for a given scope. Priority never adds to it or subtracts from it; it
 * only orders what comes out.
 *
 * Exported alongside the fetch so a test can compose the two exactly as
 * `loadContext` does, per scope, instead of trusting that they match.
 */
export function candidateWhereFor(companyId: string, scope: SourceScope): Record<string, unknown> {
  // A manually picked non-RSS source is read DIRECTLY from its stored extraction:
  // the window drops the one-post-per-article filter and generation reserves
  // nothing (see planDirectContentSource).
  const directContentSource = scope.kind === "content_source";

  // A sibling channel's window: one named item, already consumed by this topic's
  // first channel, so the `usedInPost` filter must not apply to it either.
  const pinnedFeedItemId = scope.kind === "feed_item" ? scope.feedItemId : null;

  // Both single-source scopes restrict the window to their one source; they
  // differ only in whether used items still count (see directContentSource).
  const scopedSourceId =
    scope.kind === "source" || scope.kind === "content_source" ? scope.sourceId : null;

  return {
    companyId,
    // Manual enable/disable. Authoritative over any verdict: a person who
    // switched an article off has overruled the classifier, whatever it decided.
    enabled: true,
    // usedInPost:false — one-post-per-article. DROPPED for a direct content
    // source: its stored extraction describes a page/prompt/event that does not
    // stop existing once a post cites it, and ingestion writes only one row per
    // such source, so keeping the filter would make the source selectable exactly
    // once and dry forever after.
    //
    // Also dropped for a pinned item, for the opposite reason: it IS used — this
    // topic's first channel claimed it — and the sibling channels of that same
    // topic must still be able to see it.
    ...(directContentSource || pinnedFeedItemId ? {} : { usedInPost: false }),
    source: { enabled: true },
    // One named item, and nothing else, for a sibling channel version. Note this
    // narrows the window; it does not exempt it. A pinned item still has to be a
    // tier the fetch queries, so a REJECTED article cannot re-enter generation
    // through the content-group door.
    ...(pinnedFeedItemId ? { id: pinnedFeedItemId } : {}),
    // v2-8 — when a specific source's quota is due, the window is restricted to
    // that source so a post can only ever consume the quota it was drawn against.
    // Without this the pooled window could hand RSS B's article to RSS A's slot,
    // silently reassigning the quota. A manual pick of either kind narrows the
    // window the same way.
    ...(scopedSourceId ? { sourceId: scopedSourceId } : {}),
  };
}

/**
 * Whether "why was no HIGH article offered?" is even a question worth the three
 * counts it costs.
 *
 * Only the two scopes that draw an OPEN window from articles can answer it. A
 * pinned sibling names its one item outright, a direct content source reads a
 * page rather than a feed, and a company-content slot has no articles at all —
 * for those, a withheld-HIGH tally would be a number about a population the run
 * never consulted.
 */
function explainsWithheldHigh(scope: SourceScope): boolean {
  return scope.kind === "pooled" || scope.kind === "source";
}

/**
 * Why no HIGH article was offered, when the company has some.
 *
 * Computed only in that case — if HIGH was offered there is nothing to explain —
 * so a company generating from its top tier pays nothing for this.
 */
async function explainMissingHigh(
  companyId: string,
  scopedSourceId: string | null
): Promise<PriorityDiagnostic["withheldHigh"]> {
  const scoped = scopedSourceId ? { sourceId: scopedSourceId } : {};
  const [used, disabled, sourceDisabled] = await Promise.all([
    prisma.feedItem.count({
      where: { companyId, classification: "HIGH", enabled: true, usedInPost: true, ...scoped },
    }),
    prisma.feedItem.count({
      where: { companyId, classification: "HIGH", enabled: false, ...scoped },
    }),
    prisma.feedItem.count({
      where: { companyId, classification: "HIGH", source: { enabled: false }, ...scoped },
    }),
  ]);
  return { used, disabled, sourceDisabled };
}

async function loadContext(
  companyId: string,
  channel: ValidChannel,
  companyRow: {
    name: string;
    website: string | null;
    automationMode: string;
    defaultLang: string;
  },
  scope: SourceScope = POOLED
): Promise<BuildGenerationContextResult> {
  // v2-8 — a company-content slot must produce a mission/brand post, so it gets
  // an empty article window AND no article sources. That combination is exactly
  // what makes planFeedItemUsage choose "mission", so the existing decision tree
  // handles the new quota with no special case of its own.
  const companyContentOnly = scope.kind === "company_content";

  // A manually picked non-RSS source is read DIRECTLY from its stored
  // extraction; generation reserves nothing (see planDirectContentSource).
  // Flagged on the context so the single fact travels with the data it describes.
  const directContentSource = scope.kind === "content_source";

  const scopedSourceId =
    scope.kind === "source" || scope.kind === "content_source" ? scope.sourceId : null;

  const candidateWhere = candidateWhereFor(companyId, scope);

  // ── Parallel data load ────────────────────────────────────────────────────
  const [brand, channelConfig, feedItems, enabledSource] = await Promise.allSettled([
    prisma.brandGuidelines.findUnique({
      where: { companyId },
      select: {
        companyDescription: true,
        toneOfVoice: true,
        targetAudience: true,
        forbiddenWords: true,
        competitors: true,
        primaryColor: true,
        secondaryColor: true,
      },
    }),
    prisma.channelConfig.findFirst({
      where: { companyId, channel },
      select: {
        postingLanguage: true,
        imageRequired: true,
        automationModeOverride: true,
        maxTextLength: true,
        includeSourceLink: true,
        autoGenerateImage: true,
      },
    }),
    // A company-content slot draws from no source at all — skip the query.
    // Otherwise: one-post-per-article and every other eligibility rule live in
    // `candidateWhere` above, and the window is drawn in priority order (HIGH,
    // then MEDIUM, then unclassified) with REJECTED never queried. No branch
    // here on who asked — that is the point.
    companyContentOnly
      ? Promise.resolve([])
      : fetchGenerationCandidates(candidateWhere, CANDIDATE_TAKE, fetchCandidates),
    // Does the company have an ARTICLE source (rss/product_page) configured at
    // all? Such a source with every article already used yields an empty
    // article window but must NOT fall back to a mission post — the caller skips
    // instead (Phase 0). Evergreen prompt/calendar sources are excluded here on
    // purpose: they never force a skip.
    //
    // v2-8 — scoped to the one source when its quota is due, so "are there
    // articles left" is asked about that source alone; and forced to "no" for a
    // company-content slot, which is the mission path by definition.
    companyContentOnly
      ? Promise.resolve(null)
      : prisma.contentSource.findFirst({
          where: {
            companyId,
            enabled: true,
            type: { in: [...CONSUMABLE_SOURCE_TYPES] },
            ...(scopedSourceId ? { id: scopedSourceId } : {}),
          },
          select: { id: true },
        }),
  ]);

  const brandData = brand.status === "fulfilled" ? brand.value : null;
  const channelConfigData = channelConfig.status === "fulfilled" ? channelConfig.value : null;
  const feedData = feedItems.status === "fulfilled" ? feedItems.value : [];

  // Why this window looks the way it does — assembled for every run that drew
  // from articles at all, so a manual generation is as explicable as a cron one.
  // The counts are free (the rows are already in hand); the expensive half is
  // taken only when there is genuinely something to explain.
  let priority: PriorityDiagnostic | undefined;
  if (!companyContentOnly) {
    priority = emptyPriorityDiagnostic();
    priority.offered = countOffered(feedData);
    if (priority.offered.high === 0 && explainsWithheldHigh(scope)) {
      priority.withheldHigh = await explainMissingHigh(companyId, scopedSourceId);
    }
    console.info("[generation] candidate priority", {
      companyId,
      channel,
      scope: scope.kind,
      summary: describePrioritySelection(priority),
      ...priority.offered,
      withheldHigh: priority.withheldHigh,
    });
  }
  // On a query failure, err toward the mission-post path (false) rather than
  // wrongly skipping generation; feedData already reflects claimable articles.
  const hasArticleSources = enabledSource.status === "fulfilled" && enabledSource.value !== null;
  const defaults = CHANNEL_DEFAULTS[channel];

  const context: GenerationContext = {
    company: {
      name: companyRow.name,
      website: companyRow.website,
      automationMode: companyRow.automationMode,
      defaultLang: companyRow.defaultLang,
    },
    brand: brandData
      ? {
          companyDescription: brandData.companyDescription,
          toneOfVoice: brandData.toneOfVoice,
          targetAudience: brandData.targetAudience,
          forbiddenWords: brandData.forbiddenWords,
          competitors: brandData.competitors,
          primaryColor: brandData.primaryColor,
          secondaryColor: brandData.secondaryColor,
        }
      : null,
    channel: {
      channel,
      postingLanguage:
        channelConfigData?.postingLanguage ?? companyRow.defaultLang ?? defaults.postingLanguage,
      imageRequired: channelConfigData?.imageRequired ?? defaults.imageRequired,
      automationModeOverride: channelConfigData?.automationModeOverride ?? null,
      maxTextLength: channelConfigData?.maxTextLength ?? null,
      includeSourceLink: channelConfigData?.includeSourceLink ?? false,
      // Unlike `imageRequired`, this has no per-channel default: a company that
      // never configured this channel has not opted in, so no auto generation.
      autoGenerateImage: channelConfigData?.autoGenerateImage ?? false,
    },
    // Resolving translation HERE — the single place feed rows become generation
    // input — means every downstream consumer (prompt builder, aspect mining,
    // source-link resolution) sees one consistent text (v2-4).
    feedItems: feedData.map((f) => {
      const resolved = resolveFeedItemContent(f);
      return {
        id: f.id,
        title: resolved.title,
        content: resolved.content,
        url: f.url,
        // Resolved HERE, alongside the text, so nothing downstream has to know
        // that a calendar event keeps its public address on the source rather
        // than on the item.
        publicUrl: resolveItemPublicUrl(f.url, f.source.config),
        publishedAt: f.publishedAt,
        // Only an RSS item has an "original article"; the others reach this map
        // with a null column anyway, so the type check just makes it explicit.
        sourceImageUrl: f.source.type === "rss" ? f.sourceImageUrl : null,
        sourceType: f.source.type,
        sourceName: f.source.name,
        sourceLinkPreference: extractSourceLinkPreference(f.source.config),
        // Carried through untouched: what to DO with it is one decision, made in
        // source-content.ts, so the prompt and the aspect miner cannot diverge.
        extractedContent: f.extractedContent,
        extractionStatus: f.extractionStatus,
        // rss/product_page → single-use article; prompt/calendar_event → evergreen.
        consumable: isConsumableSourceType(f.source.type),
        usedTranslation: resolved.usedTranslation,
      };
    }),
    hasArticleSources,
    directContentSource,
  };

  return { success: true, context, companyId, priority };
}
