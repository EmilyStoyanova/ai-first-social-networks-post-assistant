import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getTopicGenerationStatus } from "@/lib/services/queue/get-topic-generation-status.service";

// A status poll must never be cached — its whole purpose is to change.
export const dynamic = "force-dynamic";

/**
 * How a queued multi-channel topic generation is getting on.
 *
 * Session-authenticated and company-scoped: the job is looked up by id AND by
 * the company in the path AND by its type, so a job id from another company — or
 * a bulk job id — answers 404 rather than confirming that it exists. The raw
 * queue `payload` is never returned; see `lib/services/queue/job-status.ts`,
 * which is the only place in the app that reads a `jobs` row for a client.
 *
 * The `progress` it carries holds the finished post for every channel that has
 * committed, not just its id. That is what lets the form add a card the moment a
 * channel lands, from the same objects the synchronous route answers with —
 * rather than showing a spinner until the whole topic is done, or issuing a
 * follow-up fetch per channel.
 *
 * A sibling of `generate/bulk/[jobId]`, deliberately at its own path rather than
 * as a shared `generate/[jobId]`: the two read different reports, and a route
 * that guessed which one from the row it found would be one bug away from
 * handing a client a summary its parser cannot read.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string; jobId: string }> }
) {
  const session = await auth();
  if (!session) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );
  }

  const { slug, jobId } = await params;

  const result = await getTopicGenerationStatus(
    slug,
    jobId,
    session.user.id,
    session.user.isGlobalAdmin
  );

  if (!result.success) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "Not found" } },
      { status: 404 }
    );
  }

  return NextResponse.json({ job: result.data });
}
