import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { attachMedia } from "@/lib/services/company/attach-media.service";

const bodySchema = z.object({
  mediaId: z.string().uuid(),
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

  const result = await attachMedia(
    id,
    parsed.data.mediaId,
    session.user.id,
    session.user.isGlobalAdmin
  );

  if (!result.success) {
    switch (result.code) {
      case "NOT_FOUND":
        return NextResponse.json(
          { error: { code: "NOT_FOUND", message: "Post or media asset not found" } },
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
              message: result.message ?? "Image can only be attached to draft posts.",
            },
          },
          { status: 422 }
        );
    }
  }

  return NextResponse.json({ media: result.media }, { status: 200 });
}
