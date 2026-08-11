import { prisma } from "@/lib/db/client";
import { Prisma, type SocialChannel, type LlmProvider } from "@prisma/client";
import { buildGenerationContext } from "./build-generation-context.service";
import { resolveGenerationAspect } from "./resolve-generation-aspect.service";
import type { GenerationContext, ILlmProvider } from "@/lib/ai/types";
import { buildPrompts } from "@/lib/ai/prompt-builder";
import { resolveLlmSelection } from "./resolve-llm-selection.service";
import {
  buildSupportedProvider,
  ProviderNotAvailableError,
} from "@/lib/ai/llm/supported-providers";
import { LlmProviderError, LlmRateLimitError, LlmResponseParseError } from "@/lib/ai/errors";
import {
  generateWithRetry,
  type GenerationLoopResult,
  type SemanticGate,
} from "@/lib/ai/generate-with-retry";
import { checkContentSafety } from "@/lib/ai/quality/content-safety";
import { createAuditLog, AUDIT_ACTIONS } from "@/lib/services/audit/audit-log.service";
import { CONTENT_ANGLES, selectAngle, type ContentAngle } from "@/lib/ai/content-angle";
import { selectPattern, isValidPostPattern, type PostPattern } from "@/lib/ai/post-pattern";
import { buildTopicMemory, TOPIC_MEMORY_SIZE } from "@/lib/ai/topic-memory";
import { resolvePostSourceLink } from "@/lib/ai/source-link";
import { resolvePrimarySelection } from "@/lib/ai/primary-feed-item";
import {
  planDirectContentSource,
  planFeedItemUsage,
  releaseFeedItem,
  type FeedItemPlan,
  type FeedItemReservationDb,
} from "@/lib/ai/feed-item-reservation";
import { isConsumableItem } from "@/lib/ai/source-types";
import {
  isPickedSource,
  isSelectedSourceUsable,
  resolveManualContentSource,
  toSourceScope,
  type ManualContentSourceRef,
  type ManualContentSourceSelection,
} from "@/lib/ai/manual-content-source";
import { embedPost, type EmbedPostInput, type EmbedPostOutcome } from "./embed-post.service";
import {
  autoGeneratePostImage,
  type AutoGenerateImageInput,
  type AutoGenerateImageOutcome,
} from "./auto-generate-post-image.service";
import {
  autoApplySourceImage,
  type AutoApplySourceImageInput,
  type AutoApplySourceImageOutcome,
} from "./auto-apply-source-image.service";
import { createSemanticGate } from "./semantic-gate.service";
import {
  recordSemanticCalibration,
  type SemanticCalibrationInput,
} from "./semantic-calibration.service";
import { recordPhase } from "@/lib/http/request-deadline";
import {
  buildOriginSnapshot,
  resolvePostOrigin,
  type PostOriginView,
} from "@/lib/posts/post-origin";

// ─── Mock response ─────────────────────────────────────────────────────────────

const MOCK_LLM_TEXT = JSON.stringify({
  text: "Big things are coming! Stay tuned for what we have in store. 🚀",
  hashtags: ["innovation", "growth", "comingsoon"],
  coreMessage:
    "Anticipation for an upcoming launch builds excitement and keeps the audience engaged.",
  imagePrompt: "A vibrant team collaborating in a bright modern office",
  notes: "Mock post generated in AI_MOCK_MODE for development testing.",
});

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface GeneratedPostDTO {
  id: string;
  companyId: string;
  channel: string;
  status: string;
  text: string;
  hashtags: string[];
  imagePrompt: string | null;
  notes: string | null;
  llmProvider: string | null;
  llmModel: string | null;
  /**
   * URL of the auto-generated image already attached to this post, or null when
   * none was generated. Named to match `PostItem.mediaUrl` so the client can
   * render the new post straight from this response with no refetch.
   */
  mediaUrl: string | null;
  /**
   * The original article's image, mirroring `PostItem.sourceImageUrl`, so the
   * new card can offer "Use source image" straight away. The two fields beside
   * it in PostItem are constants for a post this young — it has just been given
   * its AI image and has never been switched — so the response omits them and
   * the client reads their falsy defaults.
   */
  sourceImageUrl: string | null;
  /** Where the post was written from — mirrors PostItem.origin so the client
   *  can render the new card from this response with no refetch. */
  origin: PostOriginView;
  /**
   * The slot this post was written into, or null when generation was not asked
   * for one (the single manual flow). Echoed from the caller's option rather
   * than read back — nothing between here and the insert can change it.
   */
  scheduledFor: Date | null;
  /** The bulk run this post belongs to; null for a single manual generation. */
  generationBatchId: string | null;
  createdAt: Date;
}

export interface GenerationWarnings {
  duplicate: {
    flagged: boolean;
    similarityScore: number | null;
    matchedPostId: string | null;
  };
  safety: {
    flagged: boolean;
    matchedTerms: string[];
  };
  /** Semantic-duplicate gate outcome for the accepted (or last) candidate. */
  semanticDuplicate: {
    decision: "accept" | "gray_zone" | "regenerate";
    topSimilarity: number | null;
    matchedPostId: string | null;
    /**
     * Always false on a successful result: a candidate that stayed too similar
     * through every attempt aborts with CANNOT_GENERATE_UNIQUE_POST instead of
     * being persisted. Retained for backward compatibility.
     */
    exhausted: boolean;
    /** True when the gate could not run (fail-open). */
    skipped: boolean;
  };
}

/**
 * Why a CANNOT_GENERATE_UNIQUE_POST abort happened. Surfaced to the API/UI so
 * the user gets a reason-specific explanation instead of a generic error.
 *   • jaccard_duplicate  — wording stayed near-verbatim to a recent post
 *   • semantic_duplicate — the central claim repeated a recent post's
 *   • topic_repeated     — the conceptual topic was already used recently
 */
