import crypto from "crypto";
import { prisma } from "@/lib/db/client";

const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export interface UploadedMediaDTO {
  id: string;
  url: string;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
}

export type UploadMediaResult =
  | { success: true; media: UploadedMediaDTO }
  | {
      success: false;
      code:
        | "NOT_FOUND"
        | "FORBIDDEN"
        | "INVALID_FILE"
        | "FILE_TOO_LARGE"
        | "UNSUPPORTED_TYPE"
        | "UPLOAD_FAILED";
      message?: string;
    };

function buildSignature(params: Record<string, string>, secret: string): string {
  const str = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto
    .createHash("sha1")
    .update(str + secret)
    .digest("hex");
}

interface CloudinaryUploadResponse {
  public_id: string;
  secure_url: string;
  width: number;
  height: number;
  error?: { message: string };
}

export async function uploadMedia(
  slug: string,
  userId: string,
  isGlobalAdmin: boolean,
  file: File
): Promise<UploadMediaResult> {
  // Authorization
  let companyId: string;
  if (isGlobalAdmin) {
    const company = await prisma.company.findUnique({ where: { slug }, select: { id: true } });
    if (!company) return { success: false, code: "NOT_FOUND" };
    companyId = company.id;
  } else {
    const membership = await prisma.companyMember.findFirst({
      where: { company: { slug }, userId },
      select: { companyId: true },
    });
    if (!membership) return { success: false, code: "NOT_FOUND" };
    companyId = membership.companyId;
  }

  // Validate size
  if (file.size > MAX_BYTES) {
    return { success: false, code: "FILE_TOO_LARGE", message: "File must be under 10 MB." };
  }

  // Validate type
  const mime = file.type.toLowerCase();
  if (!ALLOWED_MIME_TYPES.has(mime)) {
    return {
      success: false,
      code: "UNSUPPORTED_TYPE",
      message: "Only JPG, PNG, and WebP images are supported.",
    };
  }

  // Validate not empty
  if (file.size === 0) {
    return { success: false, code: "INVALID_FILE", message: "File is empty." };
  }

  // Cloudinary credentials
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    return {
      success: false,
      code: "UPLOAD_FAILED",
      message:
        "Image upload is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.",
    };
  }

  // Build signed upload request
  const timestamp = String(Math.floor(Date.now() / 1000));
  const folder = `companies/${slug}`;
  const signParams: Record<string, string> = { folder, timestamp };
  const signature = buildSignature(signParams, apiSecret);

  const form = new FormData();
  form.append("file", file);
  form.append("api_key", apiKey);
  form.append("timestamp", timestamp);
  form.append("signature", signature);
  form.append("folder", folder);

  let uploadRes: Response;
  try {
    uploadRes = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(25_000),
    });
  } catch (err) {
    const isTimeout =
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return {
      success: false,
      code: "UPLOAD_FAILED",
      message: isTimeout ? "Image upload timed out. Please try again." : "Upload request failed.",
    };
  }

  let data: CloudinaryUploadResponse;
  try {
    data = (await uploadRes.json()) as CloudinaryUploadResponse;
  } catch {
    return {
      success: false,
      code: "UPLOAD_FAILED",
      message: "Invalid response from image service.",
    };
  }

  if (!uploadRes.ok || data.error) {
    return {
      success: false,
      code: "UPLOAD_FAILED",
      message: data.error?.message ?? "Image upload failed.",
    };
  }

  // Persist MediaAsset record
  const asset = await prisma.mediaAsset.create({
    data: {
      companyId,
      cloudinaryId: data.public_id,
      url: data.secure_url,
      thumbnailUrl: null,
      width: data.width,
      height: data.height,
      generatedBy: "user_upload",
      uploadedBy: userId,
    },
    select: { id: true, url: true, thumbnailUrl: true, width: true, height: true },
  });

  return {
    success: true,
    media: {
      id: asset.id,
      url: asset.url,
      thumbnailUrl: asset.thumbnailUrl,
      width: asset.width,
      height: asset.height,
    },
  };
}
