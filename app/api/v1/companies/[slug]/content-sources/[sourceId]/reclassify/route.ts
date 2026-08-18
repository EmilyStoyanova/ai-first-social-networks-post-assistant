import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requestReclassification } from "@/lib/services/company/reclassify-feed-items.service";

/**
 * Manual "Reclassify articles", for ONE source.
 *
 * Nested under the source rather than the company because that is the scope the
 * button acts on: the control is drawn inside a single source's card, and the
 * count it reports has to be checkable against the list underneath it.
 *
 * Reopens this source's unconsumed RSS articles and enqueues the EXISTING
 * classification drain — the same job type, dedupe key and worker handler every
 * other trigger uses. No LLM call happens here: the response says what was
 * queued, not what was decided.
 */
export async function POST(
  _req: Request,
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

  try {
    const result = await requestReclassification(
      slug,
      sourceId,
      session.user.id,
      session.user.isGlobalAdmin
    );

    if (!result.success) {
      if (result.code === "FORBIDDEN") {
        return NextResponse.json(
          {
            error: {
              code: "FORBIDDEN",
              message: "Only company owners can reclassify articles.",
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