export type UniquenessFailureReason = "jaccard_duplicate" | "semantic_duplicate" | "topic_repeated";

/**
 * Every way one generation can fail. Named so callers that orchestrate REPEATED
 * generations (bulk) can exhaustively classify an outcome instead of matching
 * strings.
 */
export type GenerateDraftPostErrorCode =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "INVALID_CHANNEL"
  | "NO_ACTIVE_PROVIDER"
  // A per-generation llmConfigId was supplied but no active provider-state
  // row matches it (deleted or deactivated). Distinct from NO_ACTIVE_PROVIDER.
  | "LLM_CONFIG_NOT_FOUND"
  // The resolved provider is active but its required environment config is
  // now absent/incomplete (e.g. TEXT_WORKER_URL/API key removed).
  | "PROVIDER_CONFIG_MISSING"
  // The provider is rate limiting us (HTTP 429) and its bounded retries were
  // exhausted. We never switch provider/model to dodge a limit.
  | "LLM_RATE_LIMITED"
  | "LLM_PROVIDER_ERROR"
  | "LLM_RESPONSE_PARSE_ERROR"
  | "POST_TOO_LONG_WITH_URL"
  // Every retry was exhausted and the final candidate was still a
  // duplicate (near-verbatim, semantic, or a repeated topic). We refuse to
  // persist a post we could not make unique.
  | "CANNOT_GENERATE_UNIQUE_POST"
  // Source articles existed but every one was already claimed (concurrent
  // run / exhausted pool). Not an error — callers skip cleanly.
  | "NO_FEED_ITEMS_AVAILABLE"
  // Manual generation only: the source picked in the form can no longer
  // back a post — an RSS feed whose articles ran out, a non-RSS source with
  // nothing extracted yet, or any source disabled/deleted between the form
  // rendering and the click. Never a silent fallback — an explicit pick
  // that cannot be honoured is reported, not substituted.
  | "SELECTED_SOURCE_UNAVAILABLE";

export interface GenerateDraftPostFailure {
  success: false;
  code: GenerateDraftPostErrorCode;
  message?: string;
  /** Set only for CANNOT_GENERATE_UNIQUE_POST — which guard forced the abort. */
  reason?: UniquenessFailureReason;
  /** Set only for CANNOT_GENERATE_UNIQUE_POST — attempts made before aborting. */
  attempts?: number;
  /**
   * Set only for LLM_RATE_LIMITED, and only when the provider advertised a
   * Retry-After — how long to wait before trying again.
   */
  retryAfterMs?: number;
}

export type GenerateDraftPostResult =
  | { success: true; post: GeneratedPostDTO; warnings: GenerationWarnings }
  | GenerateDraftPostFailure;

// ─── Minimal DB interface for testability ─────────────────────────────────────
// Mirrors the pattern in generate-post-image.service.ts: the real Prisma client
// satisfies this narrow shape, and unit tests inject a fake that captures writes.

export interface GenerateDraftPostDb {
  post: {
    findMany: (args: {
      where: { companyId: string; channel: SocialChannel };
      orderBy: { createdAt: "desc" };
      take: number;
      select: { id: true; content: true; promptSnapshot: true; imagePrompt: true };
      // imagePrompt is optional in the row so existing fakes (and legacy posts,
      // which have none) stay valid — it only feeds the visual-diversity block.
    }) => Promise<
      Array<{
        id: string;
        content: string;
        promptSnapshot: Prisma.JsonValue | null;
        imagePrompt?: string | null;
      }>
    >;
    create: (args: {
      data: Prisma.PostUncheckedCreateInput;
      select: {
        id: true;
        companyId: true;
        channel: true;
        status: true;
        content: true;
        hashtags: true;
        imagePrompt: true;
        notes: true;
        llmProvider: true;
        llmModel: true;
        createdAt: true;
      };
    }) => Promise<{
      id: string;
      companyId: string;
      channel: SocialChannel;
      status: string;
      content: string;
      hashtags: string[];
      imagePrompt: string | null;
      notes: string | null;
      llmProvider: string | null;
      llmModel: string | null;
      createdAt: Date;
    }>;
  };
  feedItem: FeedItemReservationDb["feedItem"];
}

export interface GenerateDraftPostDeps {
  db?: GenerateDraftPostDb;
  auditLog?: typeof createAuditLog;
  /** Best-effort semantic embedding (Phase 1.2). Injected in tests. */
  embed?: (input: EmbedPostInput) => Promise<EmbedPostOutcome>;
  /** Best-effort automatic image generation. Injected in tests. */
  autoImage?: (input: AutoGenerateImageInput) => Promise<AutoGenerateImageOutcome>;
  /**
   * Best-effort import of the source article's own image, which then leads.
   * Injected in tests.
   */
  autoSourceImage?: (input: AutoApplySourceImageInput) => Promise<AutoApplySourceImageOutcome>;
  /** Best-effort semantic-gate calibration write (Phase 1.5). Injected in tests. */
  recordCalibration?: (input: SemanticCalibrationInput) => Promise<void>;
  /**
   * Semantic-duplicate gate (Phase 1.4). Injected in tests; in production a
   * real one is built per company+channel from the embedding provider + store.
   */
  semanticGate?: SemanticGate;
  /**
   * Resolves an ACTIVE provider-state row by id for per-generation selection.
   * Injected in tests; production reads the DB. Returns null when no active row
   * matches the id. Only the provider enum is returned — credentials and model
   * come from env (see supported-providers.ts), never the DB.
   */
  loadLlmConfig?: (id: string) => Promise<{ provider: LlmProvider } | null>;
  /**
   * Loads the single system-default provider for the "Auto" path (no explicit
   * llmConfigId). Injected in tests; production reads the DB. Returns null when no
   * DB default is configured — the caller then falls back to the env-var provider.
   */
  loadDefaultLlmConfig?: () => Promise<{ id: string; provider: LlmProvider } | null>;
}

