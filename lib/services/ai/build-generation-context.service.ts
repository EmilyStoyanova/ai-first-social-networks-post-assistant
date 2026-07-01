import { prisma } from "@/lib/db/client";
import { getActiveLlmInfo, NoActiveProviderError } from "@/lib/ai/router";
import type { GenerationContext } from "@/lib/ai/types";

const VALID_CHANNELS = ["facebook", "linkedin", "instagram", "tiktok"] as const;
type ValidChannel = (typeof VALID_CHANNELS)[number];

const CHANNEL_DEFAULTS: Record<ValidChannel, { postingLanguage: string; imageRequired: boolean }> =
  {
    facebook: { postingLanguage: "en", imageRequired: true },
    linkedin: { postingLanguage: "en", imageRequired: false },
    instagram: { postingLanguage: "en", imageRequired: true },
    tiktok: { postingLanguage: "en", imageRequired: true },
  };

export type BuildGenerationContextResult =
  | { success: true; context: GenerationContext }
  | {
      success: false;
      code: "NOT_FOUND" | "FORBIDDEN" | "INVALID_CHANNEL" | "NO_ACTIVE_PROVIDER";
    };

export async function buildGenerationContext(
  slug: string,
  rawChannel: string,
  userId: string,
  isGlobalAdmin: boolean
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
    if (membership.role !== "owner") return { success: false, code: "FORBIDDEN" };
    companyId = membership.companyId;
    companyRow = membership.company;
  }

  // ── Parallel data load ────────────────────────────────────────────────────
  const [brand, channelConfig, feedItems, llmInfo] = await Promise.allSettled([
    prisma.brandGuidelines.findUnique({
      where: { companyId },
      select: {
        companyDescription: true,
        toneOfVoice: true,
        targetAudience: true,
        forbiddenWords: true,
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
      },
    }),
    prisma.feedItem.findMany({
      where: { companyId, source: { enabled: true } },
      orderBy: [{ publishedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      take: 5,
      select: { title: true, content: true, url: true, publishedAt: true },
    }),
    getActiveLlmInfo(),
  ]);

  // LLM config is a hard requirement
  if (llmInfo.status === "rejected") {
    const err = llmInfo.reason;
    if (err instanceof NoActiveProviderError) {
      return { success: false, code: "NO_ACTIVE_PROVIDER" };
    }
    throw err;
  }

  const brandData = brand.status === "fulfilled" ? brand.value : null;
  const channelConfigData = channelConfig.status === "fulfilled" ? channelConfig.value : null;
  const feedData = feedItems.status === "fulfilled" ? feedItems.value : [];
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
    },
    feedItems: feedData.map((f) => ({
      title: f.title,
      content: f.content,
      url: f.url,
      publishedAt: f.publishedAt,
    })),
    llm: llmInfo.value,
  };

  return { success: true, context };
}
