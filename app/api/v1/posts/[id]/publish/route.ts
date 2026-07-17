import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { publishPost } from "@/lib/services/buffer/publish-post.service";

const bodySchema = z.object({
  profileId: z.string().min(1),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );
  }

  const { id } = await params;

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

  const result = await publishPost(
    id,
    parsed.data.profileId,
    session.user.id,
    session.user.isGlobalAdmin
  );

  if (!result.success) {
    switch (result.code) {
      case "NOT_FOUND":
        return NextResponse.json(
          { error: { code: "NOT_FOUND", message: "Post not found" } },
          { status: 404 }
        );
      case "FORBIDDEN":
        return NextResponse.json(
          { error: { code: "FORBIDDEN", message: "Forbidden" } },
          { status: 403 }
        );
      case "INVALID_STATUS":
        return NextResponse.json(
          {
            error: {
              code: "INVALID_STATUS",
              message: result.message ?? "Only draft posts can be published.",
            },
          },
          { status: 422 }
        );
      case "NO_CONNECTION":
        return NextResponse.json(
          {
            error: {
              code: "NO_CONNECTION",
              message: "No Buffer account connected. Connect Buffer from the company settings.",
            },
          },
          { status: 422 }
        );
      case "TOKEN_EXPIRED":
        return NextResponse.json(
          {
            error: {
              code: "TOKEN_EXPIRED",
              message: result.message ?? "Buffer token expired. Please reconnect Buffer.",
            },
          },
          { status: 401 }
        );
      case "INVALID_PROFILE":
        return NextResponse.json(
          {
            error: {
              code: "INVALID_PROFILE",
              message: result.message ?? "Invalid Buffer profile.",
            },
          },
          { status: 422 }
        );
      case "BUFFER_API_ERROR":
        return NextResponse.json(
          {
            error: {
              code: "BUFFER_API_ERROR",
              message: result.message ?? "Buffer API error. Please try again.",
            },
          },
          { status: 502 }
        );
      case "POLICY_VIOLATION":
        // 422: the post is well-formed but violates a verified platform
        // constraint. Buffer was never called.
        return NextResponse.json(
          {
            error: {
              code: "POLICY_VIOLATION",
              message: result.message,
              violations: result.violations,
            },
          },
          { status: 422 }
        );
    }
  }

  return NextResponse.json(
    {
      success: true,
      bufferPostId: result.data.bufferPostId,
      status: result.data.status,
      publishedAt: result.data.publishedAt,
      profileId: result.data.profileId,
      publishedPostUrl: result.data.publishedPostUrl,
    },
    { status: 200 }
  );
}