// ─── Service ───────────────────────────────────────────────────────────────────

export interface GeneratePostOptions {
  contentLanguage?: string;
  /** Acting user; omitted for system-generated (cron) posts. */
  generatedById?: string;
  /** Weekly schedule this post belongs to (cron generation only). */
  scheduleId?: string;
  scheduledFor?: Date;
  /**
   * The manual bulk run this post belongs to — one id shared by every post of
   * one bulk request (see bulk-generate-posts.service.ts). Undefined for single
   * manual generation and for cron, which have no batch.
   *
   * It changes nothing about how the post is generated or reviewed — a bulk post
   * is an ordinary manual draft. It IS load-bearing at publish time: it is how
   * the publisher tells a time a person chose from one the weekly filler
   * estimated, so it must never be cleared or reused
   * (lib/scheduling/publish-window.ts).
   */
  generationBatchId?: string;
  /**
   * The content-mix quota this post is drawn against (v2-8): a source id, or
   * null for the company-content (mission) quota. Passed explicitly rather than
   * inferred from the claimed feed item, because an evergreen (prompt/calendar)
   * post has no claimed item yet still belongs to its source's quota.
   * Undefined outside the mix path (user flow, unconfigured companies).
   */
  contentSourceId?: string | null;
  /** Defaults to "draft" (user flow). Cron generation uses "pending_approval". */
  initialStatus?: "draft" | "pending_approval";
  /**
   * Manual per-generation source-link override (v2-1). Undefined = inherit
   * from the content source preference, then the channel default.
   */
  includeSourceLinkOverride?: boolean;
  /**
   * Explicit, one-time LLM config chosen in the generation form (v2-5). Highest
   * priority: when set it wins over the user preference and the admin default.
   * An inactive/deleted id is a hard error (LLM_CONFIG_NOT_FOUND) — never a
   * silent fallback, since the user made an explicit choice.
   */
  llmConfigId?: string;
  /**
   * Manual per-generation image override chosen in the generation form. When set
   * it replaces the channel's `autoGenerateImage` for this generation only —
   * true forces an image on a channel that has not opted in, false suppresses
   * one on a channel that has. Undefined = inherit the channel setting, which is
   * the only value cron ever uses, so scheduled generation is unchanged.
   */
  autoGenerateImageOverride?: boolean;
  /**
   * The acting user's saved preferred LLM config id (persistent). Consulted only
   * when no explicit llmConfigId is given, and only if it is still active — an
   * unavailable preference falls back to the admin default (never an error).
   * Cron/scheduled generation leaves this undefined so it always uses the admin
   * default, never a user's preference.
   */
  preferredLlmConfigId?: string | null;
}

export async function generateDraftPost(
  slug: string,
  rawChannel: string,
  userId: string,
  isGlobalAdmin: boolean,
  options: Pick<
    GeneratePostOptions,
    | "contentLanguage"
    | "includeSourceLinkOverride"
    | "llmConfigId"
    | "autoGenerateImageOverride"
    // Both are set only by bulk generation, which schedules each post it writes
    // and tags it with the run it came from. The single manual flow omits them
    // and behaves exactly as before.
    | "scheduledFor"
    | "generationBatchId"
  > & {
    /**
     * The form's "Content source" choice, as it came off the wire. Omitted =
     * company rules, i.e. the pooled behaviour this flow has always had.
     */
    contentSource?: ManualContentSourceRef;
  } = {}
): Promise<GenerateDraftPostResult> {
  const ref: ManualContentSourceRef = options.contentSource ?? { kind: "company_rules" };

  // ── Resolve WHAT KIND of source was picked ────────────────────────────────
  // The type decides the entire downstream pipeline — an RSS pick reserves and
  // consumes one unused article, anything else reads the source's stored
  // extraction and consumes nothing — so it is read from the database, never
  // taken from the form. A client that could name the path could make one RSS
  // article back two posts.
  //
  // The lookup is scoped by company slug AND membership, so a source belonging
  // to another company resolves to null exactly like a deleted one: the caller
  // learns "not available", never that it exists.
  let selection: ManualContentSourceSelection;
  if (ref.kind === "source") {
    const picked = await prisma.contentSource.findFirst({
      where: {
        id: ref.sourceId,
        enabled: true,
        company: isGlobalAdmin ? { slug } : { slug, members: { some: { userId } } },
      },
      select: { type: true },
    });
    const resolved = resolveManualContentSource(ref, picked?.type ?? null);
    if (!resolved) {
      return {
        success: false,
        code: "SELECTED_SOURCE_UNAVAILABLE",
        message: "The selected content source is no longer available.",
      };
    }
    selection = resolved;
  } else {
    selection = ref;
  }

  // Build context (also validates auth/access). The scope narrows the article
  // window to the chosen source — or to nothing at all for a mission post.
  const contextResult = await buildGenerationContext(
    slug,
    rawChannel,
    userId,
    isGlobalAdmin,
    toSourceScope(selection)
  );
  if (!contextResult.success) {
    return { success: false, code: contextResult.code };
  }

  // Fail before spending an LLM call when the picked source has nothing to write
  // from. The window is already scoped to it, so this also catches a source
  // whose articles ran out (RSS) or that has never been extracted (non-RSS).
  if (!isSelectedSourceUsable(selection, contextResult.context.feedItems)) {
    return {
      success: false,
      code: "SELECTED_SOURCE_UNAVAILABLE",
      message: unavailableMessage(selection),
    };
  }

  // Load the user's saved preference only when the form did not send an explicit
  // one-time selection — an explicit choice always wins, so the read is skipped.
  let preferredLlmConfigId: string | null = null;
  if (!options.llmConfigId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { preferredLlmConfigId: true },
    });
    preferredLlmConfigId = user?.preferredLlmConfigId ?? null;
  }

  const result = await generatePostFromContext(contextResult.context, contextResult.companyId, {
    contentLanguage: options.contentLanguage,
    includeSourceLinkOverride: options.includeSourceLinkOverride,
    llmConfigId: options.llmConfigId,
    autoGenerateImageOverride: options.autoGenerateImageOverride,
    preferredLlmConfigId,
    generatedById: userId,
    // Set by bulk generation only; undefined here leaves the single manual flow
    // writing an unscheduled, unbatched draft exactly as it always has.
    scheduledFor: options.scheduledFor,
    generationBatchId: options.generationBatchId,
    // The picked source, recorded on the post as a durable FK. For a direct
    // content-source post this is the ONLY relation back to what it was written
    // from — primaryFeedItemId stays null because nothing was reserved. It can
    // never disturb the content mix: the scheduler counts only posts carrying
    // its own scheduleId, and a manual post has none.
    contentSourceId: isPickedSource(selection) ? selection.sourceId : undefined,
  });

  // The guard above found something to write from, but a concurrent run claimed
  // the last article before this one could. For a specific-source pick that is
  // the same story the guard tells — the source has nothing left — so it gets
  // the same answer rather than the pooled "no articles anywhere" message, which
  // would be untrue.
  if (!result.success && result.code === "NO_FEED_ITEMS_AVAILABLE" && isPickedSource(selection)) {
    return {
      success: false,
      code: "SELECTED_SOURCE_UNAVAILABLE",
      message: unavailableMessage(selection),
    };
  }

  return result;
}

