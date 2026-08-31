import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { enqueueBulkGeneration } from "@/lib/services/queue/enqueue-bulk-generation.service";
import { MAX_BULK_POSTS } from "@/lib/scheduling/bulk-schedule";
import { BULK_CHANNELS } from "@/lib/queue/bulk-generation-payload";

// Queue work must never be cached or statically optimized.
export const dynamic = "force-dynamic";

/**
 * Manual bulk generation: N content TOPICS across the selected channels,
 * scheduled across a date range.
 *
 * ── Why this route enqueues instead of generating ───────────────────────────
 *
 * It used to run the whole batch inline under a 300s `maxDuration`, which fit
 * while a batch meant N posts on ONE channel. Multi-channel changed the
 * arithmetic: a topic written for three channels is three full generations —
 * LLM, image, upload, embedding — so five topics is fifteen, and ten topics on
 * four channels is forty. No function cap accommodates that, and a run killed by
 * the cap is the worst outcome available: the posts it already wrote ARE
 * committed while the caller gets a connection reset and never learns their ids.
 *
 * So the request is validated synchronously — everything that can be answered
 * from the request itself still gets an immediate 422 — and the work is handed
 * to the queue. The response carries the ids the client needs to follow it:
 * `jobId` to poll, `batchId` because every post the run writes is stamped with
 * it, and `contentGroupIds` because those are decided up front so a retry
 * re-opens the same groups rather than splitting a topic in two.
 *
 * 202, not 201: nothing has been created yet.
 */

const bodySchema = z.object({
  /**
   * Every channel each topic is written for.
   *
   * `channels` is the shape; `channel` (singular) is still accepted below so a
   * client that has not been updated keeps working unchanged — a single-channel
   * batch is just the ordinary case with one entry.
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

  // TOPICS, not post rows: this many content groups, each written for every
  // channel above. The service enforces the same bound independently.
  numberOfPosts: z.number().int().min(1).max(MAX_BULK_POSTS),
  // Plain calendar days bounding the PERIOD — the posts are scheduled, not
  // timestamped, and a date-time here would only invite a timezone to be lost in
  // transit. The service is also what refuses a start date that has already gone
  // by, since only it knows what "today" is for this company.
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // Optional: the user's own schedule — which days carry how many posts, and the
  // exact business-zone wall clock of every one of them. Omitted means "spread
  // evenly across each channel's posting windows in the period", which is the
  // only mode where the windows decide anything; when this is present the times
  // in it are scheduled verbatim, and every channel version of a topic inherits
  // the same one.
  //
  // Bounded by MAX_BULK_POSTS days because a distribution needs at least one
  // post per day, so more entries than that could never add up. `times` is
  // shape-checked here only — that it has exactly `count` entries, that each one
  // is a real time of day, that none collide and none are in the past is the
  // service's answer, and the service is the authority.
  distribution: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        count: z.number().int().min(1).max(MAX_BULK_POSTS),
        times: z
          .array(z.string().regex(/^\d{2}:\d{2}$/))
          .min(1)
          .max(MAX_BULK_POSTS),
      })
    )
    .min(1)
    .max(MAX_BULK_POSTS)
    .optional(),

  // Optional: this batch's content mix — how many of its TOPICS each source
  // writes. `null` names the company-content quota (mission posts, no article),
  // mirroring the stored mix's own convention. One topic draws ONE quota however
  // many channels it is written for.
  //
  // Rows carrying no posts are simply left out, which is why every `posts` here
  // is at least 1 — and why at most MAX_BULK_POSTS rows can ever be meaningful,
  // whatever the number of sources the company has. That the counts add up to
  // `numberOfPosts`, that the ids are this company's, and that they are enabled
  // is the service's answer, and the service is the authority.
  sourceMix: z
    .array(
      z.object({
        sourceId: z.string().min(1).nullable(),
        posts: z.number().int().min(1).max(MAX_BULK_POSTS),
      })
    )
    .min(1)
    .max(MAX_BULK_POSTS)
    .optional(),

  // ── Identical to POST /generate ──────────────────────────────────────────
  contentLanguage: z.enum(["en", "bg"]).optional(),
  includeSourceLink: z.boolean().optional(),
  generateImage: z.boolean().optional(),
  llmConfigId: z.string().min(1).optional(),
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
  // Deduped because two identical entries would ask one topic to be written for
  // the same channel twice, which the (article, channel) unique index refuses
  // anyway — better as a normalization here than as a crash in a worker.
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

  const result = await enqueueBulkGeneration(slug, session.user.id, session.user.isGlobalAdmin, {
    channels,
    numberOfPosts: parsed.data.numberOfPosts,
    startDate: parsed.data.startDate,
    endDate: parsed.data.endDate,
    distribution: parsed.data.distribution,
    sourceMix: parsed.data.sourceMix,
    contentLanguage: parsed.data.contentLanguage,
    includeSourceLink: parsed.data.includeSourceLink,
    generateImage: parsed.data.generateImage,
    llmConfigId: parsed.data.llmConfigId,
    contentSource: parsed.data.contentSource,
  });

  if (!result.success) {
    switch (result.code) {
      case "NOT_FOUND":
        return NextResponse.json(
          { error: { code: "NOT_FOUND", message: "Not found" } },
          { status: 404 }
        );
      case "FORBIDDEN":
        return NextResponse.json(
          { error: { code: "FORBIDDEN", message: "Forbidden" } },
          { status: 403 }
        );
      case "INVALID_PAYLOAD":
        return NextResponse.json(
          { error: { code: "VALIDATION_ERROR", message: result.message } },
          { status: 422 }
        );
      // The request-shape rejections, answered synchronously exactly as they
      // were when this route ran the batch inline. Same codes, same status, and
      // no job is created — a request that is wrong now was always going to be.
      case "INVALID_POST_COUNT":
      case "INVALID_DATE_RANGE":
      case "START_DATE_IN_PAST":
      case "INVALID_DISTRIBUTION":
      // An even spread was asked for over a channel with no posting schedule,
      // over a period holding none of its posting days, or over one with fewer
      // publishing slots than posts requested. All three are answerable from the
      // request and the saved configuration alone, so they are answered here
      // rather than becoming a job that schedules nothing.
      case "NO_POSTING_WINDOWS":
      case "NO_POSTING_DAYS_IN_PERIOD":
      case "NO_FUTURE_POSTING_SLOTS":
      case "INSUFFICIENT_POSTING_SLOTS":
      case "INVALID_SOURCE_MIX":
        return NextResponse.json(
          { error: { code: result.code, message: result.message } },
          { status: 422 }
        );
      case "ALREADY_RUNNING":
        // 409, and deliberately not a silent success: this request carries its
        // own instructions, so the run already in flight is not the run that was
        // asked for and the caller has to know that. The running job's id rides
        // along so the client can resume watching it instead of being stuck.
        return NextResponse.json(
          {
            error: { code: "ALREADY_RUNNING", message: result.message, jobId: result.jobId },
          },
          { status: 409 }
        );
    }
  }

  // Accepted, not created. The client follows the run at
  // GET /api/v1/companies/[slug]/generate/bulk/[jobId].
  return NextResponse.json({ job: result.data }, { status: 202 });
}
