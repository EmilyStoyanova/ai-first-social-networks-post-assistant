import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getBulkGenerationStatus } from "@/lib/services/queue/get-bulk-generation-status.service";

// A status poll must never be cached — its whole purpose is to change.
export const dynamic = "force-dynamic";

/**
 * How a queued bulk generation is getting on.
 *
 * Session-authenticated and company-scoped: the job is looked up by id AND by
 * the company in the path, so a job id from another company answers 404 rather
 * than confirming it exists. The raw queue `payload` is never returned — see the
 * service, which is the only place in the app that reads a `jobs` row for a
 * client.
 *
 * The `progress` it carries is the batch summary itself, written by the run as
 * each topic commits. That is what makes the UI able to show posts arriving
 * instead of a spinner: the same object the synchronous route used to answer
 * with, just delivered in instalments.
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

  const result = await getBulkGenerationStatus(
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
