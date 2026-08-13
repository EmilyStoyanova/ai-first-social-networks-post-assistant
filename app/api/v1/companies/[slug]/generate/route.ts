import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { generateTopicAcrossChannels } from "@/lib/services/ai/generate-topic-across-channels.service";
import { parseManualContentSource } from "@/lib/ai/manual-content-source";
import { generationErrorResponse } from "@/lib/http/generation-error-response";
import { createRequestDeadline, runInRequestDeadline } from "@/lib/http/request-deadline";
import { BULK_CHANNELS } from "@/lib/queue/bulk-generation-payload";
import { enqueueTopicGeneration } from "@/lib/services/queue/enqueue-topic-generation.service";

// Generation must never be cached or statically optimized.
export const dynamic = "force-dynamic";

/**
 * The function cap, in seconds.
 *
 * Declared because this route's work MULTIPLIED without its budget doing the
 * same. It used to be one generation and inherited the platform default happily;
 * it is now up to four, and two of them already outlast that default. What the
 * platform does about it is answer the browser itself, in plain text — "An error
 * occurred with this application. / FUNCTION_INVOCATION_TIMEOUT" — which is not
 * JSON, which is why the client used to report a JSON parse error for what was
 * really a timeout.
 *
 * 300 matches every other long-running route in this app (the cron pipelines,
 * and the bulk route before it moved to the queue).
 */
export const maxDuration = 300;

/**
 * The inline run's wall-clock budget.
 *
 * Under the cap, not at it: the run has to survive its own deadline in order to
 * REPORT one. 240s leaves ~60s to answer with the post, the same ratio
 * `BULK_SOFT_BUDGET_MS` uses under the same cap.
 *
 * Only ever one channel reaches this now, and the orchestrator never gates its
 * FIRST channel — so this no longer decides whether a channel runs. What it
 * still does is bound every outbound call the generation makes, so one hung LLM
 * or image request cannot sit on the connection until the platform kills it.
 */
const TOPIC_SOFT_BUDGET_MS = 240_000;

/**
 * Manual generation of ONE content topic, for one or more channels.
 *
 * ── One channel inline, several through the queue ───────────────────────────
 *
 * This route used to answer every request inline, and for one channel it still
 * does: that has always fitted comfortably, it is what every existing client
 * expects, and making it poll would be a wire-format change bought with nothing.
 *
 * Two or more channels no longer fit, and the measurement is specific rather
 * than cautious. Against a self-hosted image worker one channel costs about
 * 158s — an LLM call, an image, an upload — so two are ~320s under a 300s cap.
 * The soft budget below could only ever decide which channel to DROP, and
 * dropping was the better of its two outcomes: a channel admitted with less time
 * than it needs still writes its post, because the LLM runs first and takes what
 * is left, and then every image call derives its AbortSignal from a budget of
 * zero and is aborted the instant it is made. That commits a draft with an image
 * prompt and no image, silently, on a channel whose `imageRequired` may make it
 * unpublishable.
 *
 * So a multi-channel request is queued instead, and answered 202 with a job id.
 * Nothing about the generation changes — the worker runs the SAME orchestrator
 * with the same content group, the same anchor-and-pin, the same per-channel
 * failures — it simply runs it where there is no cap to be killed by. The client
 * follows it at GET /api/v1/companies/[slug]/generate/topic/[jobId], and channel
 * versions appear as each one commits.
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

/**
 * An unhandled throw here would leave the route returning no response at all,
 * and the platform would answer the browser in its own words — an HTML or plain
 * text error page. Every client of this API parses JSON, so the guarantee it has
 * to keep is that a body is ALWAYS JSON, including when something unforeseen
 * breaks. The cause still reaches the server log in full.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    return await handlePost(req, ctx);
  } catch (err) {
    console.error("[generate] Unhandled error:", err);
    return NextResponse.json(
      { error: { code: "INTERNAL_SERVER_ERROR", message: "Post generation failed." } },
      { status: 500 }
    );
  }
}

async function handlePost(req: Request, { params }: { params: Promise<{ slug: string }> }) {
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

  // Several channels is more work than a function cap allows — see the docblock.
  // Queued and answered 202, before any generation starts, so the client is
  // never left holding a connection over work that cannot finish on it.
  if (channels.length > 1) {
    const queued = await enqueueTopicGeneration(slug, session.user.id, session.user.isGlobalAdmin, {
      channels,
      contentLanguage: parsed.data.contentLanguage,
      includeSourceLink: parsed.data.includeSourceLink,
      generateImage: parsed.data.generateImage,
      llmConfigId: parsed.data.llmConfigId,
      contentSource: parsed.data.contentSource,
    });

    if (!queued.success) {
      switch (queued.code) {
        case "NOT_FOUND":
          return NextResponse.json(
            { error: { code: "NOT_FOUND", message: "Not found" } },
            { status: 404 }
          );
        case "INVALID_PAYLOAD":
          return NextResponse.json(
            { error: { code: "VALIDATION_ERROR", message: queued.message } },
            { status: 422 }
          );
      }
    }

    // Accepted, not created: nothing has been written when this arrives.
    return NextResponse.json({ job: queued.data }, { status: 202 });
  }

  // Everything below runs under an ambient deadline, so every outbound call the
  // generations make is bounded by the time left in THIS request, and the
  // orchestrator stops before starting a channel it cannot finish. Without it a
  // multi-channel request has no way to find out about the function cap except
  // by hitting it — and being killed at the cap loses posts, because the ones
  // already written are committed and the caller never learns their ids.
  const outcome = await runInRequestDeadline(
    createRequestDeadline(Date.now() + TOPIC_SOFT_BUDGET_MS),
    () =>
      generateTopicAcrossChannels({
        slug,
        userId: session.user.id,
        isGlobalAdmin: session.user.isGlobalAdmin,
        // Minted here rather than by the orchestrator so the id is decided in one
        // place across both flows — bulk mints its groups at enqueue for exactly
        // the same reason.
        contentGroupId: crypto.randomUUID(),
        channels,
        contentLanguage: parsed.data.contentLanguage,
        includeSourceLinkOverride: parsed.data.includeSourceLink,
        autoGenerateImageOverride: parsed.data.generateImage,
        llmConfigId: parsed.data.llmConfigId,
        contentSource: parseManualContentSource(parsed.data.contentSource),
      })
  );

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
      // Channels the deadline left no time for. Reported separately from
      // `failures` because nothing was attempted for them — there is no
      // generator error to show, and asking again is likely to work.
      notAttempted: outcome.notAttempted,
    },
    { status: 201 }
  );
}
