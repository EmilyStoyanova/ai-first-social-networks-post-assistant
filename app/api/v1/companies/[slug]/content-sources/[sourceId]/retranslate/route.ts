import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  requestRetranslation,
  parseIncludeCompletedFromBody,
} from "@/lib/services/company/retranslate-feed-items.service";

/**
 * Optional request body: `{ includeCompleted?: boolean }`.
 *
 * The button posts with no body for its default click, exactly like reclassify, so
 * the body is read defensively rather than assumed present — an empty body, a
 * missing content-type, or genuinely malformed JSON must all fall back to the safe
 * default (`includeCompleted: false`) rather than 400 a request the UI never sends
 * maliciously. Only the try/catch around `req.json()` lives here — the judgement of
 * what a successfully parsed body MEANS is `parseIncludeCompletedFromBody`, kept in
 * the service module so it is unit-testable (see that function's own comment for why
 * a test file cannot live in this directory at all).
 */
async function readIncludeCompleted(req: Request): Promise<boolean> {
  try {
    const body: unknown = await req.json();
    return parseIncludeCompletedFromBody(body);
  } catch {
    return false; // No body, or not JSON — the default click.
  }
}

/**
 * Manual "Retranslate this source", for ONE source.
 *
 * The sibling of the reclassify route beside it, in the same place and the same
 * shape: nested under the source because that is the scope the button acts on, and
 * the count it reports has to be checkable against the list underneath it.
 *
 * Reopens this source's retryable translations and enqueues the EXISTING translation
 * drain — the same job type, dedupe key and worker handler every other trigger uses.
 * No model call happens here: the response says what was queued, not what was
 * translated.
 *
 * `includeCompleted` (optional, in the JSON body) extends that to translations that
 * already SUCCEEDED — see requestRetranslation's own doc for why this is opt-in.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string; sourceId: string }> }
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required." } },
      { status: 401 }
    );
  }

  const { slug, sourceId } = await params;
  const includeCompleted = await readIncludeCompleted(req);

  try {
    const result = await requestRetranslation(
      slug,
      sourceId,
      session.user.id,
      session.user.isGlobalAdmin,
      { includeCompleted }
    );

    if (!result.success) {
      if (result.code === "FORBIDDEN") {
        return NextResponse.json(
          {
            error: {
              code: "FORBIDDEN",
              message: "Only company owners can retranslate articles.",
            },
          },
          { status: 403 }
        );
      }
      // Also the answer for a source belonging to another company — saying
      // "forbidden" there would confirm the id exists.
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: "Source not found." } },
        { status: 404 }
      );
    }

    return NextResponse.json({
      data: {
        reopened: result.reopened,
        enqueued: result.enqueued,
        deduplicated: result.deduplicated,
      },
    });
  } catch {
    return NextResponse.json(
      { error: { code: "INTERNAL_SERVER_ERROR", message: "Unexpected server error." } },
      { status: 500 }
    );
  }
}
