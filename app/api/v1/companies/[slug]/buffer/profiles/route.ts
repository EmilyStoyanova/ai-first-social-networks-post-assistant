import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { listBufferProfiles } from "@/lib/services/buffer/list-buffer-profiles.service";

/** `?channel=FACEBOOK` — the network of the post being published, if narrowing. */
const channelSchema = z.enum(["FACEBOOK", "LINKEDIN", "INSTAGRAM", "TIKTOK"]);

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const session = await auth();
  if (!session) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
      { status: 401 }
    );
  }

  const { slug } = await params;

  const requested = new URL(req.url).searchParams.get("channel");
  const channel = requested === null ? undefined : channelSchema.safeParse(requested.toUpperCase());
  if (channel && !channel.success) {
    return NextResponse.json(
      { error: { code: "INVALID_CHANNEL", message: "Unknown channel" } },
      { status: 422 }
    );
  }

  const result = await listBufferProfiles(slug, session.user.id, session.user.isGlobalAdmin, {
    channel: channel?.data,
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
      case "NO_CONNECTION":
        return NextResponse.json(
          {
            error: {
              code: "NO_CONNECTION",
              message: "No Buffer account connected. Connect Buffer first.",
            },
          },
          { status: 422 }
        );
      case "TOKEN_EXPIRED":
        return NextResponse.json(
          {
            error: {
              code: "TOKEN_EXPIRED",
              message: result.message ?? "Buffer token expired. Please reconnect.",
            },
          },
          { status: 401 }
        );
      case "BUFFER_API_ERROR":
        return NextResponse.json(
          {
            error: {
              code: "BUFFER_API_ERROR",
              message: result.message ?? "Buffer API error",
            },
          },
          { status: 502 }
        );
    }
  }

  return NextResponse.json({ profiles: result.profiles });
}
