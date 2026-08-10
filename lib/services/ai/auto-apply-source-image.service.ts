import { prisma } from "@/lib/db/client";
import {
  applySourceImageCore,
  prismaSourceImageDeps,
  type ApplySourceImageResult,
  type PostImageDTO,
} from "@/lib/services/posts/apply-source-image.service";
import {
  resolveSourceImageCore,
  prismaResolveSourceImageDeps,
  type ResolveSourceImageResult,
} from "@/lib/services/posts/resolve-source-image.service";

/**
 * Giving a freshly generated post the image of the article it was written from.
 *
 * A thin policy layer, exactly like `autoGeneratePostImage` beside it: it decides
 * IF the article's image should lead and WHO the import is attributed to, then
 * hands off to the existing services. No extraction, download, upload, dedupe or
 * pointer logic is duplicated here — the two steps below are the same two the
 * picker's "Source article" tab runs when a person clicks "Use this image":
 *
 *   1. `resolveSourceImageCore` — what is the article's image? Reads what
 *      ingestion stored and, when that is null, scrapes the article once and
 *      writes the answer back to the FeedItem.
 *   2. `applySourceImageCore` — download it through the SSRF gate, push it
 *      through Cloudinary, repoint the post.
 *
 * Step 1 is why this exists as a two-step call rather than one. Generation used
 * to consult only the STORED `FeedItem.sourceImageUrl`, so any article whose
 * image ingestion had not resolved kept its AI image — while the tab, which
 * resolves on demand, cheerfully displayed the image that was there all along.
 * Both paths now ask the same question of the same service.
 *
 * Ordering matters, and it is the caller's job: this runs AFTER automatic AI
 * generation, so the import displaces the AI asset rather than the other way
 * round. The pipeline moves the displaced asset to `Post.previousMediaAssetId`
 * and never deletes it, which is what keeps the AI image linked to the post and
 * one click away in the picker.
 *
 * Non-article posts need no guard here. Both services read through
 * `primaryFeedItem` behind an `rss` check, so a brand setup, prompt,
 * calendar-event or product-page post reports `no_source_image` at step 1 and
 * keeps whatever the AI produced — the import is never reached.
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
  resolveImage?: (postId: string, userId: string) => Promise<ResolveSourceImageResult>;
  applyImage?: (
    postId: string,
    userId: string,
    sourceImageUrl: string
  ) => Promise<ApplySourceImageResult>;
}

export async function autoApplySourceImage(
  input: AutoApplySourceImageInput,
  deps: AutoApplySourceImageDeps = {}
): Promise<AutoApplySourceImageOutcome> {
  const db = deps.db ?? prisma;
  // The `true` in both defaults is the membership-check bypass, not an admin
  // grant. Authorization for this path already happened when the post was
  // created, and a cron run has no user at all to re-check — mirroring the
  // `system` actor in generate-post-image.service.ts.
  const resolveImage =
    deps.resolveImage ??
    ((postId: string, userId: string) =>
      resolveSourceImageCore(postId, userId, true, prismaResolveSourceImageDeps));
  const applyImage =
    deps.applyImage ??
    ((postId: string, userId: string, sourceImageUrl: string) =>
      applySourceImageCore(postId, userId, true, {
        ...prismaSourceImageDeps,
        // The URL is already in hand — possibly scraped seconds ago by the step
        // above, whose write-back to the FeedItem is deliberately best-effort.
        // Handing it over rather than reading it back keeps the import working
        // even when that write did not land. The `rss` check the real loadContext
        // applies is not lost: the resolver applies the same one, and only
        // returns a URL for an article.
        loadContext: async (id) => {
          const context = await prismaSourceImageDeps.loadContext(id);
          return context && { ...context, sourceImageUrl };
        },
      }));

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

  // Step 1 — is there an article image at all? Never trusts the stored value
  // alone: an item ingested before images were resolved, or one whose feed
  // carried none, is scraped here exactly as the picker's tab would scrape it.
  let resolved: ResolveSourceImageResult;
  try {
    resolved = await resolveImage(input.postId, attributeToUserId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logFailure(input.postId, "UNEXPECTED_ERROR", message);
    return { status: "failed", code: "UNEXPECTED_ERROR", message };
  }

  if (!resolved.success) {
    logFailure(input.postId, resolved.code);
    return { status: "failed", code: resolved.code };
  }

  // No article, not an article source, or an article with no usable image. By
  // far the commonest answer and never a problem — the AI image stands.
  if (!resolved.sourceImageUrl) return { status: "skipped", reason: "no_source_image" };

  // Step 2 — download, upload, repoint. The AI asset the post is holding right
  // now is what this displaces into `previousMediaAssetId`.
  let result: ApplySourceImageResult;
  try {
    result = await applyImage(input.postId, attributeToUserId, resolved.sourceImageUrl);
  } catch (err) {
    // The pipeline maps download and upload failures to a result code and only
    // throws on genuinely unexpected errors. Swallow those too: an image must
    // never take the post down with it.
    const message = err instanceof Error ? err.message : String(err);
    logFailure(input.postId, "UNEXPECTED_ERROR", message);
    return { status: "failed", code: "UNEXPECTED_ERROR", message };
  }

  if (!result.success) {
    // Step 1 already established there IS an image, so this is a race — the
    // FeedItem was cleared between the two calls. Still not a failure worth
    // shouting about: the post keeps its AI image, which is the right answer.
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
