import { prisma } from "@/lib/db/client";
import { type SocialChannel } from "@prisma/client";
import { buildGenerationContext } from "./build-generation-context.service";
import type { GenerationContext } from "@/lib/ai/types";
import { buildPrompts } from "@/lib/ai/prompt-builder";
import { getLlmProvider, NoActiveLlmProviderError } from "@/lib/ai/llm/llm-provider-factory";
import { parseLlmPost } from "@/lib/ai/parse-llm-post";
import { LlmProviderError, LlmResponseParseError } from "@/lib/ai/errors";
import { checkDuplicatePost } from "@/lib/ai/quality/duplicate-detection";
import { checkContentSafety } from "@/lib/ai/quality/content-safety";
import { createAuditLog, AUDIT_ACTIONS } from "@/lib/services/audit/audit-log.service";

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
  const { systemPrompt, userPrompt } = buildPrompts(context, contentLanguage);

  // ── LLM call ─────────────────────────────────────────────────────────────
  // Provider name and model come from context (set by getLlmProviderInfo() during context build)
  const llmProviderStr = context.llm.provider;
  const llmModelStr = context.llm.model;
  let rawText: string;

  if (process.env.AI_MOCK_MODE === "true") {
    rawText = MOCK_LLM_TEXT;
  } else {
    let provider: ReturnType<typeof getLlmProvider>;
    try {
      provider = getLlmProvider();
    } catch (err) {
      if (err instanceof NoActiveLlmProviderError) {
        return { success: false, code: "NO_ACTIVE_PROVIDER", message: err.message };
      }
      throw err;
    }

    try {
      const response = await provider.generate({
        systemPrompt,
        userPrompt,
        temperature: 0.7,
        maxTokens: 1024,
      });
      rawText = response.text;
    } catch (err) {
      if (err instanceof LlmProviderError) {
        return { success: false, code: "LLM_PROVIDER_ERROR", message: err.message };
      }
      throw err;
    }
  }

  // ── Parse response ────────────────────────────────────────────────────────
  let parsed: ReturnType<typeof parseLlmPost>;
  try {
    parsed = parseLlmPost(rawText);
  } catch (err) {
    if (err instanceof LlmResponseParseError) {
      return { success: false, code: "LLM_RESPONSE_PARSE_ERROR", message: err.message };
    }
    throw err;
  }

  // ── Quality guards ────────────────────────────────────────────────────────

  // Fetch last 10 posts for this company + channel to check duplicates
  const recentRows = await prisma.post.findMany({
    where: { companyId, channel: context.channel.channel as SocialChannel },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, content: true },
  });

  const duplicateResult = checkDuplicatePost({
    candidateText: parsed.text,
    recentPosts: recentRows.map((r) => ({ id: r.id, text: r.content })),
  });

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

  // ── Save post ─────────────────────────────────────────────────────────────
  const feedItemIds = context.feedItems.map((f) => f.id);

  const post = await prisma.post.create({
    data: {
      companyId,
      channel: context.channel.channel as SocialChannel,
      status: initialStatus,
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
        qualityGuards,
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
