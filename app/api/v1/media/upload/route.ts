import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { uploadMedia } from "@/lib/services/media/upload-media.service";

export async function POST(req: Request) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json(
      { error: { code: "INVALID_REQUEST", message: "Expected multipart/form-data." } },
      { status: 400 }
    );
  }

  const slug = formData.get("slug");
  const file = formData.get("file");

  if (typeof slug !== "string" || !slug) {
    return NextResponse.json(
      { error: { code: "VALIDATION_ERROR", message: "slug is required." } },
      { status: 422 }
    );
  }
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: { code: "INVALID_FILE", message: "file is required." } },
      { status: 422 }
    );
  }

  const result = await uploadMedia(slug, session.user.id, session.user.isGlobalAdmin, file);

  if (!result.success) {
    switch (result.code) {
      case "NOT_FOUND":
        return NextResponse.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
      case "FORBIDDEN":
        return NextResponse.json({ error: { code: "FORBIDDEN" } }, { status: 403 });
      case "FILE_TOO_LARGE":
        return NextResponse.json(
          { error: { code: "FILE_TOO_LARGE", message: result.message } },
          { status: 413 }
        );
      case "UNSUPPORTED_TYPE":
        return NextResponse.json(
          { error: { code: "UNSUPPORTED_TYPE", message: result.message } },
          { status: 415 }
        );
      case "INVALID_FILE":
        return NextResponse.json(
          { error: { code: "INVALID_FILE", message: result.message } },
          { status: 422 }
        );
      case "UPLOAD_FAILED":
        return NextResponse.json(
          { error: { code: "UPLOAD_FAILED", message: result.message } },
          { status: 502 }
        );
    }
  }

  return NextResponse.json({ media: result.media }, { status: 201 });
}
