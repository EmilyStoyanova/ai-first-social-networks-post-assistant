import type { MediaSource, SocialChannel } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { describeImageProvider, getImageProvider } from "@/lib/ai/image/image-provider-factory";
import { buildImagePrompt } from "@/lib/ai/image/image-prompt-builder";
import { ImageProviderError } from "@/lib/ai/image/image-provider-errors";
import type { IImageProvider } from "@/lib/ai/image/image-provider";
import type { ImageStyle } from "@/lib/ai/image/image-style";
import type {
  ImageGenerationRecord,
  ImageGenerationRecorder,
} from "@/lib/generation-trace/image-record";
import { GenerationTracer } from "@/lib/generation-trace/tracer";
import { recordImageStep } from "@/lib/generation-trace/post-generation-steps";

export interface MediaDTO {
  id: string;
  url: string;
  width: number;
  height: number;
}

/**
 * Who is asking for the image.
 *
 * `user` is the manual path: a real person clicked "Generate image", so their
 * membership is re-checked here.
 *
 * `system` is automatic generation. There is deliberately no `isGlobalAdmin`
 * escape hatch: authorization for that path is the channel's
 * `autoGenerateImage` setting plus the fact that the post was just created by
 * an already-authorized actor, so re-checking membership would be redundant —
 * and impossible for a cron run, which has no user at all. The id is used ONLY
 * to satisfy `MediaAsset.uploadedBy` (a required FK), never as a grant.
 */
export type ImageGenerationActor =
  | { kind: "user"; userId: string; isGlobalAdmin: boolean }
  | { kind: "system"; attributeToUserId: string };

/** The user id recorded as `MediaAsset.uploadedBy` for this actor. */
function actorUserId(actor: ImageGenerationActor): string {
  return actor.kind === "user" ? actor.userId : actor.attributeToUserId;
}

export type GeneratePostImageResult =
  | { success: true; media: MediaDTO }
  | {
      success: false;
      code: "NOT_FOUND" | "FORBIDDEN" | "NO_IMAGE_PROMPT" | "IMAGE_PROVIDER_ERROR";
      message?: string;
    };

// ─── Minimal DB interface for testability ─────────────────────────────────────

export interface GeneratePostImageDb {
  post: {
    findUnique: (args: {
      where: { id: string };
      select: {
        companyId: true;
        channel: true;
        imagePrompt: true;
        company: { select: { brandGuidelines: { select: { forbiddenWords: true } } } };
      };
    }) => Promise<{
      companyId: string;
      channel: SocialChannel;
      imagePrompt: string | null;
      company: { brandGuidelines: { forbiddenWords: string[] } | null };
    } | null>;
    update: (args: { where: { id: string }; data: { mediaAssetId: string } }) => Promise<unknown>;
  };
  companyMember: {
    findFirst: (args: {
      where: { companyId: string; userId: string };
      select: { role: true };
    }) => Promise<{ role: string } | null>;
  };
  mediaAsset: {
    create: (args: {
      data: {
        companyId: string;
        cloudinaryId: string;
        url: string;
        width: number;
        height: number;
        generatedBy: MediaSource;
        aiPrompt: string;
        imageStyle: string | null;
        uploadedBy: string;
      };
      select: { id: true; url: true; width: true; height: true };
    }) => Promise<{ id: string; url: string; width: number | null; height: number | null }>;
  };
}

export interface GeneratePostImageDeps {
  db: GeneratePostImageDb;
  getProvider: () => IImageProvider;
  /**
   * Told what was drawn, and from which prompt. Optional and observation-only —
   * the outcome type carries a `MediaDTO`, which says an image exists but not
   * what was ASKED for, and the assembled prompt, the negative prompt and the
   * dimensions are decided here and were previously unrecoverable afterwards.
   */
  recordImage?: ImageGenerationRecorder;
  /** Provider/model by name, for the record above. Injected in tests. */
  describeProvider?: () => { provider: string; model: string | null };
}

// ─── Core logic ───────────────────────────────────────────────────────────────

