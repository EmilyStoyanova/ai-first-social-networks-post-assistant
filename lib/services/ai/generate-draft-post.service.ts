import { prisma } from "@/lib/db/client";
import { type SocialChannel } from "@prisma/client";
import { buildGenerationContext } from "./build-generation-context.service";
import { resolveGenerationAspect } from "./resolve-generation-aspect.service";
import type { GenerationContext, ILlmProvider } from "@/lib/ai/types";
import { buildPrompts } from "@/lib/ai/prompt-builder";
import { getLlmProvider, NoActiveLlmProviderError } from "@/lib/ai/llm/llm-provider-factory";
import { LlmProviderError, LlmResponseParseError } from "@/lib/ai/errors";
import { generateWithRetry, type GenerationLoopResult } from "@/lib/ai/generate-with-retry";
import { checkContentSafety } from "@/lib/ai/quality/content-safety";
import { createAuditLog, AUDIT_ACTIONS } from "@/lib/services/audit/audit-log.service";
import { CONTENT_ANGLES, selectAngle, type ContentAngle } from "@/lib/ai/content-angle";
import { selectPattern, isValidPostPattern, type PostPattern } from "@/lib/ai/post-pattern";

// ─── Mock response ─────────────────────────────────────────────────────────────

const MOCK_LLM_TEXT = JSON.stringify({
  text: "Big things are coming! Stay tuned for what we have in store. 🚀",
  hashtags: ["innovation", "growth", "comingsoon"],
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
        | "LLM_RESPONSE_PARSE_ERROR";
      message?: string;
    };

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
}

export async function generateDraftPost(
  slug: string,
  rawChannel: string,
  userId: string,
  isGlobalAdmin: boolean,
  contentLanguage?: string
): Promise<GenerateDraftPostResult> {
  // Build context (also validates auth/access)
  const contextResult = await buildGenerationContext(slug, rawChannel, userId, isGlobalAdmin);
  if (!contextResult.success) {
    return { success: false, code: contextResult.code };
  }

  return generatePostFromContext(contextResult.context, contextResult.companyId, {
    contentLanguage,
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
  options: GeneratePostOptions = {}
): Promise<GenerateDraftPostResult> {
  const { contentLanguage, generatedById, scheduleId, scheduledFor } = options;
  const initialStatus = options.initialStatus ?? "draft";

  // ── Fetch recent posts before generation ──────────────────────────────────
  // Used both as prompt context (avoid repetition) and for duplicate detection after.
  const recentRows = await prisma.post.findMany({
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

  // ── Generate with retry (duplicate-aware) ─────────────────────────────────
  // Retries up to MAX_GENERATION_ATTEMPTS times when the candidate is flagged
  // as a duplicate of a recent post. Only the final accepted post is persisted.
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
      }
    );
  } catch (err) {
    if (err instanceof LlmProviderError) {
      return { success: false, code: "LLM_PROVIDER_ERROR", message: err.message };
    }
    if (err instanceof LlmResponseParseError) {
      return { success: false, code: "LLM_RESPONSE_PARSE_ERROR", message: err.message };
    }
    throw err;
  }

  // ── Quality guards ────────────────────────────────────────────────────────
  const { parsed, duplicateResult, selectedAngle, selectedPattern, selectedAspect } =
    generationResult;

  const safetyResult = checkContentSafety({
    text: parsed.text,
    brandForbiddenWords: context.brand?.forbiddenWords ?? [],
  });

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
  };

  // ── Resolve final status ──────────────────────────────────────────────────
  // For manual generation (draft) on a fully_automated channel, skip the
  // approval queue so the post is immediately publishable. Safety-flagged
  // posts are always held for human review regardless of mode.
  const effectiveMode = context.channel.automationModeOverride ?? context.company.automationMode;
  const autoApproved =
    initialStatus === "draft" && effectiveMode === "fully_automated" && !safetyResult.flagged;
  const resolvedStatus = autoApproved ? ("approved" as const) : initialStatus;
  const approvedAt = autoApproved ? new Date() : null;

  // ── Save post ─────────────────────────────────────────────────────────────
  const feedItemIds = context.feedItems.map((f) => f.id);

  const post = await prisma.post.create({
    data: {
      companyId,
      channel: context.channel.channel as SocialChannel,
      status: resolvedStatus,
      approvedAt,
      content: parsed.text,
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
        qualityGuards,
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

  await createAuditLog({
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

  const warnings: GenerationWarnings = {
    duplicate: duplicateResult,
    safety: safetyResult,
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
