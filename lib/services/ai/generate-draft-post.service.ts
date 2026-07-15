import { prisma } from "@/lib/db/client";
import { Prisma, type SocialChannel } from "@prisma/client";
import { buildGenerationContext } from "./build-generation-context.service";
import { resolveGenerationAspect } from "./resolve-generation-aspect.service";
import type { GenerationContext, ILlmProvider } from "@/lib/ai/types";
import { buildPrompts } from "@/lib/ai/prompt-builder";
import { getLlmProvider, NoActiveLlmProviderError } from "@/lib/ai/llm/llm-provider-factory";
import { LlmProviderError, LlmResponseParseError } from "@/lib/ai/errors";
import {
  generateWithRetry,
  type GenerationLoopResult,
  type SemanticGate,
} from "@/lib/ai/generate-with-retry";
import { checkContentSafety } from "@/lib/ai/quality/content-safety";
import { createAuditLog, AUDIT_ACTIONS } from "@/lib/services/audit/audit-log.service";
import { CONTENT_ANGLES, selectAngle, type ContentAngle } from "@/lib/ai/content-angle";
import { selectPattern, isValidPostPattern, type PostPattern } from "@/lib/ai/post-pattern";
import { resolvePostSourceLink } from "@/lib/ai/source-link";
import {
  planFeedItemUsage,
  releaseFeedItem,
  type FeedItemReservationDb,
} from "@/lib/ai/feed-item-reservation";
import { isConsumableItem } from "@/lib/ai/source-types";
import { embedPost, type EmbedPostInput, type EmbedPostOutcome } from "./embed-post.service";
import { createSemanticGate } from "./semantic-gate.service";
import {
  recordSemanticCalibration,
  type SemanticCalibrationInput,
} from "./semantic-calibration.service";

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
    /** True when all attempts stayed too similar (post forced to pending approval). */
    exhausted: boolean;
    /** True when the gate could not run (fail-open). */
    skipped: boolean;
  };
}

export type GenerateDraftPostResult =
  | { success: true; post: GeneratedPostDTO; warnings: GenerationWarnings }
  | {
      success: false;
      code:
        | "NOT_FOUND"
        | "FORBIDDEN"
        | "INVALID_CHANNEL"
        | "NO_ACTIVE_PROVIDER"
        | "LLM_PROVIDER_ERROR"
        | "LLM_RESPONSE_PARSE_ERROR"
        | "POST_TOO_LONG_WITH_URL"
        // Source articles existed but every one was already claimed (concurrent
        // run / exhausted pool). Not an error — callers skip cleanly.
        | "NO_FEED_ITEMS_AVAILABLE";
      message?: string;
    };

// ─── Minimal DB interface for testability ─────────────────────────────────────
// Mirrors the pattern in generate-post-image.service.ts: the real Prisma client
// satisfies this narrow shape, and unit tests inject a fake that captures writes.

export interface GenerateDraftPostDb {
  post: {
    findMany: (args: {
      where: { companyId: string; channel: SocialChannel };
      orderBy: { createdAt: "desc" };
      take: number;
      select: { id: true; content: true; promptSnapshot: true };
    }) => Promise<Array<{ id: string; content: string; promptSnapshot: Prisma.JsonValue | null }>>;
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
  /** Best-effort semantic-gate calibration write (Phase 1.5). Injected in tests. */
  recordCalibration?: (input: SemanticCalibrationInput) => Promise<void>;
  /**
   * Semantic-duplicate gate (Phase 1.4). Injected in tests; in production a
   * real one is built per company+channel from the embedding provider + store.
   */
  semanticGate?: SemanticGate;
}

// ─── Service ───────────────────────────────────────────────────────────────────

export interface GeneratePostOptions {
  contentLanguage?: string;
  /** Acting user; omitted for system-generated (cron) posts. */
  generatedById?: string;
  /** Weekly schedule this post belongs to (cron generation only). */
  scheduleId?: string;
  scheduledFor?: Date;
  /** Defaults to "draft" (user flow). Cron generation uses "pending_approval". */
  initialStatus?: "draft" | "pending_approval";
  /**
   * Manual per-generation source-link override (v2-1). Undefined = inherit
   * from the content source preference, then the channel default.
   */
  includeSourceLinkOverride?: boolean;
}

export async function generateDraftPost(
  slug: string,
  rawChannel: string,
  userId: string,
  isGlobalAdmin: boolean,
  options: Pick<GeneratePostOptions, "contentLanguage" | "includeSourceLinkOverride"> = {}
): Promise<GenerateDraftPostResult> {
  // Build context (also validates auth/access)
  const contextResult = await buildGenerationContext(slug, rawChannel, userId, isGlobalAdmin);
  if (!contextResult.success) {
    return { success: false, code: contextResult.code };
  }

  return generatePostFromContext(contextResult.context, contextResult.companyId, {
    contentLanguage: options.contentLanguage,
    includeSourceLinkOverride: options.includeSourceLinkOverride,
    generatedById: userId,
  });
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
  const recordCalibration = deps.recordCalibration ?? recordSemanticCalibration;
  const { contentLanguage, generatedById, scheduleId, scheduledFor } = options;
  const initialStatus = options.initialStatus ?? "draft";

  // ── Fetch recent posts before generation ──────────────────────────────────
  // Used both as prompt context (avoid repetition) and for duplicate detection after.
  const recentRows = await db.post.findMany({
    where: { companyId, channel: context.channel.channel as SocialChannel },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, content: true, promptSnapshot: true },
  });

