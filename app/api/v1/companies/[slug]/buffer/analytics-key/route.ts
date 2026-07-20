import { auth } from "@/lib/auth";
import {
  setAnalyticsKey,
  deleteAnalyticsKey,
  getAnalyticsKeyStatus,
} from "@/lib/services/analytics/manage-analytics-key.service";

interface Context {
  params: Promise<{ slug: string }>;
}

/**
 * Buffer Personal API Key management (v2-7).
 *
 * The raw key travels in exactly one direction: client -> server, on POST. No
 * response from any method here ever contains it — only `last4`, which is stored
 * in clear precisely so the UI never needs the real value to render.
 */

function unauthorized() {
  return Response.json(
    { error: { code: "UNAUTHORIZED", message: "Authentication required." } },
    { status: 401 }
  );
}

function mapFailure(code: string, message?: string) {
  switch (code) {
    case "NOT_FOUND":
      return Response.json(
        { error: { code: "NOT_FOUND", message: "Company not found." } },
        { status: 404 }
      );
    case "FORBIDDEN":
      return Response.json(
        {
          error: {
            code: "FORBIDDEN",
            message: "Only company owners can manage the analytics key.",
          },
        },
        { status: 403 }
      );
    case "NO_CONNECTION":
      return Response.json({ error: { code, message } }, { status: 409 });
    case "INVALID_KEY":
    case "INSUFFICIENT_SCOPE":
      // 422: the request was well-formed, but Buffer rejected the credential.
      return Response.json({ error: { code, message } }, { status: 422 });
    case "BUFFER_UNAVAILABLE":
      return Response.json({ error: { code, message } }, { status: 503 });
    default:
      return Response.json(
        { error: { code: "INTERNAL_ERROR", message: "Something went wrong." } },
        { status: 500 }
      );
  }
}

export async function GET(_req: Request, context: Context) {
  const session = await auth();
  if (!session) return unauthorized();

  const { slug } = await context.params;
  const result = await getAnalyticsKeyStatus(slug, session.user.id, session.user.isGlobalAdmin);

  if (!result.success) return mapFailure(result.code);
  return Response.json({ data: result.data });
}

export async function POST(req: Request, context: Context) {
  const session = await auth();
  if (!session) return unauthorized();

  const { slug } = await context.params;

  let key: unknown;
  try {
    ({ key } = (await req.json()) as { key?: unknown });
  } catch {
    return Response.json(
      { error: { code: "INVALID_BODY", message: "Expected a JSON body." } },
      { status: 400 }
    );
  }

  if (typeof key !== "string" || key.trim().length === 0) {
    return Response.json(
      { error: { code: "INVALID_BODY", message: "A key is required." } },
      { status: 400 }
    );
  }

  const result = await setAnalyticsKey(slug, key, session.user.id, session.user.isGlobalAdmin);

  if (!result.success)
    return mapFailure(result.code, "message" in result ? result.message : undefined);

  // Response carries last4 and the Buffer organization name only.
  return Response.json({ data: result.data });
}

export async function DELETE(_req: Request, context: Context) {
  const session = await auth();
  if (!session) return unauthorized();

  const { slug } = await context.params;
  const result = await deleteAnalyticsKey(slug, session.user.id, session.user.isGlobalAdmin);

  if (!result.success)
    return mapFailure(result.code, "message" in result ? result.message : undefined);
  return Response.json({ success: true });
}
