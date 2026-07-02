import { prisma } from "@/lib/db/client";
import { getImageProvider } from "@/lib/ai/image/image-provider-factory";
import { buildImagePrompt } from "@/lib/ai/image/image-prompt-builder";
import { ImageProviderError } from "@/lib/ai/image/image-provider-errors";

export interface MediaDTO {
  id: string;
  url: string;
  width: number;
  height: number;
}

export type GeneratePostImageResult =
  | { success: true; media: MediaDTO }
  | {
      success: false;
      code: "NOT_FOUND" | "FORBIDDEN" | "NO_IMAGE_PROMPT" | "IMAGE_PROVIDER_ERROR";
      message?: string;
    };

export async function generatePostImage(
  postId: string,
  userId: string,
  isGlobalAdmin: boolean
): Promise<GeneratePostImageResult> {
  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: {
      companyId: true,
      channel: true,
      imagePrompt: true,
      company: {
        select: {
          brandGuidelines: { select: { forbiddenWords: true } },
        },
      },
    },
  });

  if (!post) return { success: false, code: "NOT_FOUND" };

  if (!isGlobalAdmin) {
    const membership = await prisma.companyMember.findFirst({
      where: { companyId: post.companyId, userId },
      select: { role: true },
    });
    if (!membership) return { success: false, code: "NOT_FOUND" };
    if (membership.role !== "owner" && membership.role !== "editor") {
      return { success: false, code: "FORBIDDEN" };
    }
  }

  if (!post.imagePrompt) {
    return { success: false, code: "NO_IMAGE_PROMPT" };
  }

  const forbiddenWords = post.company.brandGuidelines?.forbiddenWords ?? [];
  const prompt = buildImagePrompt({
    basePrompt: post.imagePrompt,
    channel: post.channel,
    forbiddenWords,
  });

  let provider: ReturnType<typeof getImageProvider>;
  try {
    provider = getImageProvider();
  } catch (err) {
    if (err instanceof ImageProviderError) {
      return { success: false, code: "IMAGE_PROVIDER_ERROR", message: err.message };
    }
    throw err;
  }

  const { width, height } = channelDimensions(post.channel);

  let generated: Awaited<ReturnType<typeof provider.generate>>;
  try {
    generated = await provider.generate(prompt, { width, height });
  } catch (err) {
    if (err instanceof ImageProviderError) {
      return { success: false, code: "IMAGE_PROVIDER_ERROR", message: err.message };
    }
    throw err;
  }

  const asset = await prisma.mediaAsset.create({
    data: {
      companyId: post.companyId,
      cloudinaryId: generated.providerAssetId,
      url: generated.url,
      width: generated.width,
      height: generated.height,
      generatedBy: "ai",
      aiPrompt: prompt,
      uploadedBy: userId,
    },
    select: { id: true, url: true, width: true, height: true },
  });

  await prisma.post.update({
    where: { id: postId },
    data: { mediaAssetId: asset.id },
  });

  return {
    success: true,
    media: {
      id: asset.id,
      url: asset.url,
      width: asset.width ?? generated.width,
      height: asset.height ?? generated.height,
    },
  };
}

function channelDimensions(channel: string): { width: number; height: number } {
  switch (channel) {
    case "instagram":
      return { width: 1080, height: 1080 };
    case "linkedin":
      return { width: 1200, height: 627 };
    case "facebook":
      return { width: 1200, height: 630 };
    case "tiktok":
      return { width: 1080, height: 1920 };
    default:
      return { width: 1024, height: 1024 };
  }
}