  // Extract diversity signals from promptSnapshot (most-recent-first) — absent on legacy posts.
  const snapshots = recentRows.map((r) => r.promptSnapshot as Record<string, unknown> | null);

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

  const recentTopics: string[] = snapshots
    .map((s) => s?.topic)
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .slice(0, 8);

  const initialAngle = selectAngle(recentAngles);
  const initialPattern = selectPattern(recentPatterns);

  // ── LLM provider ─────────────────────────────────────────────────────────
  // Created before aspect mining so the same provider handles both extraction and generation.
  const llmProviderStr = context.llm.provider;
  const llmModelStr = context.llm.model;

  let provider: ILlmProvider;
  if (process.env.AI_MOCK_MODE === "true") {
    const mockText = MOCK_LLM_TEXT;
    provider = { generate: async () => ({ text: mockText }) };
  } else {
    try {
      provider = getLlmProvider();
    } catch (err) {
      if (err instanceof NoActiveLlmProviderError) {
        return { success: false, code: "NO_ACTIVE_PROVIDER", message: err.message };
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
  const articleCandidateIds = context.feedItems.filter(isConsumableItem).map((f) => f.id);
  const hasEvergreenItems = context.feedItems.some((f) => !isConsumableItem(f));
  const plan = await planFeedItemUsage(
    articleCandidateIds,
    context.hasArticleSources,
    hasEvergreenItems,
    db
  );
  if (plan.action === "skip") {
    // Article sources are configured but every eligible article is already used
    // (or a concurrent run claimed the last candidate) and no evergreen item is
    // available. Not an error — the caller skips.
    return { success: false, code: "NO_FEED_ITEMS_AVAILABLE" };
  }

  let claimedFeedItemId: string | null = null;
  if (plan.action === "generate") {
    claimedFeedItemId = plan.feedItemId;
    // Promote the claimed article to primary so the prompt, aspect mining and
    // appended source URL are all built around the reserved item.
    const claimedId = plan.feedItemId;
    const claimed = context.feedItems.find((f) => f.id === claimedId)!;
    const others = context.feedItems.filter((f) => f.id !== claimedId);
    context = { ...context, feedItems: [claimed, ...others] };
  } else if (plan.action === "evergreen") {
    // Reusable prompt/calendar content. Restrict the context to evergreen items
    // so the post is built purely around them — this also drops any article that
    // was claimable at build time but raced away, so it can never leak in as the
    // primary. primaryFeedItemId stays null, so the item is never consumed.
    const evergreen = context.feedItems.filter((f) => !isConsumableItem(f));
    context = { ...context, feedItems: evergreen };
  }
  // plan.action === "mission": no sources — primaryFeedItemId stays null and the
  // existing no-source mission/brand post path is used.

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
  } = await resolveGenerationAspect({
    feedItems: context.feedItems,
    snapshots,
    provider,
  });

  // ── Build prompts ─────────────────────────────────────────────────────────
  const { systemPrompt, userPrompt } = buildPrompts(
    context,
    contentLanguage,
    recentRows.slice(0, 5).map((r) => ({ text: r.content })),
    { angle: initialAngle, pattern: initialPattern, recentTopics, aspect: initialAspect }
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
    generationResult = await generateWithRetry(
      provider,
      systemPrompt,
      userPrompt,
      recentRows.map((r) => ({ id: r.id, text: r.content })),
      {
        initialAngle,
        recentAngles,
        initialPattern,
        recentPatterns,
        recentTopics,
        initialAspect,
        aspectPool,
        aspectUsedIds: usedAspectIds,
      },
      semanticGate
    );
  } catch (err) {
    await releaseClaimedFeedItem();
    if (err instanceof LlmProviderError) {
      return { success: false, code: "LLM_PROVIDER_ERROR", message: err.message };
    }
    if (err instanceof LlmResponseParseError) {
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
    attempts,
    selectedAngle,
    selectedPattern,
    selectedAspect,
  } = generationResult;

  const safetyResult = checkContentSafety({
    text: parsed.text,
    brandForbiddenWords: context.brand?.forbiddenWords ?? [],
  });

  // Every attempt stayed at/above the regenerate threshold — the post is a
  // semantic duplicate we could not shake off. Save it, but force human review.
  const semanticExhausted = semanticResult.decision === "regenerate";

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
      // Warning: all attempts remained too similar; held for approval below.
      warning: semanticExhausted,
    },
  };

  // ── Source link (v2-1) ────────────────────────────────────────────────────
  // The URL is appended programmatically — never by the LLM. The primary feed
  // item is selected BEFORE the prompt is built (buildPrompts uses the same
  // selectPrimaryFeedItem) and the model is instructed to base the post on it,
  // so the appended URL and the generated text always refer to the same article.
  const sourceLinkResult = resolvePostSourceLink({
    feedItems: context.feedItems,
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
  // For manual generation (draft) on a fully_automated channel, skip the
  // approval queue so the post is immediately publishable. Safety-flagged posts
  // are always held for human review regardless of mode. A semantic duplicate
  // that survived every attempt is likewise ALWAYS held for approval — even on
  // fully automated channels — so a human can decide whether it is too similar.
  const effectiveMode = context.channel.automationModeOverride ?? context.company.automationMode;
  const autoApproved =
    initialStatus === "draft" &&
    effectiveMode === "fully_automated" &&
    !safetyResult.flagged &&
    !semanticExhausted;
  const resolvedStatus: "draft" | "pending_approval" | "approved" = autoApproved
    ? "approved"
    : semanticExhausted
      ? "pending_approval"
      : initialStatus;
  const approvedAt = autoApproved ? new Date() : null;

  // ── Save post ─────────────────────────────────────────────────────────────
  const feedItemIds = context.feedItems.map((f) => f.id);

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
      status: resolvedStatus,
      approvedAt,
      content: finalContent,
      hashtags: parsed.hashtags,
      imagePrompt: parsed.imagePrompt ?? null,
      notes: parsed.notes ?? null,
      llmProvider: llmProviderStr,
      llmModel: llmModelStr,
      generatedById: generatedById ?? null,
      scheduleId: scheduleId ?? null,
      scheduledFor: scheduledFor ?? null,
      safetyFlagged: safetyResult.flagged,
      safetyFlagReason: safetyResult.flagged
        ? `Flagged terms: ${safetyResult.matchedTerms.join(", ")}`
        : null,
      promptSnapshot: {
        systemPrompt,
        userPrompt,
        provider: llmProviderStr,
        model: llmModelStr,
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
      ...(autoApproved ? { autoApproved: true } : {}),
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
      postCreatedAt: post.createdAt,
    });
  } catch (err) {
    console.error(
      `[embed] Post ${post.id} embedding failed (non-fatal):`,
      err instanceof Error ? err.message : err
    );
  }

  const warnings: GenerationWarnings = {
    duplicate: duplicateResult,
    safety: safetyResult,
    semanticDuplicate: {
      decision: semanticResult.decision,
      topSimilarity: semanticResult.topSimilarity,
      matchedPostId: semanticResult.matchedPostId,
      exhausted: semanticExhausted,
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
      createdAt: post.createdAt,
    },
    warnings,
  };
}
