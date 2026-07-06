import { prisma } from "@/lib/db/client";
import { getLlmProviderInfo } from "@/lib/ai/llm/llm-provider-factory";
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
  | { success: true; context: GenerationContext; companyId: string }
  | {
      success: false;
      // NO_ACTIVE_PROVIDER is kept for backward compatibility with existing route handlers
      // but is no longer returned by this function (provider info comes from env vars).
      code: "NOT_FOUND" | "FORBIDDEN" | "INVALID_CHANNEL" | "NO_ACTIVE_PROVIDER";
    };

/**
 * System-level context builder — no RBAC. Used by the cron dispatcher, where
 * there is no acting user; user-facing callers go through
 * buildGenerationContext below.
 */
export async function buildGenerationContextForCompany(
  companyId: string,
  rawChannel: string
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

  return loadContext(companyId, channel, companyRow);
}

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
    // Both owner and editor can trigger generation
    if (membership.role !== "owner" && membership.role !== "editor") {
      return { success: false, code: "FORBIDDEN" };
    }
    companyId = membership.companyId;
    companyRow = membership.company;
  }

  return loadContext(companyId, channel, companyRow);
}

async function loadContext(
  companyId: string,
  channel: ValidChannel,
  companyRow: {
    name: string;
    website: string | null;
    automationMode: string;
    defaultLang: string;
  }
): Promise<BuildGenerationContextResult> {
  // ── Parallel data load ────────────────────────────────────────────────────
  const [brand, channelConfig, feedItems] = await Promise.allSettled([
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
      select: { id: true, title: true, content: true, url: true, publishedAt: true },
    }),
  ]);

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
      id: f.id,
      title: f.title,
      content: f.content,
      url: f.url,
      publishedAt: f.publishedAt,
    })),
    llm: getLlmProviderInfo(),
  };

  return { success: true, context, companyId };
}