export async function generatePostImageCore(
  postId: string,
  actor: ImageGenerationActor,
  imageStyle: ImageStyle | undefined,
  deps: GeneratePostImageDeps,
  promptOverride?: string
): Promise<GeneratePostImageResult> {
  const { db, getProvider } = deps;

  const post = await db.post.findUnique({
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

  if (actor.kind === "user" && !actor.isGlobalAdmin) {
    const membership = await db.companyMember.findFirst({
      where: { companyId: post.companyId, userId: actor.userId },
      select: { role: true },
    });
    if (!membership) return { success: false, code: "NOT_FOUND" };
    if (membership.role !== "owner" && membership.role !== "editor") {
      return { success: false, code: "FORBIDDEN" };
    }
  }

  // A non-empty override replaces the post's stored prompt for this generation
  // only; it is never written back to the post.
  const basePrompt = promptOverride?.trim() || post.imagePrompt;
  if (!basePrompt) {
    return { success: false, code: "NO_IMAGE_PROMPT" };
  }

  const forbiddenWords = post.company.brandGuidelines?.forbiddenWords ?? [];
  const { prompt, negativePrompt } = buildImagePrompt({
    basePrompt,
    channel: post.channel,
    forbiddenWords,
    imageStyle,
  });

  const { width, height } = channelDimensions(post.channel);
  const described = (deps.describeProvider ?? describeImageProvider)();
  const startedAt = new Date();

  /** Reports one image generation, successful or not. Never throws. */
  const record = (outcome: Pick<ImageGenerationRecord, "result" | "error">): void => {
    if (!deps.recordImage) return;
    try {
      const completedAt = new Date();
      deps.recordImage({
        basePrompt,
        prompt,
        negativePrompt: negativePrompt ?? null,
        provider: described.provider,
        model: described.model,
        style: imageStyle ?? null,
        width,
        height,
        startedAt,
        completedAt,
        durationMs: completedAt.getTime() - startedAt.getTime(),
        ...outcome,
      });
    } catch (err) {
      console.error(
        "[generation-trace] Image recorder threw (image generation continues):",
        err instanceof Error ? err.message : err
      );
    }
  };

  let provider: IImageProvider;
  try {
    provider = getProvider();
  } catch (err) {
    if (err instanceof ImageProviderError) {
      logImageProviderFailure(err);
      record({ error: { code: "IMAGE_PROVIDER_ERROR", message: err.message } });
      return { success: false, code: "IMAGE_PROVIDER_ERROR", message: err.message };
    }
    throw err;
  }

  let generated: Awaited<ReturnType<typeof provider.generate>>;
  try {
    generated = await provider.generate(prompt, { width, height, negativePrompt });
  } catch (err) {
    if (err instanceof ImageProviderError) {
      logImageProviderFailure(err);
      record({ error: { code: "IMAGE_PROVIDER_ERROR", message: err.message } });
      return { success: false, code: "IMAGE_PROVIDER_ERROR", message: err.message };
    }
    throw err;
  }

  const asset = await db.mediaAsset.create({
    data: {
      companyId: post.companyId,
      cloudinaryId: generated.providerAssetId,
      url: generated.url,
      width: generated.width,
      height: generated.height,
      generatedBy: "ai",
      aiPrompt: prompt,
      imageStyle: imageStyle ?? null,
      uploadedBy: actorUserId(actor),
    },
    select: { id: true, url: true, width: true, height: true },
  });

  await db.post.update({
    where: { id: postId },
    data: { mediaAssetId: asset.id },
  });

  record({
    result: {
      url: generated.url,
      width: generated.width,
      height: generated.height,
      providerAssetId: generated.providerAssetId,
      mediaAssetId: asset.id,
    },
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

// ─── Public API (uses real Prisma + configured provider) ──────────────────────

/** Runs the pipeline for any actor. The single production entry point. */
export async function generatePostImageForActor(
  postId: string,
  actor: ImageGenerationActor,
  imageStyle?: ImageStyle,
  promptOverride?: string,
  /** Optional trace sink. Absent on the manual button, present during generation. */
  recordImage?: ImageGenerationRecorder
): Promise<GeneratePostImageResult> {
  return generatePostImageCore(
    postId,
    actor,
    imageStyle,
    { db: prisma, getProvider: getImageProvider, recordImage },
    promptOverride
  );
}

/**
 * The manual path: a user clicked "Generate image".
 *
 * Traced as a run of its OWN — kind `image`, linked to the same post — rather
 * than being folded into the generation that wrote the post. It is a separate AI
 * operation, taken later, by a different person, possibly several times, and
 * possibly with a hand-edited prompt. This is precisely the case the data model
 * is a list of runs per post for: a single blob on Post could only ever hold the
 * last one.
 */
export async function generatePostImage(
  postId: string,
  userId: string,
  isGlobalAdmin: boolean,
  imageStyle?: ImageStyle,
  promptOverride?: string
): Promise<GeneratePostImageResult> {
  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: { companyId: true, channel: true },
  });

  const tracer = GenerationTracer.start({
    kind: "image",
    trigger: "manual",
    postId,
    companyId: post?.companyId ?? null,
    channel: post?.channel ?? null,
    userId,
    options: { imageStyle: imageStyle ?? null, promptOverridden: Boolean(promptOverride?.trim()) },
  });

  try {
    const result = await generatePostImageForActor(
      postId,
      { kind: "user", userId, isGlobalAdmin },
      imageStyle,
      promptOverride,
      (record) => recordImageStep(tracer, "Image regenerated by hand", record)
    );
    if (!result.success) tracer.fail(result.code, result.message ?? null);
    return result;
  } finally {
    await tracer.flush();
  }
}

function logImageProviderFailure(err: ImageProviderError): void {
  console.error("[image-provider] Generation failed");
  console.error(`  IMAGE_PROVIDER  : ${process.env.IMAGE_PROVIDER ?? "(not set)"}`);
  console.error(`  IMAGE_WORKER_URL: ${process.env.IMAGE_WORKER_URL ?? "(not set)"}`);
  console.error(`  ${err.name} [${err.code}]: ${err.message}`);
  if (err.stack) {
    console.error("  stack:\n" + err.stack);
  }
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause !== undefined) {
    if (cause instanceof Error) {
      console.error(`  cause (${cause.name}): ${cause.message}`);
      if (cause.stack) console.error("  cause stack:\n" + cause.stack);
    } else {
      console.error("  cause:", JSON.stringify(cause, null, 2));
    }
  }
}

/**
 * Every value must be a positive multiple of 8: diffusion models work on a
 * latent downsampled by 8, and the image worker rejects anything else.
 *
 * LinkedIn's own spec is 1200x627 and Facebook's is 1200x630 — neither divides
 * by 8, so each is rounded to the nearest multiple. Both stay inside 0.5% of the
 * platform's 1.91:1 card, which no crop will show.
 */
export function channelDimensions(channel: string): { width: number; height: number } {
  switch (channel) {
    case "instagram":
      return { width: 1080, height: 1080 };
    case "linkedin":
      return { width: 1200, height: 624 };
    case "facebook":
      return { width: 1200, height: 632 };
    case "tiktok":
      return { width: 1080, height: 1920 };
    default:
      return { width: 1024, height: 1024 };
  }
}
