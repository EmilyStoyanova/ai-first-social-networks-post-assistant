import crypto from "crypto";
import { requestSignal } from "@/lib/http/request-deadline";

/**
 * The one place that talks to Cloudinary.
 *
 * Signed uploads only — the API secret never leaves the server, and the
 * signature is computed over the same parameter set that is sent. Callers hand
 * over bytes they have already validated and get back the stored asset; who is
 * allowed to upload, and what row is written afterwards, is the caller's
 * business.
 */

export interface CloudinaryAsset {
  publicId: string;
  url: string;
  width: number;
  height: number;
}

export type CloudinaryUploadResult =
  { success: true; asset: CloudinaryAsset } | { success: false; message: string };

/** Ample for a 10 MB upload, and short enough to fail inside a request. */
const UPLOAD_TIMEOUT_MS = 25_000;

export const CLOUDINARY_NOT_CONFIGURED =
  "Image upload is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.";

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

/**
 * Uploads image bytes to `folder` and returns the stored asset.
 *
 * Never throws: every failure — missing configuration, timeout, network error,
 * a non-JSON or error response — comes back as a message the caller can map to
 * its own result code and show to the user.
 */
export async function uploadImageToCloudinary(
  file: Blob,
  folder: string,
  filename?: string
): Promise<CloudinaryUploadResult> {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    return { success: false, message: CLOUDINARY_NOT_CONFIGURED };
  }

  const timestamp = String(Math.floor(Date.now() / 1000));
  const signParams: Record<string, string> = { folder, timestamp };
  const signature = buildSignature(signParams, apiSecret);

  const form = new FormData();
  // A File already carries its name; a bare Blob needs one supplied, or
  // Cloudinary rejects the part.
  if (filename) form.append("file", file, filename);
  else form.append("file", file);
  form.append("api_key", apiKey);
  form.append("timestamp", timestamp);
  form.append("signature", signature);
  form.append("folder", folder);

  let uploadRes: Response;
  try {
    uploadRes = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
      method: "POST",
      body: form,
      signal: requestSignal(UPLOAD_TIMEOUT_MS),
    });
  } catch (err) {
    const isTimeout =
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return {
      success: false,
      message: isTimeout ? "Image upload timed out. Please try again." : "Upload request failed.",
    };
  }

  let data: CloudinaryUploadResponse;
  try {
    data = (await uploadRes.json()) as CloudinaryUploadResponse;
  } catch {
    return { success: false, message: "Invalid response from image service." };
  }

  if (!uploadRes.ok || data.error) {
    return { success: false, message: data.error?.message ?? "Image upload failed." };
  }

  return {
    success: true,
    asset: {
      publicId: data.public_id,
      url: data.secure_url,
      width: data.width,
      height: data.height,
    },
  };
}