/** Why a picked source could not back a post, phrased for the kind picked. */
function unavailableMessage(selection: ManualContentSourceSelection): string {
  return selection.kind === "content_source"
    ? "The selected content source has no extracted content yet. Fetch it and try again."
    : "No new articles are available for the selected source.";
}

/**
 * Generation core shared by the user flow above and the cron dispatcher.
 * Access control must already have happened; this function only generates,
 * runs the quality guards, and persists the post.
 */
export async function generatePostFromContext(
  context: GenerationContext,
  companyId: string,
  options: GeneratePostOptions = {},
  deps: GenerateDraftPostDeps = {}
): Promise<GenerateDraftPostResult> {
  const db: GenerateDraftPostDb = deps.db ?? prisma;
  const auditLog = deps.auditLog ?? createAuditLog;
  const embed = deps.embed ?? embedPost;
  const autoImage = deps.autoImage ?? autoGeneratePostImage;
  const autoSourceImage = deps.autoSourceImage ?? autoApplySourceImage;
  const recordCalibration = deps.recordCalibration ?? recordSemanticCalibration;
  const { contentLanguage, generatedById, scheduleId, scheduledFor } = options;
  const initialStatus = options.initialStatus ?? "draft";

  // ── Fetch recent posts before generation ──────────────────────────────────
  // Used both as prompt context (avoid repetition) and for duplicate detection
  // after. Topic Memory needs a wider window (30) than the diversity/Jaccard
  // signals (10), so we fetch 30 and slice the first 10 for the rest.
  const recentRows = await db.post.findMany({
    where: { companyId, channel: context.channel.channel as SocialChannel },
    orderBy: { createdAt: "desc" },
    take: TOPIC_MEMORY_SIZE,
    // imagePrompt rides along on the query that was already being made: it is
    // what the recent IMAGES looked like, which the post text cannot express.
    select: { id: true, content: true, promptSnapshot: true, imagePrompt: true },
  });

  // Topic Memory — normalized conceptual topics from the last 30 posts. Fed to
  // the prompt as recently-used subjects to avoid AND used to reject a candidate
  // whose normalized topic collides with one already used (a retry trigger).
  const topicMemory = buildTopicMemory(
    recentRows.map(
      (r) =>
        (r.promptSnapshot as Record<string, unknown> | null)?.topic as string | null | undefined
    )
  );

  // Diversity/Jaccard signals use only the most recent 10, as before.
  const recentRows10 = recentRows.slice(0, 10);

  // Extract diversity signals from promptSnapshot (most-recent-first) — absent on legacy posts.
  const snapshots = recentRows10.map((r) => r.promptSnapshot as Record<string, unknown> | null);

  const recentAngles: ContentAngle[] = snapshots
    .map((s) => {
      const angle = s?.contentAngle;
      return typeof angle === "string" && (CONTENT_ANGLES as readonly string[]).includes(angle)
        ? (angle as ContentAngle)
        : null;
    })
    .filter((a): a is ContentAngle => a !== null);

  const recentPatterns: PostPattern[] = snapshots
    .map((s) => s?.contentPattern)
    .filter((p): p is PostPattern => isValidPostPattern(p));

  const initialAngle = selectAngle(recentAngles);
  const initialPattern = selectPattern(recentPatterns);

  // ── LLM provider ─────────────────────────────────────────────────────────
  // Created before aspect mining so the same provider handles both extraction and
  // generation. Retries reuse this exact instance (passed once into the retry
  // loop below) — provider/model never switch mid-generation, including in
  // response to a rate limit.
  const isMock = process.env.AI_MOCK_MODE === "true";
  const mockProvider: ILlmProvider = { generate: async () => ({ text: MOCK_LLM_TEXT }) };

  // Resolve which provider to use, and the config id actually used (recorded on the
  // post/promptSnapshot for provenance). See resolve-llm-selection.service.ts for
  // the precedence rules; it is shared with the prompt-preview route so a preview
  // can never report a provider other than the one that really runs.
  const selectionResult = await resolveLlmSelection(
    {
      llmConfigId: options.llmConfigId ?? null,
      preferredLlmConfigId: options.preferredLlmConfigId ?? null,
    },
    { loadLlmConfig: deps.loadLlmConfig, loadDefaultLlmConfig: deps.loadDefaultLlmConfig }
  );
  if (!selectionResult.success) {
    return { success: false, code: selectionResult.code, message: selectionResult.message };
  }
  const { selection } = selectionResult;
  const resolvedLlmConfigId = selection.llmConfigId;

  // Provenance reflects the resolved provider; the model comes from env (code).
  const llmProviderStr = selection.providerLabel;
  let llmModelStr = selection.model;

  let provider: ILlmProvider;
  if (isMock) {
    provider = mockProvider;
  } else {
    try {
      const built = buildSupportedProvider(selection.provider);
      provider = built.instance;
      llmModelStr = built.model;
    } catch (err) {
      // The provider was active but its env config is now absent/incomplete. This
      // is a hard error — an explicit/preferred provider is never silently swapped.
      if (err instanceof ProviderNotAvailableError) {
        return { success: false, code: "PROVIDER_CONFIG_MISSING", message: err.message };
      }
      throw err;
    }
  }

  // ── Claim the source (Phase 0 — one-post-per-article) ──────────────────────
  // Only single-use ARTICLE items (rss/product_page) are claimable; atomically
  // reserve one BEFORE any LLM call so a concurrent cron invocation (and later
  // iterations of this same run) can never rewrite the same article. Evergreen
  // (prompt/calendar) items are never claimed and never consumed — they stay
  // reusable across generations.
  //
  // The four-way decision (see planFeedItemUsage):
  //   • no sources at all            → mission/brand post (primaryFeedItemId null)
  //   • article source, no candidates → skip cleanly (all articles already used)
  //   • article candidate claimable   → claim one and generate from it
  //   • evergreen item available       → generate from it, no claim, reusable
  //
  // A manually picked non-RSS source bypasses the whole decision: its window is
  // one source's stored extraction, which is read directly and never consumed.
  // Routing it through the reservation would claim a product page's single row
  // and leave the source permanently dry.
  const articleCandidateIds = context.feedItems.filter(isConsumableItem).map((f) => f.id);
  const hasEvergreenItems = context.feedItems.some((f) => !isConsumableItem(f));
  const plan: FeedItemPlan = context.directContentSource
    ? planDirectContentSource(context.feedItems)
    : await planFeedItemUsage(
        articleCandidateIds,
        context.hasArticleSources,
        hasEvergreenItems,
        db
      );
  if (plan.action === "skip") {
    // Article sources are configured but every eligible article is already used
    // (or a concurrent run claimed the last candidate) and no evergreen item is
    // available. For a direct content source: nothing has been extracted for it.
    // Not an error — the caller skips (the manual flow reports it as
    // SELECTED_SOURCE_UNAVAILABLE).
    return { success: false, code: "NO_FEED_ITEMS_AVAILABLE" };
  }

  // ── The primary article, decided ONCE ─────────────────────────────────────
  // Everything downstream reads this object: the prompt's PRIMARY SOURCE block,
  // the mined aspects, Post.primaryFeedItemId, the appended URL, and the
  // promptSnapshot. Nothing re-derives it from context.feedItems or an index —
  // two independent derivations is exactly how a post ends up discussing one
  // article and linking to another.
  const primary = resolvePrimarySelection(context.feedItems, plan);
  const claimedFeedItemId = primary.claimedFeedItemId;

  if (plan.action === "evergreen") {
    // Reusable prompt/calendar content. Restrict the context to evergreen items
    // so the background can hold no article either — one may have been claimable
    // when the context was built and raced away since, and a raced article must
    // not even appear as background for a post that does not link to it.
    context = { ...context, feedItems: context.feedItems.filter((f) => !isConsumableItem(f)) };
  }
  // plan.action === "mission": no sources — primary.item is null and the existing
  // no-source mission/brand post path is used.

  // Frees the claimed article if generation fails before the post is persisted.
  const releaseClaimedFeedItem = async () => {
    if (claimedFeedItemId) await releaseFeedItem(claimedFeedItemId, db);
  };

  // ── Aspect mining ─────────────────────────────────────────────────────────
  // Errors are caught inside resolveGenerationAspect — generation always continues.
  const {
    aspect: initialAspect,
    pool: aspectPool,
    extractionRound,
    fingerprint: aspectFingerprint,
    usedAspectIds,
    // Aspect mining is an LLM call — timed into the `llm` phase for cron diagnostics.
  } = await recordPhase("llm", () =>
    resolveGenerationAspect({
      // Aspects are mined from the primary ALONE. An aspect reaches the prompt as a
      // mandatory "build the post around this" constraint, so one mined from a
      // background article would order the model to write about an article this
      // post does not link to.
      primary: primary.item,
      snapshots,
      provider,
    })
  );

  // ── Build prompts ─────────────────────────────────────────────────────────
  const { systemPrompt, userPrompt } = buildPrompts(
    context,
    primary.item,
    contentLanguage,
    recentRows10.slice(0, 5).map((r) => ({ text: r.content, imagePrompt: r.imagePrompt ?? null })),
    {
      angle: initialAngle,
      pattern: initialPattern,
      recentTopics: topicMemory,
      aspect: initialAspect,
    }
  );

  // ── Semantic duplicate gate (Phase 1.4) ───────────────────────────────────
  // Embeds each candidate's coreMessage and compares it (cosine) against the
  // latest ready embeddings for this company+channel. Fail-open: any failure
  // leaves generation working and is surfaced as a skip. The gate never stores.
  const semanticGate =
    deps.semanticGate ?? createSemanticGate(companyId, context.channel.channel as SocialChannel);

  // ── Generate with retry (duplicate-aware) ─────────────────────────────────
  // Retries up to MAX_GENERATION_ATTEMPTS times when the candidate is a
  // near-verbatim (Jaccard) or semantic duplicate. Only the final accepted post
  // is persisted; rejected candidates leave no embedding behind.
  let generationResult!: GenerationLoopResult;
  try {
    // The generation LLM calls (incl. retries) — timed into the `llm` phase.
    generationResult = await recordPhase("llm", () =>
      generateWithRetry(
        provider,
        systemPrompt,
        userPrompt,
        recentRows10.map((r) => ({ id: r.id, text: r.content })),
        {
          initialAngle,
          recentAngles,
          initialPattern,
          recentPatterns,
          recentTopics: topicMemory,
          initialAspect,
          aspectPool,
          aspectUsedIds: usedAspectIds,
        },
        semanticGate
      )
    );
  } catch (err) {
    await releaseClaimedFeedItem();
    // Diagnostic: the terminal error code the route maps to HTTP 502. No prompt,
    // key, or model content is logged — the code (and parse category) suffice to
    // classify the failure. The provider already logged worker status/transport.
    // Must precede the LlmProviderError branch — LlmRateLimitError extends it.
    if (err instanceof LlmRateLimitError) {
      console.warn(
        `[llm-diag] generation aborted → code=LLM_RATE_LIMITED (maps to HTTP 429) retryAfterMs=${
          err.retryAfterMs ?? "unknown"
        }`
      );
      return { success: false, code: "LLM_RATE_LIMITED", retryAfterMs: err.retryAfterMs };
    }
    if (err instanceof LlmProviderError) {
      console.warn("[llm-diag] generation aborted → code=LLM_PROVIDER_ERROR (maps to HTTP 502)");
      return { success: false, code: "LLM_PROVIDER_ERROR", message: err.message };
    }
    if (err instanceof LlmResponseParseError) {
      console.warn(
        `[llm-diag] generation aborted → code=LLM_RESPONSE_PARSE_ERROR (maps to HTTP 502) category=${
          err.category ?? "unknown"
        }`
      );
      return { success: false, code: "LLM_RESPONSE_PARSE_ERROR", message: err.message };
    }
    throw err;
  }

  // ── Quality guards ────────────────────────────────────────────────────────
  const {
    parsed,
    duplicateResult,
    semanticResult,
    coreMessageGeneric,
    topicRepeated,
    attempts,
    selectedAngle,
    selectedPattern,
    selectedAspect,
  } = generationResult;

  // ── Uniqueness abort ──────────────────────────────────────────────────────
  // The retry loop always returns its last candidate. If that candidate is
  // STILL a duplicate after every attempt — a near-verbatim (Jaccard) match, a
  // semantic "regenerate", or a repeated conceptual topic — we refuse to persist
  // it. Generation is aborted with a dedicated error and the claimed source
  // article is released so it can back a future (unique) post. Note: a skipped
  // semantic gate reports decision "accept", so fail-open never triggers this.
  // (A generic coreMessage is a fail-safe signal only and never aborts here.)
  if (duplicateResult.flagged || semanticResult.decision === "regenerate" || topicRepeated) {
    await releaseClaimedFeedItem();
    const reason: UniquenessFailureReason = duplicateResult.flagged
      ? "jaccard_duplicate"
      : semanticResult.decision === "regenerate"
        ? "semantic_duplicate"
        : "topic_repeated";
    console.warn(
      `[generation] Aborted after ${attempts} attempts → code=CANNOT_GENERATE_UNIQUE_POST reason=${reason} (post not saved).`
    );
    return {
      success: false,
      code: "CANNOT_GENERATE_UNIQUE_POST",
      message: "Could not generate a sufficiently unique post after all attempts.",
      reason,
      attempts,
    };
  }

  const safetyResult = checkContentSafety({
    text: parsed.text,
    brandForbiddenWords: context.brand?.forbiddenWords ?? [],
  });

  // Log (calibration) the fail-open skip and the gray zone; never block.
  if (semanticResult.skipped) {
    console.warn(
      `[semantic-gate] Skipped for company ${companyId} channel ${context.channel.channel} (fail-open; embedding or lookup unavailable).`
    );
  } else if (semanticResult.decision === "gray_zone") {
    console.warn(
      `[semantic-gate] Gray zone (topSimilarity=${semanticResult.topSimilarity}, matched=${semanticResult.matchedPostId}) — accepted; thresholds pending calibration.`
    );
  }

  const qualityGuards = {
    duplicate: {
      flagged: duplicateResult.flagged,
      similarityScore: duplicateResult.similarityScore,
      matchedPostId: duplicateResult.matchedPostId,
    },
    safety: {
      flagged: safetyResult.flagged,
      matchedTerms: safetyResult.matchedTerms,
    },
    semanticDuplicate: {
      decision: semanticResult.decision,
      topSimilarity: semanticResult.topSimilarity,
      matchedPostId: semanticResult.matchedPostId,
      skipped: semanticResult.skipped,
      // A "regenerate" that survives every attempt now aborts generation before
      // this point (CANNOT_GENERATE_UNIQUE_POST), so a persisted post is never
      // an unresolved semantic duplicate.
      warning: false,
    },
  };

  // ── Source link (v2-1) ────────────────────────────────────────────────────
  // The URL is appended programmatically — never by the LLM — and comes from the
  // same PrimarySelection that built the prompt and the aspect, so the appended
  // URL and the generated text refer to the same article by construction.
  const sourceLinkResult = resolvePostSourceLink({
    primary,
    text: parsed.text,
    manualOverride: options.includeSourceLinkOverride,
    channelDefault: context.channel.includeSourceLink,
    maxTextLength: context.channel.maxTextLength,
  });
  if (!sourceLinkResult.ok) {
    await releaseClaimedFeedItem();
    return {
      success: false,
      code: "POST_TOO_LONG_WITH_URL",
      message: `Post text plus source URL exceeds the channel limit of ${context.channel.maxTextLength} characters.`,
    };
  }
  const {
    finalContent,
    sourceUrl,
    primaryFeedItemId,
    sourceTitle,
    includeSourceLink,
    includeSourceLinkLevel,
  } = sourceLinkResult.data;

  // ── Resolve final status ──────────────────────────────────────────────────
  // Generation NEVER approves. The caller's initialStatus stands as written:
  // `draft` for the manual flow, `pending_approval` for cron.
  //
  // A fully_automated channel used to short-circuit manual generation straight
  // to `approved`, which meant a post a human asked for was past review before
  // they could look at it. Automation now earns its approval one place only —
  // cron step 4 (autoApprovePosts), which promotes `pending_approval` posts on
  // fully_automated channels and is also where the safety-flag hold lives. A
  // manually generated post therefore always waits for a person, whatever the
  // channel mode says, and there is still exactly one approval step.
  //
  // Unresolved duplicates never reach this point — they abort above
  // (CANNOT_GENERATE_UNIQUE_POST).
  const resolvedStatus: "draft" | "pending_approval" = initialStatus;

  // ── Save post ─────────────────────────────────────────────────────────────
  const feedItemIds = context.feedItems.map((f) => f.id);

  // Frozen provenance. Taken from the article the post was actually built on —
  // `primary.item`, not the form's dropdown value and not the FK, which a later
  // source deletion would null out from under us.
  const originSnapshot = buildOriginSnapshot(primary.item);

  const post = await db.post.create({
    data: {
      companyId,
      channel: context.channel.channel as SocialChannel,
      // Phase 1.1 — the post's central claim/takeaway, in a dedicated column.
      // Still mirrored in promptSnapshot.coreMessage below for audit/debugging.
      coreMessage: parsed.coreMessage,
      // The reserved source article. The DB unique index on this column is the
      // hard guarantee that one feed item never backs two posts.
      primaryFeedItemId: claimedFeedItemId,
      // v2-8 — the quota this post consumed. Null both for mission posts and
      // outside the mix path entirely; the scheduler only counts posts within
      // the current schedule, so a legacy null can never be miscounted.
      contentSourceId: options.contentSourceId ?? null,
      ...originSnapshot,
      status: resolvedStatus,
      // Never stamped at generation. Approval — human or cron — is what sets it.
      approvedAt: null,
      content: finalContent,
      hashtags: parsed.hashtags,
      imagePrompt: parsed.imagePrompt ?? null,
      notes: parsed.notes ?? null,
      llmProvider: llmProviderStr,
      llmModel: llmModelStr,
      generatedById: generatedById ?? null,
      scheduleId: scheduleId ?? null,
      scheduledFor: scheduledFor ?? null,
      // Which bulk run wrote this post, if any. An association and nothing more:
      // the status above is untouched by it, so a bulk post is reviewed exactly
      // like any other manual draft.
      generationBatchId: options.generationBatchId ?? null,
      safetyFlagged: safetyResult.flagged,
      safetyFlagReason: safetyResult.flagged
        ? `Flagged terms: ${safetyResult.matchedTerms.join(", ")}`
        : null,
      promptSnapshot: {
        systemPrompt,
        userPrompt,
        provider: llmProviderStr,
        model: llmModelStr,
        // The LlmConfig actually used — an explicit selection, the user preference,
        // or the admin default. Null only when the env-var fallback ran. provider/
        // model above already reflect the resolved choice.
        llmConfigId: resolvedLlmConfigId,
        feedItemIds,
        generatedAt: new Date().toISOString(),
        contentAngle: selectedAngle ?? null,
        contentPattern: selectedPattern
          ? {
              hookType: selectedPattern.hookType,
              structure: selectedPattern.structure,
              ctaType: selectedPattern.ctaType,
            }
          : null,
        topic: parsed.topic ?? null,
        // Phase 1.1 — the single central claim/takeaway of the post. Also stored
        // in the dedicated Post.coreMessage column; mirrored here for auditing.
        coreMessage: parsed.coreMessage,
        qualityGuards,
        // Phase 1.4 — semantic-duplicate gate diagnostics for calibration.
        semanticGate: {
          topSimilarity: semanticResult.topSimilarity,
          matchedPostId: semanticResult.matchedPostId,
          decision: semanticResult.decision,
          attempts,
          skipped: semanticResult.skipped,
          // Phase 1.5 — the final candidate's coreMessage was generic praise.
          coreMessageGeneric,
          // Topic Memory — the final candidate's normalized topic was already used.
          topicRepeated,
        },
        // Source link decision (v2-1) — traceability for the appended URL.
        // primaryFeedItemId/sourceTitle pin the exact article the post is based
        // on, so text and URL are auditably the same source.
        primaryFeedItemId,
        sourceUrl,
        sourceTitle,
        includeSourceLink,
        includeSourceLinkLevel,
        // Aspect fields — null when no aspect was mined (null fails the hasAspectFields guard
        // in loadAspectPoolData so legacy and no-aspect posts are treated identically).
        aspectFingerprint: aspectFingerprint && selectedAspect ? aspectFingerprint : null,
        // Cast to Record<string, string>[] / Record<string, string> so Prisma's
        // InputJsonObject constraint is satisfied (ContentAspect has no index signature).
        aspectPool:
          aspectFingerprint && selectedAspect
            ? (aspectPool as unknown as Record<string, string>[])
            : null,
        selectedAspect: selectedAspect
          ? (selectedAspect as unknown as Record<string, string>)
          : null,
        aspectUsedAt: aspectFingerprint && selectedAspect ? new Date().toISOString() : null,
        aspectExtractionRound: aspectFingerprint && selectedAspect ? extractionRound : null,
      },
    },
    select: {
      id: true,
      companyId: true,
      channel: true,
      status: true,
      content: true,
      hashtags: true,
      imagePrompt: true,
      notes: true,
      llmProvider: true,
      llmModel: true,
      createdAt: true,
    },
  });

  await auditLog({
    companyId,
    userId: generatedById,
    action: AUDIT_ACTIONS.POST_GENERATED,
    entityType: "post",
    entityId: post.id,
    metadata: {
      channel: post.channel,
      llmProvider: post.llmProvider ?? undefined,
      llmModel: post.llmModel ?? undefined,
      ...(generatedById ? {} : { automated: true }),
    },
  });

  // ── Semantic-gate calibration (Phase 1.5) ─────────────────────────────────
  // Best-effort and non-blocking: persists the gate outcome for this post to its
  // post_semantics row so calibration is queryable. Runs regardless of whether
  // embedding is available, so even a skipped gate leaves a calibration record.
  await recordCalibration({
    postId: post.id,
    companyId,
    channel: post.channel as SocialChannel,
    postCreatedAt: post.createdAt,
    topSimilarity: semanticResult.topSimilarity,
    matchedPostId: semanticResult.matchedPostId,
    decision: semanticResult.decision,
    attempts,
    gateSkipped: semanticResult.skipped,
    evaluatedAt: new Date(),
  });

  // ── Semantic embedding (Phase 1.2) ────────────────────────────────────────
  // Best-effort and non-blocking: embedPost never throws, and any failure leaves
  // a row for the backfill to retry. It runs AFTER the post is persisted, in its
  // own statements (no long transaction), so it can never fail generation.
  try {
    await embed({
      postId: post.id,
      companyId,
      channel: post.channel as SocialChannel,
      coreMessage: parsed.coreMessage,
      topic: parsed.topic ?? null,
      aspectFocus: selectedAspect?.focus ?? null,
      postCreatedAt: post.createdAt,
    });
  } catch (err) {
    console.error(
      `[embed] Post ${post.id} embedding failed (non-fatal):`,
      err instanceof Error ? err.message : err
    );
  }

  // ── Automatic image generation ────────────────────────────────────────────
  // Runs for every caller of this function — the generate route AND cron — so
  // the channel setting is honoured on both paths from one place. Best-effort
  // by the same rule as embedding: autoGeneratePostImage never throws, and a
  // failed image leaves a perfectly good post that can still be illustrated
  // manually. Placed after embedding so a slow image provider cannot delay the
  // cheap DB work above.
  // The try/catch is belt-and-braces: autoGeneratePostImage already swallows its
  // own failures, but the post is already committed at this point, so nothing
  // thrown here may be allowed to turn a saved post into a failed generation.
  //
  // The pipeline attaches the media itself; the URL is captured here only so the
  // response can carry it. A post whose image failed simply reports mediaUrl
  // null and can still be illustrated manually.
  let mediaUrl: string | null = null;
  try {
    // Image generation (provider + upload) — timed into the `image` phase.
    const outcome = await recordPhase("image", () =>
      autoImage({
        postId: post.id,
        companyId,
        // The manual form override wins when present; cron never sends one, so
        // scheduled generation still reads the channel setting.
        enabled: options.autoGenerateImageOverride ?? context.channel.autoGenerateImage,
        generatedById,
      })
    );
    if (outcome.status === "generated") mediaUrl = outcome.media.url;
  } catch (err) {
    console.error(
      `[auto-image] Post ${post.id} auto image generation failed (non-fatal):`,
      err instanceof Error ? err.message : err
    );
  }

  // ── The article's own image takes the lead ────────────────────────────────
  // For a post written from an article, the article's real photograph beats a
  // drawing of it, so it becomes the post's image. Deliberately AFTER the block
  // above rather than instead of it: the AI image is still generated, and the
  // import displaces it into `previousMediaAssetId` — kept, linked to the post,
  // and one click away in the picker. Nothing is deleted or overwritten.
  //
  // Non-article posts are untouched. The service reads the image through
  // `primaryFeedItem` behind an `rss` check, so brand-setup, prompt,
  // calendar-event and product-page posts report `no_source_image` and keep
  // exactly the image they had before this block existed.
  //
  // Same best-effort contract as above: it never throws, and a failed import
  // leaves a post that still has its AI image.
  //
  // The gate asks only "was this post written from a content item at all?",
  // which is the one part the call site can answer for free. Whether that item is
  // an article, and whether the article has a usable image, belongs to the
  // service — it resolves the image on demand, scraping the article when
  // ingestion stored nothing. Gating here on `sourceImageUrl` instead is exactly
  // what used to skip the import on any item ingested before images were
  // resolved, while the picker's "Source article" tab found the image happily.
  // The price of asking is one indexed read on a prompt/calendar post, against
  // an LLM call that has already happened.
  if (primary.item) {
    try {
      const outcome = await recordPhase("image", () =>
        autoSourceImage({ postId: post.id, companyId, generatedById })
      );
      if (outcome.status === "applied") mediaUrl = outcome.media.url;
    } catch (err) {
      console.error(
        `[source-image] Post ${post.id} article image import failed (non-fatal):`,
        err instanceof Error ? err.message : err
      );
    }
  }

  const warnings: GenerationWarnings = {
    duplicate: duplicateResult,
    safety: safetyResult,
    semanticDuplicate: {
      decision: semanticResult.decision,
      topSimilarity: semanticResult.topSimilarity,
      matchedPostId: semanticResult.matchedPostId,
      // A persisted post is never an exhausted duplicate — those abort earlier.
      exhausted: false,
      skipped: semanticResult.skipped,
    },
  };

  return {
    success: true,
    post: {
      id: post.id,
      companyId: post.companyId,
      channel: post.channel.toUpperCase(),
      status: post.status.toUpperCase(),
      text: post.content,
      hashtags: post.hashtags,
      imagePrompt: post.imagePrompt,
      notes: post.notes,
      llmProvider: post.llmProvider,
      llmModel: post.llmModel,
      mediaUrl,
      sourceImageUrl: primary.item?.sourceImageUrl ?? null,
      // Straight from what was just written — no read-back needed, and the
      // client renders the new card from this response with no refetch.
      origin: resolvePostOrigin(originSnapshot, null),
      scheduledFor: scheduledFor ?? null,
      generationBatchId: options.generationBatchId ?? null,
      createdAt: post.createdAt,
    },
    warnings,
  };
}
