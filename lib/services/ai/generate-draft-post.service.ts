import { prisma } from "@/lib/db/client";
import { Prisma, type SocialChannel, type LlmProvider } from "@prisma/client";
import { buildGenerationContext } from "./build-generation-context.service";
import { resolveGenerationAspect } from "./resolve-generation-aspect.service";
import type { GenerationContext, ILlmProvider } from "@/lib/ai/types";
import { buildPrompts, type SharedTopicConstraint } from "@/lib/ai/prompt-builder";
import { resolveLlmSelection } from "./resolve-llm-selection.service";
import {
  buildSupportedProvider,
  ProviderNotAvailableError,
} from "@/lib/ai/llm/supported-providers";
import { LlmProviderError, LlmRateLimitError, LlmResponseParseError } from "@/lib/ai/errors";
import {
  generateWithRetry,
  MAX_GENERATION_ATTEMPTS,
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
  planPinnedFeedItem,
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
import { GenerationTracer } from "@/lib/generation-trace/tracer";
import {
  deriveTrigger,
  recordAttemptSteps,
  recordFeedItemArtifactSteps,
  recordImageStep,
  type PostGenerationTraceOrigin,
} from "@/lib/generation-trace/post-generation-steps";
import {
  loadCandidateFacts,
  loadFeedItemArtifacts,
} from "@/lib/generation-trace/feed-item-artifacts";
import { excerpt } from "@/lib/generation-trace/redact";
import { observeProvider } from "@/lib/generation-trace/observed-provider";

// ─── Mock response ─────────────────────────────────────────────────────────────

// A rich, realistic fixture: a debunked misconception, a contrast opening, 3
// list-style points and several CTAs. Only the absence of a banned term is what
// actually gets it past the compliance gate — the angle/hook/structure/CTA are
// no longer verified — but the shape is kept so mock output still looks like a
// real post to anything downstream that reads it.
const MOCK_LLM_TEXT = JSON.stringify({
  text:
    "Most people assume a team should stay quiet before a launch. Actually, building in the open is what earns trust — while the silent approach loses it.\n" +
    "1. A first look drops this week.\n" +
    "2. Early access opens right after.\n" +
    "3. The full rollout lands next month.\n" +
    "Follow us, share this with a friend, visit our website, and comment your thoughts below — what would you want to see first?",
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
   * for one. Echoed from the caller's option rather than read back — nothing
   * between here and the insert can change it.
   */
  scheduledFor: Date | null;
  /**
   * Whether that slot is a promise a person made rather than the weekly filler's
   * estimate — mirrors `PostItem.manuallyScheduled`, so the client can render
   * the new card's schedule panel straight from this response with no refetch.
   */
  manuallyScheduled: boolean;
  /** The bulk run this post belongs to; null for a single manual generation. */
  generationBatchId: string | null;
  /** The content topic this post is one channel's version of; null when ungrouped. */
  contentGroupId: string | null;
  /**
   * The article this post was written from, or null for a mission/evergreen
   * post. Returned — rather than left to a read-back — because it is what a
   * multi-channel orchestrator PINS the topic's remaining channels to, and the
   * two must be the same value by construction, not by a second query.
   */
  primaryFeedItemId: string | null;
  /**
   * This post's central claim, and the normalized topic it declared. Together
   * they are the topic itself: what the sibling channels of the same content
   * group are told to adapt rather than replace (see SharedTopicConstraint).
   */
  coreMessage: string;
  topic: string | null;
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
  // Every retry was exhausted and the final candidate still broke a hard
  // content rule — in practice, a banned term. Distinct from
  // CANNOT_GENERATE_UNIQUE_POST: the post may be perfectly unique and perfectly
  // on-pattern, it just contains something that must never be published. The
  // post's angle/hook/structure/CTA can NOT trigger this — they are generation
  // guidance and are not gated (see lib/ai/quality/generation-compliance.ts).
  | "POST_FAILED_COMPLIANCE"
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
   * Set only for POST_FAILED_COMPLIANCE — the rules the final candidate still
   * broke, verbatim from the gate (e.g. 'The word "Стоп" is not allowed
   * anywhere in the post…').
   */
  complianceReasons?: string[];
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
      // NOT.contentGroupId excludes THIS run's own sibling channels (see
      // runGeneration below) — a Facebook post generated moments ago for the
      // same content group must never be compared as if it were history.
      where: { companyId: string; channel: SocialChannel; NOT?: { contentGroupId: string } };
      orderBy: { createdAt: "desc" };
      take: number;
      select: {
        id: true;
        content: true;
        promptSnapshot: true;
        imagePrompt: true;
        channel: true;
        contentGroupId: true;
        primaryFeedItemId: true;
        createdAt: true;
      };
      // imagePrompt is optional in the row so existing fakes (and legacy posts,
      // which have none) stay valid — it only feeds the visual-diversity block.
    }) => Promise<
      Array<{
        id: string;
        content: string;
        promptSnapshot: Prisma.JsonValue | null;
        imagePrompt?: string | null;
        // The four below are optional in the row for the same reason imagePrompt
        // is: existing fakes built before this diagnostic existed still compile
        // and still work, they just log an "unknown" match classification.
        channel?: SocialChannel;
        contentGroupId?: string | null;
        primaryFeedItemId?: string | null;
        createdAt?: Date;
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
   * The duplicate-aware generation loop.
   *
   * Injected for the same reason `semanticGate` is: what this function HANDS the
   * loop is a decision of its own, and the mock provider cannot express it — its
   * canned response declares no topic, so Topic Memory can never fire through
   * it. Wrapping the real loop is how a test observes whether a sibling channel
   * is judged against a memory the prompt already told it to ignore.
   */
  generateWithRetry?: typeof generateWithRetry;
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
  /**
   * The generation trace recorder. Injected in tests so the steps a run produced
   * can be read back without a database; production starts its own.
   *
   * Observation only — nothing in this file branches on it, and every one of its
   * methods swallows its own failures. See lib/generation-trace/tracer.ts.
   */
  tracer?: GenerationTracer;
  /** Article translation/classification/extraction state, for the trace. Injected in tests. */
  loadFeedItemArtifacts?: typeof loadFeedItemArtifacts;
  /** Candidate eligibility/priority, for the trace. Injected in tests. */
  loadCandidateFacts?: typeof loadCandidateFacts;
}

// ─── Service ───────────────────────────────────────────────────────────────────

export interface GeneratePostOptions {
  contentLanguage?: string;
  /** Acting user; omitted for system-generated (cron) posts. */
  generatedById?: string;
  /** Weekly schedule this post belongs to (cron generation only). */
  scheduleId?: string;
  /**
   * When this post is due to go out.
   *
   * Who set it decides how it is honoured, and that is read off `scheduleId`
   * rather than asked for separately: cron always passes one and never lets a
   * person near the time, every other caller passes none and only ever gets a
   * time because a person named it. See the `manuallyScheduled` write below.
   */
  scheduledFor?: Date;
  /**
   * The manual bulk run this post belongs to — one id shared by every post of
   * one bulk request (see bulk-generate-posts.service.ts). Undefined for single
   * manual generation and for cron, which have no batch.
   *
   * Purely an association: it changes nothing about how the post is generated,
   * reviewed, scheduled or published. What the publisher reads is
   * `manuallyScheduled`, which is written from `scheduledFor`/`scheduleId` and
   * is true for a bulk post because a person named its time, not because it
   * belongs to a batch.
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
  /**
   * The content TOPIC this post is one channel's version of — shared by every
   * channel generated from the same topic in the same request.
   *
   * Purely an association, exactly like `generationBatchId` and deliberately
   * separate from it: it changes nothing about how the post is generated,
   * reviewed, scheduled or published. Undefined for single-channel generation
   * and for cron, whose posts are ungrouped.
   */
  contentGroupId?: string;
  /**
   * Write from THIS article, which the topic's first channel already claimed.
   *
   * Set only for the second and later channels of a content group. It replaces
   * the whole source-selection pipeline — no scope resolution, no availability
   * check, no reservation — because the topic has already answered every one of
   * those questions. Critically, a generation that fails here does NOT release
   * the claim: it never owned it (see the release rule below).
   */
  pinnedFeedItemId?: string;
  /**
   * The central claim this channel version must adapt rather than replace. Set
   * alongside `pinnedFeedItemId` for article-backed topics, and on its own for
   * mission/evergreen topics, which have no article to pin but still have a
   * topic — that is what makes a group of company-content posts one story
   * instead of three.
   */
  sharedTopic?: SharedTopicConstraint;
  /**
   * What the caller knows about this generation that the options above cannot
   * express — chiefly WHO asked (a bulk run and a cron run look alike from in
   * here) and how the article window was chosen.
   *
   * Purely descriptive: nothing in the pipeline reads it, and omitting it costs
   * only detail in the trace, never behaviour.
   */
  trace?: PostGenerationTraceOrigin;
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
    // Multi-channel generation only. A group id is an association; the pinned
    // item and shared topic are what make the sibling channels versions of ONE
    // topic rather than three independent posts about one feed.
    | "contentGroupId"
    | "pinnedFeedItemId"
    | "sharedTopic"
    | "contentSourceId"
    // Descriptive only — who asked and through which job. Forwarded to the trace.
    | "trace"
  > & {
    /**
     * The form's "Content source" choice, as it came off the wire. Omitted =
     * company rules, i.e. the pooled behaviour this flow has always had.
     */
    contentSource?: ManualContentSourceRef;
  } = {}
): Promise<GenerateDraftPostResult> {
  // A sibling channel version writes from an article the topic already chose, so
  // every question the block below answers — which kind of source, is it still
  // usable, what may the window contain — has already been answered once, for
  // the whole group. Re-asking them here is not merely wasteful: the item is
  // `usedInPost` by now, so the ordinary window would refuse it and the sibling
  // would quietly write about a different article.
  const pinnedFeedItemId = options.pinnedFeedItemId ?? null;

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
  if (pinnedFeedItemId) {
    // Not a pick at all — the topic already made it. Held as `company_rules` so
    // the branches below that ask "did the user name a source" all answer no,
    // which is true: the caller named an ARTICLE, and it does so through the
    // scope instead. Quota attribution still arrives explicitly, via
    // options.contentSourceId.
    selection = { kind: "company_rules" };
  } else if (ref.kind === "source") {
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
    // A sibling channel's window is the ONE article its topic claimed, with the
    // `usedInPost` filter dropped — see the `feed_item` scope.
    pinnedFeedItemId
      ? { kind: "feed_item", feedItemId: pinnedFeedItemId }
      : toSourceScope(selection)
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
    // Multi-channel generation only.
    contentGroupId: options.contentGroupId,
    pinnedFeedItemId: pinnedFeedItemId ?? undefined,
    sharedTopic: options.sharedTopic,
    // The picked source, recorded on the post as a durable FK. For a direct
    // content-source post this is the ONLY relation back to what it was written
    // from — primaryFeedItemId stays null because nothing was reserved. It can
    // never disturb the content mix: the scheduler counts only posts carrying
    // its own scheduleId, and a manual post has none.
    //
    // A sibling channel is handed it outright: its `selection` is deliberately
    // not a pick (the topic chose), so the group's quota attribution has to
    // travel with the instruction rather than be re-derived from it.
    contentSourceId: isPickedSource(selection) ? selection.sourceId : options.contentSourceId,
    // Everything the trace can only learn HERE: which source the form picked and
    // how the article window was ordered. The trigger is left to the caller, or
    // derived — a group id already means "manual multi-channel", a batch id
    // "bulk", a schedule id "cron" (see deriveTrigger).
    trace: {
      trigger: options.trace?.trigger,
      jobId: options.trace?.jobId,
      priority: contextResult.priority,
      contentSourceRef: ref,
    },
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

/**
 * What each source decision means, in the words a reader of the trace needs.
 *
 * The plan itself is one word (`generate`, `skip`, `pinned`, …) and the timeline
 * shows it, but "why is this post about THAT article" is the question being
 * asked — so the sentence lives beside the word rather than in someone's head.
 */
const SELECTION_REASON: Record<FeedItemPlan["action"], string> = {
  generate: "An unused article was available and was claimed for this post.",
  pinned: "Written from the article this content group's first channel already claimed.",
  evergreen:
    "No claimable article was available, but a reusable prompt/calendar item was — it is never consumed.",
  direct:
    "A specific non-RSS source was picked, so its stored extraction was read directly and nothing was claimed.",
  mission:
    "The company has no article source for this window, so the post was written from brand knowledge alone.",
  skip: "Article sources exist but every eligible article was already used (or raced away), and no evergreen item was available.",
};

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
 *
 * ── The trace wrapper ───────────────────────────────────────────────────────
 *
 * Every generation in the product reaches this function — the manual form, a
 * multi-channel topic, a bulk batch and the weekly cron all end up here — so it
 * is the one place a trace can be opened and closed for all of them, rather than
 * five places that must be kept in step.
 *
 * The wrapper exists purely so `flush()` happens in a `finally`. The body below
 * has a dozen early returns (no articles left, provider misconfigured, rate
 * limited, not unique enough, too long with its URL) and every one of them is a
 * run somebody will want to read — "why did this produce nothing" being the
 * commonest question a trace is opened for. A flush per return would be a dozen
 * chances to forget one.
 */
export async function generatePostFromContext(
  context: GenerationContext,
  companyId: string,
  options: GeneratePostOptions = {},
  deps: GenerateDraftPostDeps = {}
): Promise<GenerateDraftPostResult> {
  const tracer =
    deps.tracer ??
    GenerationTracer.start({
      kind: "post_generation",
      trigger: options.trace?.trigger ?? deriveTrigger(options),
      companyId,
      channel: context.channel.channel,
      language: options.contentLanguage ?? context.channel.postingLanguage,
      userId: options.generatedById ?? null,
      contentGroupId: options.contentGroupId ?? null,
      generationBatchId: options.generationBatchId ?? null,
      scheduleId: options.scheduleId ?? null,
      jobId: options.trace?.jobId ?? null,
      options: {
        contentLanguage: options.contentLanguage ?? null,
        initialStatus: options.initialStatus ?? "draft",
        scheduledFor: options.scheduledFor ?? null,
        includeSourceLinkOverride: options.includeSourceLinkOverride ?? null,
        autoGenerateImageOverride: options.autoGenerateImageOverride ?? null,
        llmConfigId: options.llmConfigId ?? null,
        preferredLlmConfigId: options.preferredLlmConfigId ?? null,
        contentSourceId: options.contentSourceId ?? null,
        pinnedFeedItemId: options.pinnedFeedItemId ?? null,
        sharedTopic: options.sharedTopic ?? null,
        contentSource: options.trace?.contentSourceRef ?? null,
      },
    });

  try {
    const result = await runGeneration(context, companyId, options, deps, tracer);
    if (!result.success) tracer.fail(result.code, result.message ?? null);
    return result;
  } catch (err) {
    // A throw out of here is a genuine fault (the database being unreachable),
    // not one of the classified failures above. Recorded and re-thrown unchanged.
    tracer.fail("UNEXPECTED_ERROR", err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    await tracer.flush();
  }
}

async function runGeneration(
  context: GenerationContext,
  companyId: string,
  options: GeneratePostOptions,
  deps: GenerateDraftPostDeps,
  tracer: GenerationTracer
): Promise<GenerateDraftPostResult> {
  /**
   * Whether the time this post is being given is a person's promise.
   *
   * Derived rather than passed, because there is exactly one automated
   * scheduler and it is the one that owns `scheduleId`: cron sets both fields,
   * every other caller (bulk, the generation form, a multi-channel topic run)
   * sets a time only because somebody picked one. Deriving it here means no
   * caller can schedule a post and forget to say whose time it is — which would
   * be silent, and would hand the post to the publisher's 48-hour look-ahead.
   */
  const manuallyScheduled = options.scheduledFor != null && options.scheduleId == null;

  const db: GenerateDraftPostDb = deps.db ?? prisma;
  const auditLog = deps.auditLog ?? createAuditLog;
  const embed = deps.embed ?? embedPost;
  const autoImage = deps.autoImage ?? autoGeneratePostImage;
  const autoSourceImage = deps.autoSourceImage ?? autoApplySourceImage;
  const recordCalibration = deps.recordCalibration ?? recordSemanticCalibration;
  const runGenerationLoop = deps.generateWithRetry ?? generateWithRetry;
  /**
   * The trace's own extra reads — candidate eligibility and the article's
   * translation/classification state.
   *
   * Gated on the tracer being armed, and that is not merely an optimisation. A
   * disabled tracer writes nothing, so these two queries would buy exactly
   * nothing while still costing two round trips per generation — and, where
   * there is no database at all (a unit test injecting fake deps, an
   * environment with no DATABASE_URL), costing a connection timeout instead.
   * Tracing that is switched off must cost zero.
   */
  const readArtifacts =
    deps.loadFeedItemArtifacts ?? (tracer.enabled ? loadFeedItemArtifacts : null);
  const readCandidateFacts =
    deps.loadCandidateFacts ?? (tracer.enabled ? loadCandidateFacts : null);
  const { contentLanguage, generatedById, scheduleId, scheduledFor } = options;
  const initialStatus = options.initialStatus ?? "draft";

  // ── Trace: the request ────────────────────────────────────────────────────
  // First step of every run, and the only one that is always present: who asked,
  // for what, and with which options. Written before anything can fail, so even a
  // run that dies at provider resolution has a readable head.
  tracer.step({
    type: "request",
    label: "Generation requested",
    input: {
      companyId,
      channel: context.channel.channel,
      contentLanguage: contentLanguage ?? null,
      resolvedPostingLanguage: context.channel.postingLanguage,
      requestedBy: generatedById ?? null,
      automated: generatedById === undefined,
      initialStatus,
      scheduledFor: scheduledFor ?? null,
      manuallyScheduled,
    },
    metadata: {
      contentGroupId: options.contentGroupId ?? null,
      generationBatchId: options.generationBatchId ?? null,
      scheduleId: scheduleId ?? null,
      jobId: options.trace?.jobId ?? null,
      pinnedFeedItemId: options.pinnedFeedItemId ?? null,
      sharedTopic: options.sharedTopic ?? null,
      contentSource: options.trace?.contentSourceRef ?? null,
    },
  });

  // ── Fetch recent posts before generation ──────────────────────────────────
  // Used both as prompt context (avoid repetition) and for duplicate detection
  // after. Topic Memory needs a wider window (30) than the diversity/Jaccard
  // signals (10), so we fetch 30 and slice the first 10 for the rest.
  //
  // Already scoped to THIS channel alone — a Facebook post never enters an
  // Instagram generation's pool, because the two have different `channel`
  // values. `NOT contentGroupId` is a second, narrower exclusion on top of
  // that: it drops this run's OWN siblings (this matters for a channel that
  // gets a SECOND look at the same topic — the sibling second-pass in
  // generate-topic-across-channels.service.ts — and is cheap insurance against
  // ever comparing a candidate to a post generated moments ago for the exact
  // same story). A LATER, independent generation that happens to reuse the
  // same article gets a NEW contentGroupId, so it is never exempted by this —
  // only this run's own siblings are.
  const recentRows = await db.post.findMany({
    where: {
      companyId,
      channel: context.channel.channel as SocialChannel,
      ...(options.contentGroupId ? { NOT: { contentGroupId: options.contentGroupId } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: TOPIC_MEMORY_SIZE,
    // imagePrompt rides along on the query that was already being made: it is
    // what the recent IMAGES looked like, which the post text cannot express.
    // channel/contentGroupId/primaryFeedItemId/createdAt feed the
    // [jaccard_duplicate] diagnostic only — classifying a flagged match as a
    // sibling or a genuine historical duplicate without a second query.
    select: {
      id: true,
      content: true,
      promptSnapshot: true,
      imagePrompt: true,
      channel: true,
      contentGroupId: true,
      primaryFeedItemId: true,
      createdAt: true,
    },
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

  /**
   * Topic Memory as the GENERATION LOOP sees it — empty for a sibling channel.
   *
   * `buildPrompts` already drops the "subjects to avoid" list when `sharedTopic`
   * is set, because "cover something else" and "cover exactly this" cannot both
   * hold. The judge has to follow the same rule, and used not to: the loop still
   * received the full memory, so `isTopicRepeated` could reject a sibling for
   * producing the very topic it was ORDERED to produce. Each retry then asked it
   * to "choose a MEANINGFULLY DIFFERENT conceptual topic" — the exact opposite of
   * the mandatory constraint in the same prompt — so the model could only obey
   * one of them. Three attempts later the channel aborted with
   * CANNOT_GENERATE_UNIQUE_POST / topic_repeated, and a multi-channel request
   * quietly came back with fewer posts than channels.
   *
   * Only Topic Memory is waived, and only for a dictated topic. Jaccard and the
   * semantic gate still run in full: those compare the candidate's TEXT and its
   * central claim against this channel's own posts, and a sibling that comes back
   * near-verbatim to something already published here is a real duplicate that
   * must still be refused.
   */
  const loopTopicMemory = options.sharedTopic ? [] : topicMemory;

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
  tracer.setLlm(llmProviderStr, llmModelStr);

  let provider: ILlmProvider;
  if (isMock) {
    provider = mockProvider;
  } else {
    try {
      const built = buildSupportedProvider(selection.provider);
      provider = built.instance;
      llmModelStr = built.model;
      tracer.setLlm(llmProviderStr, llmModelStr);
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
  const plan: FeedItemPlan = options.pinnedFeedItemId
    ? // A sibling channel version: the article is named, was claimed once by this
      // topic's first channel, and is claimed again by nobody.
      planPinnedFeedItem(options.pinnedFeedItemId, context.feedItems)
    : context.directContentSource
      ? planDirectContentSource(context.feedItems)
      : await planFeedItemUsage(
          articleCandidateIds,
          context.hasArticleSources,
          hasEvergreenItems,
          db
        );
  // ── Trace: which article, out of which window, and why ────────────────────
  // Recorded for the skip path too — "nothing was left to write from" is a real
  // answer, and the candidate tally is exactly what makes it checkable.
  const candidateFacts = (await readCandidateFacts?.(context.feedItems.map((f) => f.id))) ?? [];
  const factsById = new Map(candidateFacts.map((f) => [f.id, f]));
  tracer.step({
    type: "selection",
    label: `Source selection — ${plan.action}`,
    status: plan.action === "skip" ? "failed" : "success",
    input: {
      // The window as it was offered, in the order priority put it. Text is
      // deliberately excluded — the chosen article's is in the source step, and
      // the rest were never sent anywhere.
      candidates: context.feedItems.map((item) => ({
        feedItemId: item.id,
        title: item.title,
        url: item.publicUrl ?? item.url,
        sourceType: item.sourceType ?? null,
        sourceName: item.sourceName ?? null,
        publishedAt: item.publishedAt,
        consumable: item.consumable !== false,
        classification: factsById.get(item.id)?.classification ?? null,
        primaryTopic: factsById.get(item.id)?.primaryTopic ?? null,
        classificationReason: factsById.get(item.id)?.reason ?? null,
        alreadyUsed: factsById.get(item.id)?.usedInPost ?? null,
        enabled: factsById.get(item.id)?.enabled ?? null,
      })),
    },
    output: {
      decision: plan.action,
      // Named only by the two plans that name one. `direct` and `evergreen`
      // resolve their item a few lines below (resolvePrimarySelection), and the
      // source step records THAT — the authoritative answer for every plan.
      claimedFeedItemId: "feedItemId" in plan ? plan.feedItemId : null,
      reason: SELECTION_REASON[plan.action],
    },
    metadata: {
      candidateCount: context.feedItems.length,
      articleCandidateCount: articleCandidateIds.length,
      hasEvergreenItems,
      hasArticleSources: context.hasArticleSources,
      directContentSource: context.directContentSource === true,
      pinnedFeedItemId: options.pinnedFeedItemId ?? null,
      // How the window was ordered and what it withheld — the diagnostic
      // buildGenerationContext already produces (HIGH/MEDIUM/unclassified counts
      // and, when no HIGH was offered, why not).
      priority: options.trace?.priority ?? null,
    },
  });

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

  // ── Which claim is OURS to give back ──────────────────────────────────────
  // `claimedFeedItemId` is what the post RECORDS. This is what this generation
  // OWNS. They are the same thing for every generation that reserved its own
  // article, and deliberately different for a sibling channel version: the
  // article was claimed once, by the topic, and a sibling that fails must leave
  // it exactly as it found it.
  //
  // Releasing it here would be the worst kind of bug — silent and delayed: the
  // article would go back in the pool while its first channel's post still
  // points at it, and a later generation would write a second post about a
  // story the company has already published.
  const ownedClaimId = options.pinnedFeedItemId ? null : claimedFeedItemId;

  // Frees the claimed article if generation fails before the post is persisted.
  const releaseClaimedFeedItem = async () => {
    if (ownedClaimId) await releaseFeedItem(ownedClaimId, db);
  };

  // ── Trace: the source, and what it had already been through ───────────────
  // Only written when there IS a source. A mission/brand post has none, and a
  // trace that showed an empty "Source" row for it would be inventing a stage
  // that never ran — the same reason a manually entered prompt gets no
  // translation step below.
  if (primary.item) {
    const item = primary.item;
    tracer.step({
      type: "source",
      label: `${item.sourceType ?? "source"} — ${item.sourceName ?? "unnamed"}`,
      output: {
        feedItemId: item.id,
        sourceType: item.sourceType ?? null,
        sourceName: item.sourceName ?? null,
        title: item.title,
        url: item.url,
        publicUrl: item.publicUrl ?? null,
        publishedAt: item.publishedAt,
        sourceImageUrl: item.sourceImageUrl ?? null,
        // The text as generation resolved it — already the translation when one
        // completed, already the extraction for an instructed product page. This
        // is the content the prompt was built from, so it is stored here in full
        // rather than as a pointer at a row that can be re-translated later.
        content: item.content,
      },
      metadata: {
        contentChars: item.content?.length ?? 0,
        usedTranslation: item.usedTranslation === true,
        consumable: item.consumable !== false,
        claimedByThisRun: ownedClaimId !== null,
        pinnedByContentGroup: options.pinnedFeedItemId !== undefined,
        extractionStatus: item.extractionStatus ?? null,
        sourceLinkPreference: item.sourceLinkPreference ?? null,
      },
    });

    // Translation / classification / extraction. Each is a REFERENCE to the run
    // that performed it plus the verdict as it stood now — see
    // lib/generation-trace/feed-item-artifacts.ts for why it is not a copy.
    recordFeedItemArtifactSteps(tracer, item, (await readArtifacts?.(item.id)) ?? null);
  }

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
      // The OBSERVED provider, so aspect mining's own LLM call — its exact
      // prompt and its exact reply — reaches the trace without the miner (two
      // modules deep, and shared with the prompt preview) learning that tracing
      // exists. The generation loop below gets the bare instance; it reports its
      // attempts itself, with far more context.
      provider: observeProvider(provider, (call) => {
        tracer.step({
          type: "llm_call",
          label: "Aspect mining",
          status: call.error ? "failed" : "success",
          startedAt: call.startedAt,
          completedAt: call.completedAt,
          durationMs: call.durationMs,
          input: { systemPrompt: call.systemPrompt, userPrompt: call.userPrompt },
          metadata: { request: call.request, providerPayload: call.responseRaw ?? null },
          error: call.error ? `${call.error.name}: ${call.error.message}` : undefined,
        });
        if (call.responseText !== null) {
          tracer.step({
            type: "raw_response",
            label: "Aspect mining",
            output: { text: call.responseText },
            metadata: { chars: call.responseText.length },
          });
        }
      }),
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
      // Set only for the second and later channels of a content group. The
      // prompt builder suppresses `recentTopics` when it is present, since
      // "cover something else" and "cover exactly this" cannot both hold.
      sharedTopic: options.sharedTopic,
    }
  );

  // ── Trace: everything the prompt was built FROM ───────────────────────────
  // The single most important step in the trace, and the reason the whole table
  // exists: brand guidelines, channel settings, the article window and the
  // diversity levers are all live configuration that will be edited, and this is
  // the copy that says what they were AT THIS MOMENT. Nothing here is re-read
  // later — a trace that resolved these through relations would silently rewrite
  // the history of every post whenever somebody changed the tone of voice.
  tracer.step({
    type: "context",
    label: "Generation context",
    output: {
      company: context.company,
      brandGuidelines: context.brand,
      channelSettings: context.channel,
      language: {
        requested: contentLanguage ?? null,
        channelPosting: context.channel.postingLanguage,
        companyDefault: context.company.defaultLang,
      },
      // The full window, with the resolved text. The primary is repeated from
      // the source step on purpose: the prompt saw all of these, and which of
      // them is background is part of what a reader is checking.
      sourceContent: context.feedItems.map((item) => ({
        feedItemId: item.id,
        isPrimary: item.id === primary.item?.id,
        title: item.title,
        url: item.publicUrl ?? item.url,
        contentExcerpt: excerpt(item.content, 1200),
        contentChars: item.content?.length ?? 0,
        usedTranslation: item.usedTranslation === true,
      })),
      // What the model was shown of its own recent output, and what it was told
      // not to repeat.
      recentPosts: recentRows10.slice(0, 5).map((r) => ({
        postId: r.id,
        textExcerpt: excerpt(r.content, 400),
        imagePrompt: r.imagePrompt ?? null,
      })),
      topicMemory,
      // Empty for a sibling channel — it was ORDERED to repeat the topic, so the
      // avoid-list is deliberately withheld from both the prompt and the judge.
      topicMemoryAppliedToJudge: loopTopicMemory,
      sharedTopic: options.sharedTopic ?? null,
      // The levers this generation opened with. A retry may change all three;
      // each attempt records the ones it actually used.
      contentAngle: initialAngle,
      contentPattern: initialPattern
        ? {
            hookType: initialPattern.hookType,
            structure: initialPattern.structure,
            ctaType: initialPattern.ctaType,
          }
        : null,
      selectedAspect: initialAspect ?? null,
    },
    metadata: {
      recentPostsConsidered: recentRows.length,
      topicMemorySize: topicMemory.length,
      recentAngles,
      recentPatterns,
      aspectPoolSize: aspectPool.length,
      aspectExtractionRound: extractionRound,
      aspectFingerprint,
      llmProvider: llmProviderStr,
      llmModel: llmModelStr,
      llmConfigId: resolvedLlmConfigId,
      mockMode: isMock,
    },
  });

  // ── Semantic duplicate gate (Phase 1.4) ───────────────────────────────────
  // Embeds each candidate's coreMessage and compares it (cosine) against the
  // latest ready embeddings for this company+channel. Fail-open: any failure
  // leaves generation working and is surfaced as a skip. The gate never stores.
  const semanticGate =
    deps.semanticGate ??
    createSemanticGate(companyId, context.channel.channel as SocialChannel, {
      excludeContentGroupId: options.contentGroupId ?? null,
    });

  // ── Generate with retry (duplicate-aware) ─────────────────────────────────
  // Retries up to MAX_GENERATION_ATTEMPTS times when the candidate is a
  // near-verbatim (Jaccard) or semantic duplicate. Only the final accepted post
  // is persisted; rejected candidates leave no embedding behind.
  let generationResult!: GenerationLoopResult;
  try {
    // The generation LLM calls (incl. retries) — timed into the `llm` phase.
    generationResult = await recordPhase("llm", () =>
      runGenerationLoop(
        provider,
        systemPrompt,
        userPrompt,
        // channel/contentGroupId/feedItemId ride along for [jaccard_duplicate]
        // diagnostics only (see RecentPost) — the comparison itself still only
        // ever looks at `text`.
        recentRows10.map((r) => ({
          id: r.id,
          text: r.content,
          channel: r.channel,
          contentGroupId: r.contentGroupId ?? null,
          feedItemId: r.primaryFeedItemId ?? null,
          createdAt: r.createdAt,
        })),
        {
          initialAngle,
          recentAngles,
          initialPattern,
          recentPatterns,
          // Empty for a sibling channel — see loopTopicMemory. The prompt and the
          // judge must agree about whether the topic is this generation's to pick.
          recentTopics: loopTopicMemory,
          initialAspect,
          aspectPool,
          aspectUsedIds: usedAspectIds,
        },
        semanticGate,
        // Left at its default — the trace must observe the loop, never resize it.
        MAX_GENERATION_ATTEMPTS,
        // Every attempt, including the ones the loop discards. This is what makes
        // failed attempts — their prompts, their replies and the gate that turned
        // them down — survive a run that only returns its last candidate.
        (record) => recordAttemptSteps(tracer, record),
        {
          channel: context.channel.channel,
          feedItemId: claimedFeedItemId,
          contentGroupId: options.contentGroupId ?? null,
        }
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
    complianceResult,
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
      `[generation] Aborted after ${attempts} attempts → code=CANNOT_GENERATE_UNIQUE_POST reason=${reason}` +
        (duplicateResult.flagged ? ` matchedPostId=${duplicateResult.matchedPostId}` : "") +
        ` (post not saved).`
    );
    // The abort itself, as its own step. Every attempt is already on the record
    // above (including the full [jaccard_duplicate] diagnostic, per attempt);
    // this says which gate had the last word, and that the article was handed
    // back to the pool rather than consumed by a post that never existed.
    tracer.step({
      type: "validation",
      label: "Uniqueness abort — post NOT saved",
      status: "failed",
      output: {
        reason,
        attempts,
        jaccardFlagged: duplicateResult.flagged,
        jaccardMatchedPostId: duplicateResult.matchedPostId,
        jaccardSimilarity: duplicateResult.similarityScore,
        semanticDecision: semanticResult.decision,
        topicRepeated,
        claimReleased: ownedClaimId !== null,
      },
    });
    return {
      success: false,
      code: "CANNOT_GENERATE_UNIQUE_POST",
      message: "Could not generate a sufficiently unique post after all attempts.",
      reason,
      attempts,
    };
  }

  // ── Compliance abort ──────────────────────────────────────────────────────
  // Same shape as the uniqueness abort above, and deliberately placed after it
  // so that block's behaviour is untouched: a duplicate still reports as a
  // duplicate. What is left here is a candidate that is unique but still breaks
  // a hard content rule — a banned term — after every retry. Publishing it is
  // exactly what the rule forbids, so generation aborts and the claimed source
  // article goes back to the pool.
  //
  // This is now the ONLY thing that reaches here. A post that did not honour
  // its selected angle/hook/structure/CTA is saved like any other: those are
  // generation guidance, deliberately not gated, and a stylistic miss is never
  // worth discarding usable content over. See lib/ai/quality/generation-compliance.ts.
  if (complianceResult.status === "failed") {
    await releaseClaimedFeedItem();
    console.warn(
      `[generation] Aborted after ${attempts} attempts → code=POST_FAILED_COMPLIANCE reasons=${complianceResult.reasons.join(
        " | "
      )} (post not saved).`
    );
    tracer.step({
      type: "validation",
      label: "Compliance abort — post NOT saved",
      status: "failed",
      output: {
        attempts,
        reasons: complianceResult.reasons,
        angle: selectedAngle ?? null,
        hook: selectedPattern?.hookType ?? null,
        structure: selectedPattern?.structure ?? null,
        cta: selectedPattern?.ctaType ?? null,
        claimReleased: ownedClaimId !== null,
      },
      metadata: { status: complianceResult.status, checked: complianceResult.checked },
    });
    return {
      success: false,
      code: "POST_FAILED_COMPLIANCE",
      message: `The generated post still broke a hard content rule after ${attempts} attempts.`,
      attempts,
      complianceReasons: complianceResult.reasons,
    };
  }

  const safetyResult = checkContentSafety({
    text: parsed.text,
    brandForbiddenWords: context.brand?.forbiddenWords ?? [],
  });

  // Not a gate — it flags rather than blocks — so it is recorded as a passing
  // step with the flag in its output, never as a failure.
  tracer.step({
    type: "validation",
    label: "Content safety / forbidden words",
    output: {
      passed: !safetyResult.flagged,
      flagged: safetyResult.flagged,
      matchedTerms: safetyResult.matchedTerms,
    },
    metadata: {
      forbiddenWordsChecked: context.brand?.forbiddenWords ?? [],
      note: "A flag holds the post at auto-approval; it never blocks generation.",
    },
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
    tracer.step({
      type: "validation",
      label: "Channel length limit with source URL",
      status: "failed",
      output: {
        passed: false,
        textChars: parsed.text.length,
        maxTextLength: context.channel.maxTextLength,
      },
    });
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

  // The write itself is the one operation between the claim and the post
  // existing that can genuinely fail for reasons outside this function's
  // control (a dropped connection, a constraint violation) — everything above
  // it is either pure computation or an already-handled abort. Uncaught here,
  // the claimed article would be stuck `usedInPost = true` forever with no
  // post to show for it: found in production as orphaned claims with no
  // release path, because the outer catch in generatePostFromContext has no
  // access to `ownedClaimId` and only re-throws. The IIFE keeps `post`'s type
  // inferred from the `select` below rather than fighting Prisma's overloads.
  const post = await (async () => {
    try {
      return await db.post.create({
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
          // Whose time that is — the publisher's discriminator. See the derivation
          // at the top of this function.
          manuallyScheduled,
          // Which bulk run wrote this post, if any. An association and nothing more:
          // the status above is untouched by it, so a bulk post is reviewed exactly
          // like any other manual draft.
          generationBatchId: options.generationBatchId ?? null,
          // The content topic this post is one channel's version of. An association
          // and nothing more — status, schedule and review are untouched by it, so a
          // grouped post behaves exactly like an ungrouped one everywhere except in
          // how the list chooses to display it.
          contentGroupId: options.contentGroupId ?? null,
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
    } catch (err) {
      await releaseClaimedFeedItem();
      throw err;
    }
  })();

  // ── Trace: the row that was written ───────────────────────────────────────
  // Recorded here rather than at the end so a post whose image work later fails
  // still has a persistence step saying it exists. `setPost` is what links the
  // whole run to the post — everything before this point had no id to link to.
  tracer.setPost(post.id);
  tracer.step({
    type: "persistence",
    label: "Post saved",
    output: {
      postId: post.id,
      status: post.status,
      channel: post.channel,
      content: post.content,
      hashtags: post.hashtags,
      imagePrompt: post.imagePrompt,
      notes: post.notes,
      coreMessage: parsed.coreMessage,
      topic: parsed.topic ?? null,
      scheduledFor: scheduledFor ?? null,
      manuallyScheduled,
      createdAt: post.createdAt,
    },
    metadata: {
      primaryFeedItemId: claimedFeedItemId,
      contentSourceId: options.contentSourceId ?? null,
      contentGroupId: options.contentGroupId ?? null,
      generationBatchId: options.generationBatchId ?? null,
      scheduleId: scheduleId ?? null,
      origin: originSnapshot,
      // The appended URL and the decision that produced it — text and link are
      // auditably the same article.
      sourceUrl,
      sourceTitle,
      includeSourceLink,
      includeSourceLinkLevel,
      safetyFlagged: safetyResult.flagged,
      attempts,
      llmProvider: llmProviderStr,
      llmModel: llmModelStr,
      llmConfigId: resolvedLlmConfigId,
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
  const imageEnabled = options.autoGenerateImageOverride ?? context.channel.autoGenerateImage;
  try {
    // Image generation (provider + upload) — timed into the `image` phase.
    const outcome = await recordPhase("image", () =>
      autoImage({
        postId: post.id,
        companyId,
        // The manual form override wins when present; cron never sends one, so
        // scheduled generation still reads the channel setting.
        enabled: imageEnabled,
        generatedById,
        // The exact positive and negative prompts, the provider, the model and
        // the dimensions — none of which the outcome below carries.
        recordImage: (record) => recordImageStep(tracer, "AI image generation", record),
      })
    );
    if (outcome.status === "generated") mediaUrl = outcome.media.url;
    // A skip is a real decision worth showing ("this channel does not generate
    // images", "the model asked for no illustration"), and it is the ONLY thing
    // the pipeline reports when no provider call was made — so there is no
    // recordImage record to carry it.
    if (outcome.status === "skipped") {
      tracer.skipped("image", `AI image not generated — ${outcome.reason}`, {
        channelAutoGenerateImage: context.channel.autoGenerateImage,
        manualOverride: options.autoGenerateImageOverride ?? null,
        imagePrompt: post.imagePrompt,
      });
    }
    if (outcome.status === "failed") {
      tracer.step({
        type: "image",
        label: "AI image generation failed",
        status: "failed",
        metadata: { code: outcome.code },
        error: outcome.message ?? outcome.code,
      });
    }
  } catch (err) {
    console.error(
      `[auto-image] Post ${post.id} auto image generation failed (non-fatal):`,
      err instanceof Error ? err.message : err
    );
    tracer.step({
      type: "image",
      label: "AI image generation failed",
      status: "failed",
      error: err,
    });
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
      // The article-vs-generated decision, in one step. The AI image is not
      // replaced but DISPLACED — kept, still linked, one click away — which is
      // exactly the sort of thing a reader of the trace is trying to establish.
      tracer.step({
        type: "image",
        label:
          outcome.status === "applied"
            ? "Article image imported — it leads over the AI image"
            : `Article image not used — ${outcome.status === "skipped" ? outcome.reason : outcome.code}`,
        status:
          outcome.status === "applied"
            ? "success"
            : outcome.status === "skipped"
              ? "skipped"
              : "failed",
        input: { candidateSourceImageUrl: primary.item.sourceImageUrl ?? null },
        output: outcome.status === "applied" ? outcome.media : null,
        metadata: {
          displacedMediaAssetId: outcome.status === "applied" ? outcome.previousMediaId : null,
          feedItemId: primary.item.id,
        },
        error: outcome.status === "failed" ? (outcome.message ?? outcome.code) : undefined,
      });
    } catch (err) {
      console.error(
        `[source-image] Post ${post.id} article image import failed (non-fatal):`,
        err instanceof Error ? err.message : err
      );
      tracer.step({
        type: "image",
        label: "Article image import failed",
        status: "failed",
        error: err,
      });
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
      manuallyScheduled,
      generationBatchId: options.generationBatchId ?? null,
      contentGroupId: options.contentGroupId ?? null,
      // Both taken from what this generation decided, not read back from the
      // row: they are what a multi-channel orchestrator pins its SIBLING
      // channels to, so they have to be exactly the values that went in.
      primaryFeedItemId: claimedFeedItemId,
      coreMessage: parsed.coreMessage,
      topic: parsed.topic ?? null,
      createdAt: post.createdAt,
    },
    warnings,
  };
}
