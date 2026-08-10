import { prisma } from "@/lib/db/client";
import {
  applySourceImageCore,
  prismaSourceImageDeps,
  type ApplySourceImageResult,
  type PostImageDTO,
} from "@/lib/services/posts/apply-source-image.service";

/**
 * Giving a freshly generated post the image of the article it was written from.
 *
 * A thin policy layer, exactly like `autoGeneratePostImage` beside it: it decides
 * IF the article's image should lead and WHO the import is attributed to, then
 * hands off to the existing import pipeline (`applySourceImageCore`). No
 * download, upload, dedupe or pointer logic is duplicated here — the manual
 * "Use this image" button runs the same code.
 *
 * Ordering matters, and it is the caller's job: this runs AFTER automatic AI
 * generation, so the import displaces the AI asset rather than the other way
 * round. The pipeline moves the displaced asset to `Post.previousMediaAssetId`
 * and never deletes it, which is what keeps the AI image linked to the post and
 * one click away in the picker.
 *
 * Non-article posts need no guard here. `prismaSourceImageDeps.loadContext`
 * reads the image through `primaryFeedItem` behind an `rss` check, so a brand
 * setup, prompt, calendar-event or product-page post reports `no_source_image`
 * and keeps whatever the AI produced.
 *
 * Best-effort, by the same rule as embedding and auto image generation: it NEVER
 * throws. A post whose article image could not be imported is a perfectly good
 * post showing its AI image, and the user can still pick the article's image by
 * hand.
 */

export type AutoApplySourceImageOutcome =
  /** The article's image is now the post's image. */
  | { status: "applied"; media: PostImageDTO; previousMediaId: string | null }
  /** Nothing was attempted, or nothing needed doing. Both are normal. */
  | { status: "skipped"; reason: "no_source_image" | "already_current" }
  /** The import ran and failed. The post keeps the image it had. */
  | { status: "failed"; code: string; message?: string };

export interface AutoApplySourceImageInput {
  postId: string;
  companyId: string;
  /** The acting user. Undefined for cron/system generation. */
  generatedById?: string;
}

/** Narrow DB surface — real Prisma satisfies it; tests inject a fake. */
export interface AutoApplySourceImageDb {
  company: {
    findUnique: (args: {
      where: { id: string };
      select: { createdBy: true };
    }) => Promise<{ createdBy: string } | null>;
  };
}

export interface AutoApplySourceImageDeps {
  db?: AutoApplySourceImageDb;
  applyImage?: (postId: string, userId: string) => Promise<ApplySourceImageResult>;
}

export async function autoApplySourceImage(
  input: AutoApplySourceImageInput,
  deps: AutoApplySourceImageDeps = {}
): Promise<AutoApplySourceImageOutcome> {
  const db = deps.db ?? prisma;
  const applyImage =
    deps.applyImage ??
    // The `true` is the membership-check bypass, not an admin grant. Authorization
    // for this path already happened when the post was created, and a cron run has
    // no user at all to re-check — mirroring the `system` actor in
    // generate-post-image.service.ts.
    ((postId: string, userId: string) =>
      applySourceImageCore(postId, userId, true, prismaSourceImageDeps));

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

  let result: ApplySourceImageResult;
  try {
    result = await applyImage(input.postId, attributeToUserId);
  } catch (err) {
    // The pipeline maps download and upload failures to a result code and only
    // throws on genuinely unexpected errors. Swallow those too: an image must
    // never take the post down with it.
    const message = err instanceof Error ? err.message : String(err);
    logFailure(input.postId, "UNEXPECTED_ERROR", message);
    return { status: "failed", code: "UNEXPECTED_ERROR", message };
  }

  if (!result.success) {
    // By far the commonest answer, and not a problem: the post has no article, or
    // the article has no usable image. Never logged as a failure.
    if (result.code === "NO_SOURCE_IMAGE") return { status: "skipped", reason: "no_source_image" };
    logFailure(input.postId, result.code, result.message);
    return { status: "failed", code: result.code, message: result.message };
  }

  // The pipeline found the article image already attached and deliberately wrote
  // nothing — writing would strand the asset it would have displaced.
  if (result.unchanged) return { status: "skipped", reason: "already_current" };

  return { status: "applied", media: result.media, previousMediaId: result.previousMediaId };
}

function logFailure(postId: string, code: string, message?: string): void {
  console.error(
    `[source-image] Post ${postId} could not use its article image (non-fatal, post kept): ` +
      `${code}${message ? ` — ${message}` : ""}. The AI image stands and the article's ` +
      `image can still be picked manually.`
  );
}
