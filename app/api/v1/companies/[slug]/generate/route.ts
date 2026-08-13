import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { generateTopicAcrossChannels } from "@/lib/services/ai/generate-topic-across-channels.service";
import { parseManualContentSource } from "@/lib/ai/manual-content-source";
import { generationErrorResponse } from "@/lib/http/generation-error-response";
import { BULK_CHANNELS } from "@/lib/queue/bulk-generation-payload";

/**
 * Manual generation of ONE content topic, for one or more channels.
 *
 * ── Why this stayed synchronous ─────────────────────────────────────────────
 *
 * Bulk generation moved to the queue because its work grows with the batch: ten
 * topics on four channels is forty generations, and no function timeout
 * accommodates that. One topic does not grow that way — it is at most four
 * generations, the same order of work this route has always done, so making the
 * user poll for it would be ceremony without a reason. It answers with the posts
 * themselves, as it always has.
 *
 * ── Why the orchestrator, even for one channel ──────────────────────────────
 *
 * `generateTopicAcrossChannels` with a single channel is exactly one
 * `generateDraftPost` call — the anchor path, with no siblings to pin. So there
 * is one code path rather than a special case, and the single-channel behaviour
 * is unchanged by construction rather than by two implementations being kept in
 * step.
 *
 * With several channels it is what makes them one TOPIC rather than three
 * unrelated posts: the first success settles the article and the core message,
 * and every channel after it is pinned to them and writes them in its own voice
 * through its own channel rules. Each is still an independent Post — its own
 * text, image, schedule, and approval.
 */

const bodySchema = z.object({
  /**
   * Every channel to write this topic for.
   *
   * `channel` (singular) is still accepted so a client that has not been updated
   * keeps working unchanged — one channel is simply the ordinary case with one
   * entry, and it produces exactly the post it always did.
   */
  channels: z
    .array(
      z
        .string()
        .transform((v) => v.toLowerCase())
        .pipe(z.enum(BULK_CHANNELS))
    )
    .min(1)
    .max(BULK_CHANNELS.length)
    .optional(),
  channel: z
    .string()
    .transform((v) => v.toLowerCase())
    .pipe(z.enum(BULK_CHANNELS))
    .optional(),
  // Omitted = "Default": let the generator inherit the channel's configured
  // posting language (which itself falls back to the company default). An
  // explicit "en"/"bg" overrides it for this generation only.
  contentLanguage: z.enum(["en", "bg"]).optional(),
  // Manual source-link override (v2-1); omitted = inherit source/channel config.
  includeSourceLink: z.boolean().optional(),
  // Manual image override; omitted = inherit the channel's autoGenerateImage.
  // true forces an image, false suppresses one, for this generation only.
  generateImage: z.boolean().optional(),
  // Explicit per-generation LLM config (v2-5); omitted = env-var default provider.
  llmConfigId: z.string().min(1).optional(),
  // "Content source" choice: a sentinel (company rules / company mission) or a
  // ContentSource id of any type. Omitted = company rules, the long-standing
  // pooled behaviour. The id's KIND is not accepted from the client — the
  // service reads the source's type from the DB (see resolveManualContentSource).
  contentSource: z.string().min(1).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await auth();
  if (!session) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );
  }

  const { slug } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: "INVALID_JSON", message: "Invalid JSON" } },
      { status: 400 }
    );
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          issues: parsed.error.issues,
        },
      },
      { status: 422 }
    );
  }

  // `channels` wins; `channel` is the single-channel spelling of the same thing.
  // Deduped because asking for one topic twice on one channel is refused by the
  // (article, channel) unique index anyway — better normalized here than met as
  // a failure halfway through the group.
  const requested = parsed.data.channels ?? (parsed.data.channel ? [parsed.data.channel] : []);
  const channels = [...new Set(requested)];
  if (channels.length === 0) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Choose at least one channel to generate for.",
        },
      },
      { status: 422 }
    );
  }

  const outcome = await generateTopicAcrossChannels({
    slug,
    userId: session.user.id,
    isGlobalAdmin: session.user.isGlobalAdmin,
    // Minted here rather than by the orchestrator so the id is decided in one
    // place across both flows — bulk mints its groups at enqueue for exactly the
    // same reason.
    contentGroupId: crypto.randomUUID(),
    channels,
    contentLanguage: parsed.data.contentLanguage,
    includeSourceLinkOverride: parsed.data.includeSourceLink,
    autoGenerateImageOverride: parsed.data.generateImage,
    llmConfigId: parsed.data.llmConfigId,
    contentSource: parseManualContentSource(parsed.data.contentSource),
  });

  // Nothing was written at all. Answered with the FIRST channel's own failure,
  // through the same mapper a single generation has always used, so a
  // one-channel request is byte-for-byte the response it was before — and a
  // multi-channel request that failed everywhere reports the reason it failed
  // rather than a new generic error.
  if (outcome.posts.length === 0) {
    const failure = outcome.failures[0];
    return failure
      ? generationErrorResponse(failure)
      : NextResponse.json(
          { error: { code: "NO_CHANNELS_GENERATED", message: "Nothing was generated." } },
          { status: 500 }
        );
  }

  // A partial group is a SUCCESS with an account attached, exactly as a short
  // bulk batch is: the posts that exist are real drafts, and rolling them back
  // because a third channel failed would destroy work to make a number tidy.
  // `post`/`warnings` stay singular for the first channel so an un-updated
  // client keeps reading the response it expects.
  return NextResponse.json(
    {
      post: outcome.posts[0].post,
      warnings: outcome.posts[0].warnings,
      posts: outcome.posts.map((p) => p.post),
      contentGroupId: outcome.contentGroupId,
      failures: outcome.failures.map((f) => ({
        channel: f.channel,
        code: f.code,
        message: f.message,
        reason: f.reason,
        attempts: f.attempts,
      })),
    },
    { status: 201 }
  );
}
