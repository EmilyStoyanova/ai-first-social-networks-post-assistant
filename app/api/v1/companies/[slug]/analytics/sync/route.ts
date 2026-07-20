import { auth } from "@/lib/auth";
import { triggerMetricsSync } from "@/lib/services/analytics/trigger-metrics-sync.service";

interface Context {
  params: Promise<{ slug: string }>;
}

/**
 * Manual "sync now" for post analytics (v2-7).
 *
 * Separate from the internal cron route on purpose: that one is API-key
 * protected and runs the entire pipeline (ingest, generate, PUBLISH). This is
 * session-authenticated, owner-only, and does nothing but read metrics from
 * Buffer — it can never publish.
 */
export async function POST(_req: Request, context: Context) {
  const session = await auth();
  if (!session) {
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required." } },
      { status: 401 }
    );
  }

  const { slug } = await context.params;
  const result = await triggerMetricsSync(slug, session.user.id, session.user.isGlobalAdmin);

  if (!result.success) {
    switch (result.code) {
      case "NOT_FOUND":
        return Response.json(
          { error: { code: "NOT_FOUND", message: "Company not found." } },
          { status: 404 }
        );
      case "FORBIDDEN":
        return Response.json(
          { error: { code: "FORBIDDEN", message: "Only company owners can sync analytics." } },
          { status: 403 }
        );
    }
  }

  // A skipped run is a successful request with nothing done — the reason field
  // tells the UI which of the four causes it was.
  return Response.json({ data: result.data });
}
