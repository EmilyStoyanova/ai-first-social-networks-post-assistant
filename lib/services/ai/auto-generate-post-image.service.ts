import { prisma } from "@/lib/db/client";
import {
  generatePostImageForActor,
  type GeneratePostImageResult,
  type MediaDTO,
} from "./generate-post-image.service";
import type { ImageGenerationRecorder } from "@/lib/generation-trace/image-record";

/**
 * Automatic image generation for a freshly created post.
 *
 * This is a thin policy layer — it decides IF an image should be generated and
 * WHO it is attributed to, then hands off to the normal image pipeline
 * (`generatePostImageForActor`). No prompt building, provider selection, or
 * media persistence is duplicated here; attaching the image to the post is the
 * pipeline's `post.update`, exactly as on the manual path.
 *
 * Best-effort, mirroring `embedPost` (Phase 1.2): it NEVER throws and never
 * returns a failure that a caller must handle. A post whose image fails is a
 * successful post without an image — the user can still click "Generate image"
 * later, which is why failure is logged rather than surfaced as a broken
 * generation.
 */

export type AutoGenerateImageOutcome =
  /**
   * The pipeline has already attached this media to the post. It is returned so
   * the caller can put the URL in its response — without it the generate API
   * would answer with a post whose image exists in the DB but is invisible to
   * the UI until a refetch, which reads as "not attached".
   */
  | { status: "generated"; media: MediaDTO }
  /** No image was attempted. All three reasons are normal, not errors. */
  | { status: "skipped"; reason: "disabled" | "already_has_media" | "no_image_prompt" }
  /** The pipeline ran and failed. The post is still fine. */
  | { status: "failed"; code: string; message?: string };

export interface AutoGenerateImageInput {
  postId: string;
  companyId: string;
  /** The channel's `autoGenerateImage` setting. */
  enabled: boolean;
  /** The acting user. Undefined for cron/system generation. */
  generatedById?: string;
  /**
   * Told what was drawn and from which prompt, when the caller is tracing.
   * Observation only — see lib/generation-trace/image-record.ts.
   */
  recordImage?: ImageGenerationRecorder;
}

/** Narrow DB surface — real Prisma satisfies it; tests inject a fake. */
export interface AutoGenerateImageDb {
  post: {
    findUnique: (args: {
      where: { id: string };
      select: { mediaAssetId: true; imagePrompt: true };
    }) => Promise<{ mediaAssetId: string | null; imagePrompt: string | null } | null>;
  };
  company: {
    findUnique: (args: {
      where: { id: string };
      select: { createdBy: true };
    }) => Promise<{ createdBy: string } | null>;
  };
}

export interface AutoGenerateImageDeps {
  db?: AutoGenerateImageDb;
  generateImage?: typeof generatePostImageForActor;
}

export async function autoGeneratePostImage(
  input: AutoGenerateImageInput,
  deps: AutoGenerateImageDeps = {}
): Promise<AutoGenerateImageOutcome> {
  const db = deps.db ?? prisma;
  const generateImage = deps.generateImage ?? generatePostImageForActor;

  if (!input.enabled) return { status: "skipped", reason: "disabled" };

  const post = await db.post.findUnique({
    where: { id: input.postId },
    select: { mediaAssetId: true, imagePrompt: true },
  });

  // Should never happen — the caller just created this post. Report it honestly
  // rather than dressing it up as a skip.
  if (!post) {
    logFailure(input.postId, "NOT_FOUND");
    return { status: "failed", code: "NOT_FOUND" };
  }

  // Never overwrite media. The manual path deliberately DOES regenerate over an
  // existing image (that is what the user asked for by clicking); the automatic
  // path must not, or a re-run would silently replace a chosen image and burn
  // credits doing it.
  if (post.mediaAssetId) return { status: "skipped", reason: "already_has_media" };

  // The LLM omits imagePrompt for text-only posts. Not a failure — there is
  // simply nothing to draw.
  if (!post.imagePrompt) return { status: "skipped", reason: "no_image_prompt" };

  // MediaAsset.uploadedBy is a required FK, but a cron post has no acting user.
  // The company creator is the stable fallback: the column is non-nullable, so
  // the row always exists.
  let attributeToUserId = input.generatedById;
  if (!attributeToUserId) {
    const company = await db.company.findUnique({
      where: { id: input.companyId },
      select: { createdBy: true },
    });
    if (!company) {
      logFailure(input.postId, "NO_ATTRIBUTABLE_USER");
      return { status: "failed", code: "NO_ATTRIBUTABLE_USER" };
    }
    attributeToUserId = company.createdBy;
  }

  let result: GeneratePostImageResult;
  try {
    result = await generateImage(
      input.postId,
      { kind: "system", attributeToUserId },
      undefined,
      undefined,
      input.recordImage
    );
  } catch (err) {
    // The pipeline maps provider failures to a result code and only throws on
    // genuinely unexpected errors. Swallow those too: an image must never take
    // the post down with it.
    const message = err instanceof Error ? err.message : String(err);
    logFailure(input.postId, "UNEXPECTED_ERROR", message);
    return { status: "failed", code: "UNEXPECTED_ERROR", message };
  }

  if (!result.success) {
    logFailure(input.postId, result.code, result.message);
    return { status: "failed", code: result.code, message: result.message };
  }

  return { status: "generated", media: result.media };
}

function logFailure(postId: string, code: string, message?: string): void {
  console.error(
    `[auto-image] Post ${postId} image generation failed (non-fatal, post kept): ` +
      `${code}${message ? ` — ${message}` : ""}. An image can still be generated manually.`
  );
}
