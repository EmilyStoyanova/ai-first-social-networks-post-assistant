import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { bulkGeneratePosts } from "@/lib/services/ai/bulk-generate-posts.service";
import { parseManualContentSource } from "@/lib/ai/manual-content-source";
import { generationErrorResponse } from "@/lib/http/generation-error-response";
import { MAX_BULK_POSTS } from "@/lib/scheduling/bulk-schedule";

// Bulk work must never be cached or statically optimized.
export const dynamic = "force-dynamic";
/**
 * The one route in the app that runs several full generations in a single
 * request, so it is the one that must state its own cap rather than inherit the
 * platform default (60s without Fluid Compute — not enough for two posts).
 *
 * This is the ceiling; the service's own BULK_SOFT_BUDGET_MS (240s) is what
 * actually governs the run, stopping it with a partial result while ~60s of
 * headroom remains to persist nothing further and answer. Requires Fluid Compute
 * to be enabled on the Vercel project, exactly as the cron routes do.
 */
export const maxDuration = 300;

/**
 * Manual bulk generation: N posts, scheduled across a date range.
 *
 * The body is the single-generation body plus the three fields that make it a
 * batch (count + range), and every shared field means exactly what it means
 * there — this route directs the existing pipeline, it does not reinterpret it.
 */
const bodySchema = z.object({
  channel: z
    .string()
    .transform((v) => v.toLowerCase())
    .pipe(z.enum(["facebook", "linkedin", "instagram", "tiktok"])),
  // Bounded because each post is a full generation (LLM + image) inside ONE
  // request; the service enforces the same bound independently.
  numberOfPosts: z.number().int().min(1).max(MAX_BULK_POSTS),
  // Plain calendar days bounding the PERIOD — the posts are scheduled, not
  // timestamped, and a date-time here would only invite a timezone to be lost in
  // transit. The service is also what refuses a start date that has already gone
  // by, since only it knows what "today" is for this company.
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // Optional: the user's own schedule — which days carry how many posts, and the
  // exact business-zone wall clock of every one of them. Omitted means "spread
  // evenly across the channel's posting windows in the period", which is the
  // only mode where the windows decide anything; when this is present the times
  // in it are scheduled verbatim.
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

  const result = await bulkGeneratePosts(slug, session.user.id, session.user.isGlobalAdmin, {
    channel: parsed.data.channel,
    numberOfPosts: parsed.data.numberOfPosts,
    startDate: parsed.data.startDate,
    endDate: parsed.data.endDate,
    customDistribution: parsed.data.distribution,
    contentLanguage: parsed.data.contentLanguage,
    includeSourceLinkOverride: parsed.data.includeSourceLink,
    autoGenerateImageOverride: parsed.data.generateImage,
    llmConfigId: parsed.data.llmConfigId,
    contentSource: parseManualContentSource(parsed.data.contentSource),
  });

  if (!result.success) {
    // The request-shape rejections the service can raise on its own. The schema
    // above already catches the coarse ones for well-behaved clients; the
    // service is the authority, so its answer is honoured rather than assumed.
    if (
      result.code === "INVALID_POST_COUNT" ||
      result.code === "INVALID_DATE_RANGE" ||
      result.code === "START_DATE_IN_PAST" ||
      result.code === "INVALID_DISTRIBUTION"
    ) {
      return NextResponse.json(
        { error: { code: result.code, message: result.message } },
        { status: 422 }
      );
    }

    // Nothing was generated. The failure IS a single generation's failure, so it
    // gets that exact response — same code, same status, same retry hints.
    return generationErrorResponse(result);
  }

  // At least one post exists. A partially filled batch is a success with an
  // honest account attached: `generated` vs `requested`, and why the rest are
  // missing. 201 because posts were created.
  return NextResponse.json({ batch: result.data }, { status: 201 });
}
