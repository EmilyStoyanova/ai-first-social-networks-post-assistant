import { prisma } from "@/lib/db/client";
import { uploadImageToCloudinary } from "@/lib/integrations/cloudinary/upload-image";

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

  const uploaded = await uploadImageToCloudinary(file, `companies/${slug}`);
  if (!uploaded.success) {
    return { success: false, code: "UPLOAD_FAILED", message: uploaded.message };
  }

  // Persist MediaAsset record
  const asset = await prisma.mediaAsset.create({
    data: {
      companyId,
      cloudinaryId: uploaded.asset.publicId,
      url: uploaded.asset.url,
      thumbnailUrl: null,
      width: uploaded.asset.width,
      height: uploaded.asset.height,
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
